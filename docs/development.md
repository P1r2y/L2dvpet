# Development guide

Code structure, a few non-obvious implementation points, and the built-in automated verification.

> This page is a companion chapter to the [README](../README.md).

## Project structure

```
aicomputerpet/
├─ package.json
├─ README.md
├─ LICENSE                        # Source code: MIT
├─ NOTICE.md                      # License scope for the model / art assets / third-party libraries
├─ .editorconfig · .gitattributes · .gitignore
├─ src/                           # All source code
│  ├─ shared/defaults.json        # Defaults for every setting (shared by the main and renderer processes)
│  ├─ main/                       # Main process
│  │  ├─ main.cjs                 # Window, tray, global shortcuts, app:// protocol, IPC
│  │  ├─ preload.cjs              # contextBridge: window.pet
│  │  └─ lib/
│  │     ├─ store.cjs             # JSON config store with debounce + atomic writes
│  │     ├─ llm.cjs               # OpenAI-compatible Chat Completions (SSE streaming)
│  │     ├─ tts.cjs               # TTS dispatch + two-engine auto fallback + pitch compensation
│  │     ├─ gptsovits.cjs         # GPT-SoVITS api_v2 client (local voice cloning)
│  │     ├─ voice-profile.cjs     # Resolves voice, rate and voice profile preset per language/engine
│  │     └─ stt.cjs               # Whisper-compatible speech recognition upload
│  └─ renderer/                   # Renderer process (esbuild bundle)
│     ├─ index.html · styles.css
│     ├─ main.js                  # Startup wiring + petting experience (hearts / lines)
│     ├─ pet.js                   # Model × behavior controller × per-frame parameter writes
│     ├─ core/                    # util / bus
│     ├─ live2d/
│     │  ├─ stage.js              # PIXI + model loading, silhouette measurement, pixel-level hit testing, parameter compositing
│     │  ├─ params.js             # psd2live parameter contract: ranges, ownership, generated motion curves
│     │  ├─ gaze.js               # Gaze following (falloff / drift / microsaccades / smoothing)
│     │  ├─ idle.js               # Blink scheduling + random motions
│     │  └─ emotion.js            # 10 emotions → parameter mapping and blending
│     ├─ features/
│     │  ├─ interaction.js        # Pointer state machine: hit testing / petting / dragging / passthrough
│     │  ├─ voice.js              # Playback + lip sync + recorded-clip recognition
│     │  ├─ chat.js               # Session state, streaming intake, tag parsing
│     │  └─ fx.js                 # Heart effects (only while petting the head)
│     └─ ui/                      # Bubble / chat panel / settings panel / quick bar / menu / toasts
├─ assets/model/                  # A Live2D model you provide yourself (not in the repo, see .gitignore)
├─ vendor/                        # Third-party runtime libraries: live2dcubismcore.min.js (downloaded from the official CDN)
├─ dist/                          # Build output (renderer.js + copied pixi / live2d libraries + tray icon)
├─ docs/                          # Documentation and reference assets
│  ├─ voice.md                    # TTS engines, GPT-SoVITS integration, pitch compensation
│  ├─ chat-and-settings.md        # Chat endpoint, emotion tags, settings panel and parameter locking
│  ├─ faq.md                      # Troubleshooting by symptom
│  ├─ development.md              # This page: code structure, implementation notes, offscreen selftest
│  ├─ optimization-notes.md       # Not published yet
│  ├─ screenshots/                # UI screenshots referenced by the README
│  └─ (source/ and voice-demo/ are local asset directories, not in the repo)
└─ scripts/
   ├─ build.mjs                   # esbuild bundling + tray icon generation
   └─ tools/                      # Diagnostic scripts (unrelated to the runtime, run manually when needed)
      ├─ mock-api.cjs             # Local OpenAI-compatible mock service
      ├─ check-gptsovits.cjs      # GPT-SoVITS integration self-check
      ├─ inspect-model-params.cjs # Prints a model's motion curves / durations / parameter ranges
      ├─ audit-settings.cjs       # Lists the consumer of every settings field, flagging the ones with none
      └─ test-voice.cjs / test-stt.cjs
```

---

---

## Implementation notes (for whoever changes the code next)

**Why is the window full-screen and transparent?**
The pet, the bubble, the chat panel and the settings panel all live in the same full-screen transparent window,
which stays "click-through by default, interactive on demand" through `setIgnoreMouseEvents(true, {forward:true})`.
`features/interaction.js` decides every frame whether the mouse is on her (GPU pixel hit) or on a real UI element
(`document.elementFromPoint`), and switches the window to interactive only when it is.
The main process runs a 4-second heartbeat watchdog: if the renderer ever hangs, it restores click-through by itself,
so the desktop can never get locked.

**When parameters are written**
Cubism's update order is
`motion → saveParameters → expression → eyeBlink → focus → breath → physics → [beforeModelUpdate] → model.update() → loadParameters()`.
All custom parameters are written inside the `beforeModelUpdate` hook, so they always override what motions and blinks produced;
`loadParameters()` then restores them at the end of every frame, which makes writing parameters **once per frame** both correct and necessary.
(It also means a parameter read after `model.update()` only ever returns the motion value — the selftest therefore reads
them back from inside the hook.)

**Silhouette measurement**
A Live2D canvas is usually far larger than the character (this model is a 1024² canvas and the character fills only about 1/3 of it).
At startup the GPU framebuffer is read once to compute the real alpha bounding box; the bubble, the quick bar and the gaze origin
are all anchored to that "silhouette" afterwards, so they hug her instead of drifting into a corner of the canvas.

**Hit testing**
After every render (`postrender`) a 1×1 `gl.readPixels` is taken at the mouse position to get the real alpha,
so the gaps between hair, arms and legs are judged correctly too.

**Rebuild after changes**: `npm run build` (changing only main-process code under `src/main/` needs no build — just restart).

---

---

## For developers: automated verification

A built-in unattended selftest launches a real Electron instance, injects real mouse events, takes screenshots and asserts on model parameters:

```bash
# Basic selftest: screenshots + gaze + petting
node_modules\.bin\electron.cmd . --selftest

# Full selftest: additionally verifies chat streaming, TTS lip sync, speech recognition
node scripts/tools/mock-api.cjs 8787          # start the mock API in another terminal
node_modules\.bin\electron.cmd . --selftest --selftest-api=http://127.0.0.1:8787/v1
```

Sample output:

```
[selftest] GAZE PASS — ΔeyeBallX=0.500 (-0.134→0.366), ΔAngleX=3.15°, ΔBodyAngleX=-0.61°
[selftest] LIPSYNC PASS — peak ParamMouthOpenY = 0.962, pet mouth = 0.962, audio level = 0.999, 69 samples
[selftest] STT(upload) PASS — {"ok":true,"text":"This is the mock transcription, used to verify the voice-input pipeline.","provider":"openai-compatible"}
[selftest] STT(mic)    PASS — {"ok":true,"text":"This is the mock transcription, used to verify the voice-input pipeline."}
[selftest] lock PASS — preset 1→1.5, found=true, held while locked=true, applied after unlock=true
[selftest] motion nod -> PASS range [-18.41, 5.64] swing 24.1°  curve AngleY 0→−18→+6 (24° total)
[selftest] motion shake -> PASS range [-19.55, 20.33] swing 39.9°  curve AngleX 0→−20→+20 (40° total)
[selftest] idle curves PASS — breath 0.00~1.00 (idle curve 0↔1), head sway -1.98~2.00° (idle curve ±2°)
[selftest] PITCH PASS — source durations 4.14/5.14/6.6s grow with pitch=true, playbackRate=true, preservesPitch=false=true
```

Screenshots are written to `scripts/selftest-*.png`.

> `--selftest-api=<url>` also works on its own — any argument starting with `--selftest` enters selftest mode;
> only `--selftest` / `--selftest=<path>` changes where screenshots are saved.

**About the jitter**: `motion shake` occasionally reports FAIL. It samples the range of `ParamAngleX` within a 2-second motion,
but the motion file does not set `Meta.FadeInTime`, so Cubism applies a 1-second fade-in, and peaks that land inside the
first 1 second of the clip get smoothed away — with a slightly off sampling window the excursion jumps anywhere between 13° and 40°.
**Run it once more** — if it comes back above 35°, it was a one-off.

Individual diagnostics:

```bash
node scripts/tools/inspect-model-params.cjs assets/model/<your model>   # verify motion curves and parameter ranges
node scripts/tools/audit-settings.cjs                        # settings audit: the consumer of every field
node scripts/tools/check-gptsovits.cjs                       # checks the GPT-SoVITS service and model files
node scripts/tools/test-voice.cjs   # engine availability, pitch-compensation math, fallback chain
node scripts/tools/test-stt.cjs     # multipart upload format (Node and Electron runtimes)
node scripts/tools/mock-api.cjs     # local OpenAI-compatible mock service
```

`--selftest` mode mounts `window.__petTest` in the renderer (settings, chat, speech, parameter read-back and so on);
it does not exist on a normal launch and does not affect ordinary use.

---
