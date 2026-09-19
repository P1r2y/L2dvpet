# NOTICE — 授权范围说明

本仓库采用**分层授权**：MIT（见 `LICENSE`）**只覆盖源代码**，不覆盖下列素材。
下列内容各有其权利人，使用前请自行确认并遵守其条款。

---

## 1. Live2D 模型与美术素材 —— 不在 MIT 授权范围内

| 路径 | 内容 | 权利人 |
| --- | --- | --- |
| `assets/model/roxy/` | Live2D 模型（`moc3` / `cmo3` / 贴图 / `motion3.json` / 工程文件） | 原始角色美术的权利人 |
| `docs/source/` | 模型原图（由源 PSD 导出） | 原始画师 |
| `docs/screenshots/` `docs/voice-demo/` | 界面截图与合成语音示例 | 同左 / 合成结果 |

- 该模型由 **psd2live** 自 PSD 自动生成，本项目作者**不持有**角色原画与角色形象的著作权。
- 角色 **洛琪希·米格路迪亚（Roxy Migurdia）** 出自《无职转生》，
  其角色形象权利归**原作者、出版社及动画制作委员会**所有。
- 本仓库**不包含任何动画原声素材**；`docs/voice-demo/` 中的语音由 TTS 合成。
- 若权利人提出异议，相关素材将被移除。

## 2. Live2D Cubism Core 运行时

| 路径 | 内容 |
| --- | --- |
| `vendor/live2dcubismcore.min.js` | Live2D Cubism Core 5 |
| `dist/vendor/live2dcubismcore.min.js` | 构建时拷贝的同一文件 |

© Live2D Inc.，适用
[Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)。
**该文件可再分发，但不受本仓库 MIT 许可约束。**

## 3. 第三方依赖（各自遵循其原始许可）

| 依赖 | 许可 |
| --- | --- |
| [PixiJS 6](https://pixijs.com/) | MIT |
| [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) | MIT |
| [Electron](https://www.electronjs.org/) | MIT |

## 4. 本仓库作者原创部分

以下内容由本项目作者编写，适用根目录 `LICENSE` 的 MIT 许可：

- `src/` —— 全部源代码（主进程 / 渲染进程 / 共享配置）
- `scripts/` —— 构建与诊断脚本
- `docs/` 下的文档文字（`README.md`、`docs/优化建议.md`）

---

## 附：参考音频说明

GPT-SoVITS 声线所用的参考音频不在本仓库内，位于本地 GPT-SoVITS 安装目录的 `refs/` 下，
取自 HuggingFace 公开仓库
[`Anexdeus/Roxy_Migurdia_coqui_XTTS`](https://huggingface.co/Anexdeus/Roxy_Migurdia_coqui_XTTS)，
其授权请以该仓库声明为准。
