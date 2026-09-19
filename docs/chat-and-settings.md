# Chat and settings

Chat API configuration, the emotion tag protocol, and how the settings panel is organized.

> This page is an extended section of the [README](../README.md).

## Configuring the chat API

Open **Settings → Chat**. The persona is a generic desktop-pet personality — change it to suit yourself.

1. **API address**: pick a provider from the dropdown (or choose "Custom…" and type one in). Any service compatible with `POST /chat/completions` works.
2. **API Key**: enter your key. It is **stored on this machine only**, in `%APPDATA%\ai-computer-pet\settings.json`, and is never sent to any third party.
3. **Model name**: click "Fetch model list" to pull the list automatically, then pick from the dropdown.
4. Click **"Test connection"** to confirm it works.

Common configuration examples:

| Service | API address | Model |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Moonshot AI | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` |
| Qwen (DashScope) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama (local) | `http://localhost:11434/v1` | `qwen2.5:7b` |
| LM Studio (local) | `http://localhost:1234/v1` | whatever model is loaded locally |

---

### Emotion tags

The system prompt asks the model to put one emotion tag at the very front of its reply, for example `[happy]`, `[shy]`, `[think]`:

```
[happy]Of course I remember! We were just talking a moment ago~
```

`happy / smile / sad / angry / surprised / shy / think / love / sleepy / neutral` are supported
(along with synonyms such as `joy`, `excited`, `embarrassed`).
You can also use `[motion:nod]` / `[motion:shake]` to make her nod or shake her head.

These tags are **parsed as they arrive** during streaming — the expression changes the moment a tag lands, while the body text keeps streaming.
Tags never show up in the bubble. If the model won't behave, you can turn off "parse emotion tags" in the settings.

---

---

## Settings panel

The panel is **VS Code style**: title bar + search box at the top, a category tree on the left, settings on the right, a status bar at the bottom.
Every item shows its own key name in settings.json (monospace font), modified items carry a blue marker bar on the left,
and the search box searches across categories by name or key name.

---

### Parameter locking

Each settings row has an 🔓 button on its right; click it and it turns into 🔒:

- **Locked items can't be edited** — the control is greyed out, preventing accidental changes;
- **Locked items are not overwritten by timbre presets** — lock the API Key, pitch, volume, etc., then switch presets without worry;
- Locking works for a whole group (locking `voice`, for example, locks every item under it);
- Locked items are listed on the **Settings → Locks** page, where you can unlock them all in one click.

Measured by the automated test (`--selftest`):

```
[selftest] lock PASS — preset 1→1.5, found=true, held while locked=true, applied after unlock=true
```

> **Implementation note**: `locks` uses **whole-value replacement** semantics in the config store; it does not go through deep merge.
> Deep merge can only add or override keys, never delete them, so if "unlock" went through merge it could never remove an existing lock — a pit we fell into,
> and it is handled explicitly in `src/main/lib/store.cjs` with `REPLACE_KEYS`.

---

## Settings items

| Category | Groups |
| --- | --- |
| **Display** | Window, Model, Appearance |
| **Gaze** | Follow, Naturalness |
| **Motion** | Blink, Breathing & physics, Random motion |
| **Petting** | Interaction, Lines |
| **Chat** | API, Generation parameters, Persona |
| **Voice** | Engine, Language, Timbre, GPT-SoVITS, Online TTS API, Lip sync, Voice input |
| **Model parameters** | Overview, Face, Eyes, Eyebrows, Mouth, Body, Physics (18 parameters) |
| **Locks** | Locked items |
| **About** | Version, Usage, Launch at login, Developer tools |

All changes take effect immediately and are written to `%APPDATA%\ai-computer-pet\settings.json`;
the panel position and the chat window position are stored in `state.json` in the same directory.
