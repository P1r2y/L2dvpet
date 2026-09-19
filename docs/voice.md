# Voice and timbre

Read-aloud engine selection and configuration, automatic timbre switching by language, and how a timbre is tuned.

> This page is an extension chapter of the [README](../README.md).

## Where voices come from

**The repository ships no voice assets** — models, reference audio and voice presets all have to be provided by you.
There are two paths to a voice, and both run against a local GPT-SoVITS service:

| Approach | Requires | Result | Notes |
| --- | --- | --- | --- |
| **Reference audio** (zero-shot clone) | A 5~10 second clean voice clip + a word-for-word transcript | Close, but not the original speaker | Base model is enough, usable at once |
| **Resident model** (fine-tuned weights) | A matched pair of fine-tuned GPT + SoVITS weights | **Closest to the original** | Needs ready-made weights |

### Voice presets

Settings → Voice → **Engine → Voice presets**: one click applies a whole set of settings (engine, read-aloud language, pitch…) at once.

The preset table is read from `src/shared/voice-presets.json` — **this file is not distributed with the repository**.
Write one following the `_comment` at the top of it and put it at the same path. When the file is missing this
section is empty and nothing else is affected (`npm run build` also builds fine without it, bundling an empty list).

---

### Reference audio: zero-shot cloning (usable at once)

The GPT-SoVITS base model needs only **a 5~10 second clean voice clip** to clone a similar timbre.

1. Put the audio (`.wav` / `.mp3`, no BGM, no overlapping voices) into
   `GPT-SoVITS-v2pro-20250604\refs\`
2. Settings → Voice → GPT-SoVITS → click "Auto-detect", and the reference audio path is filled in for you
3. **Fill in "Reference audio text"** — the exact sentence spoken in that audio, word for word; get it wrong and the timbre drifts

The program pairs them automatically by the convention "a same-named `.txt` is the transcript":

```
my-voice.wav
my-voice.txt    ← the exact sentence spoken in the wav, word for word
```

The language is inferred from the transcript's character set (kana present → Japanese, mostly Chinese characters → Chinese). When the audio has no same-named `.txt`,
the scan result says so, and the transcript has to be filled in by hand.

> If your audio comes without a transcript, you can transcribe it with the faster-whisper bundled in the integrated package
> (measured 0.99 confidence on Japanese), write the result into the same-named `.txt`, and the program reads it on startup.

### Resident model: switch to fine-tuned weights (best result)

Put the trained weights into the matching directories:

| File | Goes into |
| --- | --- |
| `*.ckpt` | `GPT-SoVITS-v2pro-20250604\GPT_weights_v2ProPlus\` |
| `*.pth` | `GPT-SoVITS-v2pro-20250604\SoVITS_weights_v2ProPlus\` |

Click "Auto-detect" once more and the program finds the fine-tuned weights, switches **Reference mode** to
**Resident model** and prefers them. The reference audio and transcript **are kept** — measured: in weights mode
without reference audio, the server returns HTTP 500, so do not clear these two fields by hand.

### Manual control

Settings → Voice → GPT-SoVITS lets you adjust each item one by one:

| Item | Effect |
| --- | --- |
| **Run automatically when the pet starts** | On by default; turn it off and it starts only when you click "Start now" |
| **Start now** | Starts the service by hand, and shows the current status |
| **Reference mode** | "Reference audio" (zero-shot clone) / "Resident model" (fine-tuned weights) |
| **Synthesis language** | Japanese / Chinese / mixed Chinese-English …; must match what you want her to say |
| **Reference audio text** | The word-for-word transcript of the reference audio |

The service itself is an independent process — **closing the pet does not exit it** (the next start reuses it directly, saving a 30-second load).
If you don't want it staying resident, end `python.exe` in Task Manager.

---

### Installing GPT-SoVITS

If you don't have it, get the integrated package from the official repository: <https://github.com/RVC-Boss/GPT-SoVITS>

Below, `<GPT-SoVITS root>` stands for your own install directory; the integrated package unpacks to something like:

```
<GPT-SoVITS root>\GPT-SoVITS-v2pro-20250604\
```

Reference configuration (official integrated package v2Pro / 20250604):

| Item | Value |
| --- | --- |
| Bundled runtime | Python 3.9.13 — **no separate Python install needed** |
| Inference framework | torch 2.0.0+cu118, **CUDA available** |
| Pretrained models | All bundled with the package (including `v2ProPlus`) |
| What to change | The `custom` section of `tts_infer.yaml`, pointed at **v2ProPlus + cuda + half** |

#### How to start it

The service needs **an independent resident process** (it stops when you close the window); pick either:

```powershell
# Start the API only (all the pet needs)
powershell -ExecutionPolicy Bypass -File "<GPT-SoVITS root>\GPT-SoVITS-v2pro-20250604\start-gptsovits-api.ps1"

# Or start the full WebUI (training/inference UI, also opens the API)
double-click go-webui.bat in the install directory
```

A successful start is marked by seeing `Uvicorn running on http://127.0.0.1:9880`.

#### Starting along with the pet

Settings → Voice → GPT-SoVITS → **"Run automatically when the pet starts"** (on by default).

The startup sequence is **lazy and unobtrusive**: the pet shows its UI first, and only 2.5 seconds later checks port 9880.

- **Port already open** → do nothing (a `go-webui.bat` you started by hand is never taken over)
- **Port closed** → start `api_v2.py` with the package's own `runtime\python.exe`, then poll the port until it is ready
- **No install directory** → one line in the log only; no dialog, no blocking

Measured cold start:

```
[gptsovits] ...\runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c ...\tts_infer.yaml
result: {"ok":true,"started":true,"message":"GPT-SoVITS started (127.0.0.1:9880)"}  elapsed 27.2s
```

v2ProPlus loads about 340 MB of weights, so **the first start takes about 30 seconds**; after that it stays on standby in the
background, and closing the pet does not exit it (it is an independent process, and the next start reuses it directly).

The "Start now" button in the settings panel goes down the same path, and is there to confirm the service status by hand.

> Self-test (`--selftest`) **never** starts it, and never creates a tray icon or registers global shortcuts —
> the self-test runs under offscreen rendering, so no window ever appears on your desktop.

#### Connecting it to the pet

Settings → Voice → **GPT-SoVITS** → click **"Auto-detect"**.
It finds the install directory, fills in the weights and reference audio paths (switching to the resident model when fine-tuned weights exist),
and moves GPT-SoVITS to the front of the fallback chain (as long as it is running, it takes priority over the online TTS API).

Measured (`--selftest --selftest-gsv`):

```
[selftest] GPT-SoVITS PASS — provider=gptsovits, duration=2.98s, elapsed=1.29s
```

#### Inference speed

On an RTX 3060 Ti, a 3-second sentence generates in about 1.3 seconds (once the model is warm) — faster than real time.
The first synthesis is slower (the weights have to load).

> **Known server-side defect**: a character with no GBK encoding in the text (`・`, `♪`, emoji, etc.)
> fails the whole request. The program replaces those characters with spaces before sending the request; see the [FAQ](faq.md).

---

### Speech engine comparison

Settings → Voice → **Speech engine**, default **"Auto"**: it tries
**GPT-SoVITS → online TTS API** in order, and
**an engine it cannot reach is skipped for 30 minutes** (increasing backoff, see the [FAQ](faq.md)).
The panel shows each engine's status live.

| Engine | Quality | Offline | Voice options | Notes |
| --- | --- | --- | --- | --- |
| **Auto** | — | — | — | Recommended: try local cloning first, switch online if it is unreachable |
| **GPT-SoVITS (local voice cloning)** | ★★★★★ | ✓ | Depends on the model and reference audio | Zero-shot clone from reference audio, or fine-tuned weights |
| **Online TTS API** | ★★★★★ | ✗ | 10 built-in voices | Any OpenAI-compatible `/audio/speech` |
| **No read-aloud** | — | — | — | Text only |

---

### Multilingual: automatic timbre switching by content

Settings → Voice → **Language → Read-aloud language**: **Auto-detect** (kana → Japanese, Hangul → Korean,
mostly Chinese characters → Chinese, mostly Latin → English) or a fixed language. Each language has **its own set of timbre settings**.

Language detection measured 8/8 (Chinese / Japanese / English / Korean / Russian, all correct).

**Engines are also filtered by language**: if no available engine supports the current language, the program first tries every engine that does support it;
only when all of them fail does it fall back, and it **says so in an explicit dialog** rather than quietly reading Japanese with a Chinese accent.

---

### How pitch is implemented

None of the engines offers usable pitch control (measured: the SSML `pitch` parameter of Windows SAPI is ignored entirely —
files synthesized from three different pitch values are exactly the same size in bytes, and this conclusion holds for the two engines that remain today).
So the approach is the one a voice changer uses:

1. make the engine synthesize **slowed down**; 2. speed it back up on playback with `playbackRate`, and set `preservesPitch = false`.

The result is **an unchanged speech rate with only the pitch moved**. Measured:

```
pitch 0.85 -> source 5.44s × rate 0.85 = final 6.40s
pitch 1.00 -> source 6.77s × rate 1.00 = final 6.77s
pitch 1.15 -> source 7.57s × rate 1.15 = final 6.58s
pitch 1.35 -> source 9.40s × rate 1.35 = final 6.97s
=> source duration grows monotonically with pitch ✅; speech-rate deviation after compensation 8.3% ✅
```
