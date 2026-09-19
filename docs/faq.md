# FAQ

Troubleshoot by symptom; most problems can be fixed right in the settings panel.

> This page is an extended section of the [README](../README.md).

## Common questions

**Q: The voice engine is reported unavailable and gets skipped automatically?**
A: The fallback chain has only two entries — **local GPT-SoVITS → online TTS API**.
An engine that can't be reached is skipped and remembered for 30 minutes (increasing backoff, see below).
- GPT-SoVITS unreachable → see the next question;
- Online TTS API unreachable → check the address and key under **Settings → Voice → Online TTS API**, and whether the network can reach that service.

To recover: once the service is confirmed available, click **Settings → Voice → Retry failed engines**.
Use `node scripts/tools/test-voice.cjs` to see the full engine picture and the pitch compensation result.

**Q: GPT-SoVITS produces no sound?**
A: Check three things in order:

1. Is the service running — run `node scripts/tools/check-gptsovits.cjs`, or check whether port 9880 is listening;
2. Is the "install directory" under Settings → Voice → GPT-SoVITS empty? If it is, click "Auto-detect";
3. If you use "reference audio" mode, **the reference audio text must match, word for word, what the audio actually says** — a mismatch garbles the timbre or even throws an error.

**Q: Do "・" or emoji in Japanese make a whole line silent?**
A: This is a GPT-SoVITS server-side problem, not this program's — on Windows it treats text as **GBK**,
and any character **without a GBK encoding** makes the entire request fail outright (the server reports `'gbk' codec can't encode character …`),
regardless of language. The characters measured as affected include `・` (U+30FB, the interpunct inside `ロキシー・ミグルディア` / Roxy Migurdia),
`♪ ♥ ✓ ©`, `〜` (U+301C) and every emoji; while `★ → ① ℃ …`, which do have GBK encodings, all work fine.

The program replaces such characters with spaces **before sending them to the service** (this affects synthesis only; what the chat bubble shows is kept as-is),
so normally you don't need to think about it.

**Q: The voice dropdown is empty / selecting one does nothing?**
A: Two different cases — don't mix them up:
- **"Online TTS API → Voice" is a built-in list** — OpenAI's `/audio/speech` (and most compatible implementations)
  has no endpoint that lists voices, so the program ships 10 common voice names (nova / shimmer / coral / sage / alloy /
  ballad / echo / fable / onyx / ash). If the service you connect to uses other voice names, choose "Custom" and type one in.
- **"GPT-SoVITS" has no voice list** — its timbre is decided by the **reference audio** (zero-shot cloning)
  or by **fine-tuned weights**; see [Voice](voice.md).

**Q: I switched voices but it sounds about the same?**
A: Within one engine the difference between voices is limited. For an obvious change in how she sounds, move the **Timbre tuning → Pitch (timbre)** slider
(1.22 girlish, 0.85 deep), or switch to the "online TTS API" and pick among the 10 built-in voices.

**Q: She gets in the way of my work / I can't click things on the desktop?**
A: Normally she becomes click-through as soon as the mouse moves off her. If something does go wrong, right-click the tray icon → tick "mouse click-through (clicks pass through the pet)" to force it,
or just "Quit".

**Q: The model doesn't show up?**
A: First bring the window to the foreground and look at the status overlay in the bottom-left corner (Settings → UI → Show status info).
Also check whether `model.path` in `%APPDATA%\ai-computer-pet\settings.json` points to a file that exists.
If the GPU doesn't support WebGL 2, try lowering the frame rate to 30 in the settings.

**Q: It uses too many resources?**
A: Settings → Display → Render frame rate → set it to 30 FPS; turn off "physics"; make "overall size" smaller.
Rendering pauses automatically while the window is hidden.

**Q: She keeps repeating the same line / doesn't remember what we talked about?**
A: Settings → Chat → raise "memory turns" (default 20); you can also add more to the "system prompt".

---

---

### How voice fallback works

The fallback chain has only two entries: **local GPT-SoVITS → online TTS API**.
An engine that can't be reached is skipped and remembered for a while; the panel shows each engine's status and the reason for its most recent failure.

`synthesizeWithFallback` first puts engines that "support the current language" at the front.
For GPT-SoVITS the capability check is based on **the model itself**, not on the currently selected reading language:

```
zh-CN  gptsovits supports -> true
ja-JP  gptsovits supports -> true
en-US  gptsovits supports -> true
ko-KR  gptsovits supports -> true
ru-RU  gptsovits supports -> false   (the model really can't)
```

> Why this is worth writing down: the reference audio's language (`prompt_lang`) and the reading language (`text_lang`)
> are **two independent parameters** in GPT-SoVITS, and v2ProPlus is multilingual too,
> so the capability belongs to **the model**, not to the currently selected `text_lang`.
> Early versions took `textLang` as the capability basis, which misjudged a Chinese-capable GPT-SoVITS as "unsupported" and pushed it to the end of the chain,
> so another engine ended up reading the line — fixed.

**Reading language** is chosen automatically from **the text's actual language** (Chinese→`zh`, Japanese→`ja`…);
the configured value is used only when the user has pinned the language manually. Otherwise Chinese lines get read by the Japanese G2P.

#### Second culprit: one failure = locked out for 30 minutes (fixed)

GPT-SoVITS occasionally returns **HTTP 500** (an internal server error, tied to the specific text, intermittent).
The old policy was **any single failure cools down for 30 minutes, and is persisted into `state.json`**:

```json
"voiceFailures": { "gptsovits": 1789824892460 }
```

Restarting the pet didn't clear it either — an intermittent error lasting a few seconds turned into half an hour without Roxy's voice.

Now it is **increasing backoff + automatic retry**:

| Consecutive failures | Cooldown |
| --- | --- |
| 1 | **20 seconds** |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 or more | 30 minutes |

And every failure first **retries once automatically** (400ms apart) before it counts as a failure.

#### Bonus: failure reasons are now recorded

Previously only a timestamp was stored, so afterwards there was no way to find out why. Now `{ at, count, error }` is stored:

```json
"gptsovits": { "at": 1789825392500, "count": 1,
               "error": "GPT-SoVITS /tts failed HTTP 500: Internal Server Error" }
```

The engine status under Settings → Voice shows this reason, and can clear it in one click.

#### One more latent race (fixed)

The startup line was read **0.9 seconds** in, while GPT-SoVITS needs **about 30 seconds** to load weights on a cold start.
On first launch the greeting was bound to land on the backup engine. Now the greeting **waits for the service to be ready** (up to 45 seconds) before speaking.

#### If it happens again

1. Settings → Voice → click "Clear fallback records" to recover immediately
2. The engine status shows the specific error; if it is `HTTP 500`, that's an intermittent server-side error — just retry
3. If nothing else works, restart the pet (the service is a separate process, unaffected, so there is no 30-second reload)

---
