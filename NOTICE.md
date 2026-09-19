# NOTICE — statement of license scope

This repository uses the **MIT license** (see `LICENSE`), which covers everything in the repository —
the repository contains **only the program itself**: source code, build scripts and documentation. It
contains no Live2D models, art assets, voice assets or content for any specific character.

---

## 1. The repository contains no third-party assets

The following content appeared in early versions; it has **been removed from the repository and added to
`.gitignore`**, so a clone will not contain it:

| Path | Content | Rights holder |
| --- | --- | --- |
| `assets/model/` | Live2D model (`moc3` / `cmo3` / textures / `motion3.json` / project files) | Rights holders of the original character art |
| `docs/source/` | Model source images (exported from the source PSD) | The original illustrator |
| `docs/voice-demo/` | Synthesized voice samples | The synthesized output |
| `src/shared/voice-presets.json` | One-click voice presets (a local file; when missing, the program treats it as an empty list) | The project author |

**If you prepare your own assets, confirm the licensing yourself.** Rights to character designs belong to
the original authors, publishers, animation production committees and other rights holders; the project
author holds no copyright in any third-party model, character artwork or voice. Do not commit assets you
have no right to distribute to this repository.

## 2. Live2D Cubism Core runtime

| Path | Content |
| --- | --- |
| `vendor/live2dcubismcore.min.js` | Live2D Cubism Core 5 |
| `dist/vendor/live2dcubismcore.min.js` | The same file copied at build time |

© Live2D Inc., under the
[Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html).
**This file may be redistributed, but it is not covered by this repository's MIT license.**

## 3. Third-party dependencies (each under its own original license)

| Dependency | License |
| --- | --- |
| [PixiJS 6](https://pixijs.com/) | MIT |
| [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) | MIT |
| [Electron](https://www.electronjs.org/) | MIT |
| [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) (optional, external program) | MIT |

## 4. Original work by this repository's author

The following content was written by the project author and is under the MIT license in the root `LICENSE`:

- `src/` — all source code (main process / renderer process / shared configuration)
- `scripts/` — build and diagnostic scripts
- documentation text under `docs/` (`README.md`, `docs/optimization-notes.md`)
