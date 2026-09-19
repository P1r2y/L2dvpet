# NOTICE — 授权范围说明

本仓库采用 **MIT 许可**（见 `LICENSE`），覆盖仓库内的全部内容 ——
仓库里**只有程序本身**：源代码、构建脚本与文档，不含任何 Live2D 模型、美术素材、
语音素材或特定角色的内容。

---

## 1. 仓库不含第三方素材

下列内容曾经出现在早期版本里，现在**已从仓库移除并加入 `.gitignore`**，
克隆下来不会得到它们：

| 路径 | 内容 | 权利人 |
| --- | --- | --- |
| `assets/model/` | Live2D 模型（`moc3` / `cmo3` / 贴图 / `motion3.json` / 工程文件） | 原始角色美术的权利人 |
| `docs/source/` | 模型原图（由源 PSD 导出） | 原始画师 |
| `docs/voice-demo/` | 合成语音示例 | 合成结果 |
| `src/shared/voice-presets.json` | 一键声线预设（本地文件，缺失时程序按空列表处理） | 本项目作者 |

**自己准备素材时请自行确认授权。** 角色形象的权利归原作者、出版社及动画制作委员会等
权利人所有；本项目作者不持有任何第三方模型、角色原画或音色的著作权。
请不要把你没有权利分发的素材提交到本仓库。

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
| [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)（可选，外部程序） | MIT |

## 4. 本仓库作者原创部分

以下内容由本项目作者编写，适用根目录 `LICENSE` 的 MIT 许可：

- `src/` —— 全部源代码（主进程 / 渲染进程 / 共享配置）
- `scripts/` —— 构建与诊断脚本
- `docs/` 下的文档文字（`README.md`、`docs/优化建议.md`）
