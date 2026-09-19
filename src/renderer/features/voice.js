/**
 * VoiceService — text-to-speech playback with real-time lip-sync, plus
 * microphone recording and speech-to-text.
 *
 * Audio from the main process (Edge TTS / OpenAI TTS) is played through an
 * <audio> element routed into Web Audio so an AnalyserNode can drive
 * ParamMouthOpenY from the actual waveform. The offline `webspeech` provider
 * cannot be routed through Web Audio, so a synthetic envelope is used instead.
 */
import { bus } from '../core/bus.js'
import { clamp, cleanForSpeech } from '../core/util.js'

const bridge = window.pet

export class VoiceService {
  constructor({ pet, getSettings, getState, patchState }) {
    this.pet = pet
    this.getSettings = getSettings
    this.getState = getState || (() => ({}))
    this.patchState = patchState || (() => {})
    /**
     * When a cloud TTS engine is unreachable (blocked network, bad key), stop
     * retrying it on every sentence: remember the failure and speak with the
     * offline engine until the cooldown expires or the user re-tests it.
     */
    this.FALLBACK_COOLDOWN_MS = 30 * 60 * 1000
    this.audio = null
    this.audioCtx = null
    this.sourceNode = null
    this.analyser = null
    this.gainNode = null
    this.timeData = null
    this._raf = null
    this._active = null // 'audio' | 'webspeech' | null
    this._speechUtterance = null
    this._speechEnvelope = { t: 0, value: 0, nextAt: 0, target: 0 }
    this._objectUrl = null
    this.queue = []
    this._speaking = false
    /**
     * Playback generation. Every start bumps it; stale `ended`/`error` events
     * from a superseded <audio> load are ignored so they cannot tear down a
     * newer playback (which would silently break lip-sync).
     */
    this._playGen = 0
    this._speakReq = 0
    this._onEnded = null
    this._onError = null
    /** Languages we already warned about having no dedicated voice for. */
    this._warnedLangMismatch = {}
    /**
     * Decaying peak used by the mouth normaliser. Synthesised speech rarely
     * drives the analyser anywhere near full scale, so the level is normalised
     * against its own recent peak to use the whole ParamMouthOpenY travel.
     */
    this._peak = 0
    /** Smoothed mouth envelope (fast attack, slow release). */
    this._mouthSmooth = 0
    /** Rolling diagnostics — surfaced in the settings panel and self-tests. */
    this.debug = {
      ctxState: 'none',
      plays: 0,
      lastError: '',
      maxRms: 0,
      maxLevel: 0,
      currentTime: 0,
      duration: 0,
      lipSyncFrames: 0,
      playbackRate: 1,
      preservesPitch: true,
      srcDuration: 0,
      provider: '',
    }

    // recording
    this.mediaRecorder = null
    this.mediaStream = null
    this.chunks = []
    this.recording = false
    this._recTimer = null
    this._micAnalyser = null
    this._micData = null
  }

  /* ---------------------------------------------------------------- *
   * Audio graph
   * ---------------------------------------------------------------- */
  _ensureAudio() {
    if (this.audio) return
    const audio = new Audio()
    audio.preload = 'auto'
    // NOTE: no crossOrigin — blob: URLs are same-origin and setting it can
    // make createMediaElementSource output silence.
    this.audio = audio

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      this.audioCtx = new Ctx()
      this.sourceNode = this.audioCtx.createMediaElementSource(audio)
      this.analyser = this.audioCtx.createAnalyser()
      this.analyser.fftSize = 1024
      this.analyser.smoothingTimeConstant = 0.55
      this.gainNode = this.audioCtx.createGain()
      this.sourceNode.connect(this.analyser)
      this.analyser.connect(this.gainNode)
      this.gainNode.connect(this.audioCtx.destination)
      this.timeData = new Uint8Array(this.analyser.fftSize)
    } catch (err) {
      console.warn('[voice] Web Audio unavailable, lip-sync disabled:', err.message)
      this.analyser = null
    }
  }

  setVolume(v) {
    const vol = clamp(Number(v) ?? 0.9, 0, 1)
    if (this.gainNode) this.gainNode.gain.value = vol
    if (this.audio) this.audio.volume = vol
  }

  /* ---------------------------------------------------------------- *
   * Speaking
   * ---------------------------------------------------------------- */
  /**
   * @param {string} text
   * @param {{ force?: boolean, emotion?: string }} [opts]
   */
  async speak(text, opts = {}) {
    const s = this.getSettings()
    const v = s?.voice || {}
    if (!v.ttsEnabled && !opts.force) return false

    const clean = cleanForSpeech(text)
    if (!clean) return false

    // Synthesis is async; tag this request so a slower earlier one cannot
    // start playing over a newer one.
    const req = ++this._speakReq
    this.stop()
    this.setVolume(v.volume)

    const configured = opts.provider || v.ttsProvider || 'auto'
    bus.emit('voice:state', { state: 'synthesizing', provider: configured })

    let result
    try {
      result = await bridge.tts.speak({ text: clean, provider: opts.provider })
    } catch (err) {
      if (req !== this._speakReq) return false
      bus.emit('voice:error', { message: `语音合成失败: ${err.message}` })
      return false
    }
    if (req !== this._speakReq) return false // superseded while synthesizing

    if (!result || result.kind === 'none') return false

    if (result.kind === 'error') {
      bus.emit('voice:error', { message: result.message || '所有语音引擎都不可用' })
      bus.emit('voice:all-failed', { message: result.message })
      return false
    }

    // The main process degrades through edge → voicevox → openai → sapi →
    // webspeech on its own; tell the user when they did not get what they picked.
    if (result.fellBack) {
      const names = {
        edge: 'Edge TTS',
        openai: '在线 TTS',
        sapi: '系统语音',
        webspeech: '浏览器语音',
        voicevox: 'VOICEVOX',
      }
      bus.emit('voice:fallback', {
        from: result.requested,
        to: result.provider,
        label: `${names[result.requested] || result.requested} 不可用，已改用${names[result.provider] || result.provider}`,
      })
    }
    if (result.languageMismatch && !this._warnedLangMismatch[result.lang]) {
      this._warnedLangMismatch[result.lang] = true
      bus.emit('voice:lang-mismatch', { lang: result.lang, provider: result.provider })
    }

    if (result.kind === 'webspeech') {
      this.debug.provider = 'webspeech'
      return this._speakWebSpeech(result.text, {
        voice: result.voice,
        rate: result.rate,
        pitch: result.pitch,
        volume: result.volume ?? v.volume,
      })
    }

    this.debug.provider = result.provider || ''
    return this._playBase64(result.base64, result.mime, result.playbackRate)
  }

  async _playBase64(base64, mime, playbackRate = 1) {
    this._ensureAudio()
    if (!this.audio) return false

    if (this.audioCtx?.state === 'suspended') {
      try {
        await this.audioCtx.resume()
        console.info('[voice] resumed suspended AudioContext')
      } catch (err) {
        console.warn('[voice] AudioContext.resume failed:', err.message)
      }
    }

    const gen = ++this._playGen
    this._detachAudioListeners()
    this._onEnded = () => {
      if (gen === this._playGen) this._onAudioDone()
    }
    this._onError = () => {
      if (gen !== this._playGen) return
      console.warn('[voice] audio playback error')
      this._onAudioDone()
    }
    this.audio.addEventListener('ended', this._onEnded)
    this.audio.addEventListener('error', this._onError)

    try {
      if (this._objectUrl) URL.revokeObjectURL(this._objectUrl)
      const bytes = base64ToBytes(base64)
      const blob = new Blob([bytes], { type: mime || 'audio/mpeg' })
      this._objectUrl = URL.createObjectURL(blob)
      this.audio.src = this._objectUrl
      this.audio.volume = clamp(Number(this.getSettings()?.voice?.volume ?? 0.9), 0, 1)
      // Pose the voice: the engine rendered a slower take, playing it back at
      // `playbackRate` restores the duration while shifting the pitch.
      // `preservesPitch = false` is what makes the pitch actually move.
      const rate = clamp(Number(playbackRate) || 1, 0.5, 2)
      this.audio.preservesPitch = false
      if ('webkitPreservesPitch' in this.audio) this.audio.webkitPreservesPitch = false
      this.audio.playbackRate = rate
      this.debug.playbackRate = rate
      this.debug.preservesPitch = this.audio.preservesPitch
      this.debug.srcDuration = this.audio.duration || 0
      this._active = 'audio'
      this._setSpeaking(true)
      this.debug.plays++
      this.debug.maxRms = 0
      this.debug.maxLevel = 0
      this._peak = 0
      this._mouthSmooth = 0
      this.debug.lipSyncFrames = 0
      this.debug.lastError = ''
      this.debug.ctxState = this.audioCtx?.state || 'none'
      await this.audio.play()
      if (gen !== this._playGen) return false // superseded while loading
      this._startLipSync()
      return true
    } catch (err) {
      if (gen !== this._playGen) return false
      this.debug.lastError = String(err?.message || err)
      bus.emit('voice:error', { message: `播放失败: ${err.message}` })
      this._setSpeaking(false)
      this._active = null
      return false
    }
  }

  _detachAudioListeners() {
    if (!this.audio) return
    if (this._onEnded) this.audio.removeEventListener('ended', this._onEnded)
    if (this._onError) this.audio.removeEventListener('error', this._onError)
    this._onEnded = null
    this._onError = null
  }

  /* ---------------------------------------------------------------- *
   * Cloud-engine failure memory
   *
   * The fallback chain itself lives in the main process (see tts.cjs
   * `synthesizeWithFallback`), which records failures into state.json.
   * These helpers only read/clear that record for the settings panel.
   * ---------------------------------------------------------------- */
  _failureMap() {
    return this.getState()?.voiceFailures || {}
  }

  _inFallbackCooldown(provider) {
    const at = this._failureMap()[provider]
    return !!at && Date.now() - at < this.FALLBACK_COOLDOWN_MS
  }

  /** Clears the cooldown so the next utterance retries the cloud engine. */
  clearFailure(provider) {
    const map = { ...this._failureMap() }
    if (provider) delete map[provider]
    else for (const k of Object.keys(map)) delete map[k]
    this.patchState({ voiceFailures: map })
    console.info('[voice] cleared fallback record:', provider || 'all')
  }

  isInFallback(provider) {
    return this._inFallbackCooldown(provider || this.getSettings()?.voice?.ttsProvider)
  }

  /** Live engine status (available / cooling down) for the settings panel. */
  async engineStatus() {
    try {
      return await bridge.tts.status()
    } catch {
      return null
    }
  }

  _speakWebSpeech(text, cfg = {}) {
    if (!('speechSynthesis' in window)) {
      bus.emit('voice:error', { message: '当前环境不支持系统语音，请改用 Edge TTS 或在线 TTS' })
      return false
    }
    const v = this.getSettings()?.voice || {}
    const u = new SpeechSynthesisUtterance(text)
    u.rate = clamp(Number(cfg.rate ?? v.webSpeechRate ?? 1), 0.1, 10)
    u.pitch = clamp(Number(cfg.pitch ?? v.webSpeechPitch ?? 1.1), 0, 2)
    u.volume = clamp(Number(cfg.volume ?? v.volume ?? 0.9), 0, 1)

    const wanted = cfg.voice || v.webSpeechVoice
    if (wanted) {
      const match = speechSynthesis.getVoices().find((x) => x.voiceURI === wanted || x.name === wanted)
      if (match) {
        u.voice = match
        u.lang = match.lang
      }
    }
    if (!u.voice) {
      const zh = speechSynthesis.getVoices().find((x) => /^zh/i.test(x.lang))
      if (zh) {
        u.voice = zh
        u.lang = zh.lang
      }
    }

    u.onstart = () => {
      this._active = 'webspeech'
      this._setSpeaking(true)
      this._speechEnvelope = { t: 0, value: 0, nextAt: 0, target: 0 }
      this._startLipSync()
    }
    const finish = () => {
      this._setSpeaking(false)
      this._active = null
      this._stopLipSync()
      this.pet.setMouthLevel(0)
    }
    u.onend = finish
    u.onerror = (e) => {
      if (e.error !== 'interrupted' && e.error !== 'canceled') {
        bus.emit('voice:error', { message: `系统语音出错: ${e.error}` })
      }
      finish()
    }
    this._speechUtterance = u
    try {
      speechSynthesis.cancel()
      speechSynthesis.speak(u)
      return true
    } catch (err) {
      bus.emit('voice:error', { message: `系统语音启动失败: ${err.message}` })
      return false
    }
  }

  _onAudioDone() {
    this._setSpeaking(false)
    this._active = null
    this._stopLipSync()
    this.pet.setMouthLevel(0)
  }

  _setSpeaking(on) {
    const changed = this._speaking !== on
    this._speaking = on
    // Always mirror onto the pet: an early return here used to leave the pet
    // muted-stuck whenever two playbacks overlapped.
    this.pet.setSpeaking(on)
    if (changed) bus.emit('voice:state', { state: on ? 'speaking' : 'idle' })
  }

  stop() {
    this._playGen++ // invalidate any in-flight playback's event handlers
    this._detachAudioListeners()
    if (this.audio) {
      try {
        this.audio.pause()
        this.audio.currentTime = 0
      } catch {
        /* ignore */
      }
    }
    if ('speechSynthesis' in window) {
      try {
        speechSynthesis.cancel()
      } catch {
        /* ignore */
      }
    }
    this._stopLipSync()
    this._setSpeaking(false)
    this._active = null
    this.pet.setMouthLevel(0)
  }

  get speaking() {
    return this._speaking
  }

  /* ---------------------------------------------------------------- *
   * Lip-sync drivers
   * ---------------------------------------------------------------- */
  _startLipSync() {
    if (this._raf) return
    const loop = () => {
      this._raf = requestAnimationFrame(loop)
      const v = this.getSettings()?.voice || {}
      if (v.lipSync === false) {
        this.pet.setMouthLevel(0)
        return
      }
      const gain = clamp(Number(v.lipSyncGain) ?? 1.6, 0.1, 6)

      if (this._active === 'audio' && this.analyser && this.timeData) {
        this.analyser.getByteTimeDomainData(this.timeData)
        let sum = 0
        for (let i = 0; i < this.timeData.length; i++) {
          const x = (this.timeData[i] - 128) / 128
          sum += x * x
        }
        const rms = Math.sqrt(sum / this.timeData.length)
        // Soft noise gate, then a mild curve so quiet syllables still move.
        const gated = rms < 0.012 ? 0 : rms - 0.012
        let level = clamp(Math.pow(gated * gain, 0.75) * 2.1, 0, 1)

        /*
         * Peak-following normaliser. Synthesised speech rarely drives the
         * analyser anywhere near full scale, so without this the mouth only ever
         * opened to ~60% even on the loudest syllable — which is exactly why it
         * looked like she had no mouth. Track a slowly decaying peak and
         * normalise against it, so the loudest recent audio maps to 1.0 and the
         * full parameter travel is actually used.
         */
        this._peak = Math.max(level, this._peak * 0.994, 0.22)
        level = clamp(level / this._peak, 0, 1)
        // Snap small residuals shut so a closed mouth really closes.
        if (level < 0.06) level = 0

        /*
         * Fast attack / slow release. Normalising against the peak yields a
         * sharp spike followed by a decay, which reads as a pop on screen;
         * mouth animation wants syllables to open quickly and close gently.
         */
        const attack = level > this._mouthSmooth ? 0.6 : 0.22
        this._mouthSmooth += (level - this._mouthSmooth) * attack
        level = this._mouthSmooth

        this.pet.setMouthLevel(level)

        const d = this.debug
        d.lipSyncFrames++
        if (rms > d.maxRms) d.maxRms = rms
        if (level > d.maxLevel) d.maxLevel = level
        d.currentTime = this.audio?.currentTime || 0
        d.duration = this.audio?.duration || 0
        d.ctxState = this.audioCtx?.state || 'none'
      } else if (this._active === 'webspeech') {
        this.pet.setMouthLevel(this._envelopeStep())
      }
    }
    this._raf = requestAnimationFrame(loop)
  }

  /** Synthetic mouth envelope for engines we cannot tap (speechSynthesis). */
  _envelopeStep() {
    const e = this._speechEnvelope
    e.t += 1 / 60
    if (e.t >= e.nextAt) {
      e.nextAt = e.t + 0.055 + Math.random() * 0.09
      e.target = Math.random() < 0.18 ? 0.06 : 0.35 + Math.random() * 0.55
    }
    e.value += (e.target - e.value) * 0.45
    // Pause at punctuation-ish moments to look less mechanical.
    const pause = Math.sin(e.t * 1.7) > 0.985 ? 0.25 : 1
    return clamp(e.value * pause, 0, 1)
  }

  _stopLipSync() {
    if (this._raf) cancelAnimationFrame(this._raf)
    this._raf = null
  }

  /* ---------------------------------------------------------------- *
   * Speech recognition
   * ---------------------------------------------------------------- */
  get canRecord() {
    return !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'
  }

  async startRecording() {
    if (this.recording) return true
    if (!this.canRecord) {
      bus.emit('stt:error', { message: '当前环境不支持录音' })
      return false
    }
    const maxSec = clamp(Number(this.getSettings()?.voice?.sttMaxSeconds) || 30, 3, 300)

    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      bus.emit('stt:error', { message: `无法访问麦克风: ${err.message}` })
      return false
    }

    this.mediaStream = stream
    this.chunks = []
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', ''].find(
      (m) => m === '' || (window.MediaRecorder && MediaRecorder.isTypeSupported(m))
    )
    let rec
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    } catch {
      rec = new MediaRecorder(stream)
    }
    this.mediaRecorder = rec
    this.recordMime = rec.mimeType || 'audio/webm'

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data)
    }
    rec.onerror = (e) => bus.emit('stt:error', { message: `录音出错: ${e.error?.name || 'unknown'}` })

    rec.start(250)
    this.recording = true
    this._startMicMeter(stream)
    bus.emit('stt:state', { state: 'recording', maxSeconds: maxSec })

    this._recTimer = setTimeout(() => {
      if (this.recording) this.stopRecording({ auto: true })
    }, maxSec * 1000)
    return true
  }

  /**
   * Speaks, but first gives a cold GPT-SoVITS service a chance to finish
   * loading. Without this the first line of a session always landed on the
   * fallback voice: the service needs ~30 s to load its weights, while the
   * startup greeting fires under a second after launch.
   */
  async speakWhenReady(text, maxWaitMs = 45000) {
    const v = this.getSettings()?.voice
    if (v?.gptsovits?.autoStart === false) return this.speak(text)
    const st = await window.pet.tts.gptsovitsStatus().catch(() => null)
    if (st?.running) return this.speak(text)

    await new Promise((resolve) => {
      let done = false
      const offs = []
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        for (const off of offs) {
          try {
            off?.()
          } catch {
            /* ignore */
          }
        }
        resolve()
      }
      const timer = setTimeout(finish, maxWaitMs)
      offs.push(window.pet.tts.onGptsovitsReady(finish))
      offs.push(window.pet.tts.onGptsovitsError(finish))
    })
    return this.speak(text)
  }

  /** Live input level, exposed for the UI's volume meter. */
  _startMicMeter(stream) {
    try {
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      const src = this.audioCtx.createMediaStreamSource(stream)
      const an = this.audioCtx.createAnalyser()
      an.fftSize = 512
      src.connect(an)
      this._micAnalyser = an
      this._micData = new Uint8Array(an.fftSize)
      const tick = () => {
        if (!this.recording || !this._micAnalyser) return
        this._micAnalyser.getByteTimeDomainData(this._micData)
        let sum = 0
        for (let i = 0; i < this._micData.length; i++) {
          const x = (this._micData[i] - 128) / 128
          sum += x * x
        }
        const rms = Math.sqrt(sum / this._micData.length)
        bus.emit('stt:level', { level: clamp(rms * 6, 0, 1) })
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    } catch {
      /* meter is optional */
    }
  }

  /**
   * Stops recording and (unless cancelled) transcribes the audio.
   * @returns {Promise<string|null>}
   */
  async stopRecording({ auto = false, cancel = false } = {}) {
    if (!this.recording) return null
    this.recording = false
    if (this._recTimer) {
      clearTimeout(this._recTimer)
      this._recTimer = null
    }
    const rec = this.mediaRecorder
    const stream = this.mediaStream
    this._micAnalyser = null

    const blob = await new Promise((resolve) => {
      if (!rec || rec.state === 'inactive') return resolve(null)
      rec.onstop = () => resolve(new Blob(this.chunks, { type: this.recordMime || 'audio/webm' }))
      try {
        rec.stop()
      } catch {
        resolve(null)
      }
    })

    stream?.getTracks().forEach((t) => t.stop())
    this.mediaStream = null
    this.mediaRecorder = null

    if (cancel || !blob || blob.size < 1200) {
      bus.emit('stt:state', { state: 'idle' })
      if (!cancel && auto) bus.emit('stt:error', { message: '没有录到声音' })
      return null
    }

    bus.emit('stt:state', { state: 'transcribing' })
    const base64 = await blobToBase64(blob)
    const v = this.getSettings()?.voice || {}
    const res = await bridge.stt.transcribe({
      base64,
      mime: blob.type || 'audio/webm',
      language: v.sttLanguage,
    })

    bus.emit('stt:state', { state: 'idle' })
    if (!res || !res.ok) {
      bus.emit('stt:error', { message: res?.message || '语音识别失败' })
      return null
    }
    bus.emit('stt:result', { text: res.text })
    return res.text
  }

  async toggleRecording() {
    if (this.recording) return this.stopRecording()
    return this.startRecording()
  }

  /* ---------------------------------------------------------------- */
  /** Voice list for the settings panel (system voices are read locally). */
  static systemVoices() {
    if (!('speechSynthesis' in window)) return []
    return speechSynthesis.getVoices().map((v) => ({
      id: v.voiceURI,
      name: `${v.name} · ${v.lang}`,
      locale: v.lang,
    }))
  }

  static async waitForSystemVoices(timeoutMs = 1500) {
    if (!('speechSynthesis' in window)) return []
    if (speechSynthesis.getVoices().length) return VoiceService.systemVoices()
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(VoiceService.systemVoices()), timeoutMs)
      speechSynthesis.addEventListener(
        'voiceschanged',
        () => {
          clearTimeout(t)
          resolve(VoiceService.systemVoices())
        },
        { once: true }
      )
      // Chromium sometimes needs a nudge before it populates the list.
      speechSynthesis.getVoices()
    })
  }
}

/* ---------------------------------------------------------------- *
 * Small binary helpers
 * ---------------------------------------------------------------- */
function base64ToBytes(base64) {
  const bin = atob(base64)
  const len = bin.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
