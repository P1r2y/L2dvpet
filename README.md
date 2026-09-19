# 洛琪希 · Live2D 桌面精灵

一个跑在 Windows 桌面上的 Live2D 桌宠。她是**洛琪希·米格路迪亚**（《无职转生》），
会用眼睛跟着你的鼠标，可以被摸头，能陪你聊天（接任意 OpenAI 兼容接口），
会开口说话（**中日英多语言自动切换 + 一键声线预设**），还有一个能调所有参数的设置面板。

模型：`assets/model/roxy/seethrough_skirt_split`（Live2D Cubism 5，moc3 v5，4096² 贴图 —— 正好也是蓝发，和米格路德族很搭）

![桌面效果](docs/screenshots/screenshot-desktop.png)

> **关于声线**：洛琪希的官方声优是[小原好美](https://cho-animedia.jp/article/2021/01/10/22043.html)。
> 本程序**不含任何动画原声素材**，而是用 TTS 引擎 + 音调整形去接近她的听感：
> 柔和的年轻女声、略高的音调、从容的语速。详见 [洛琪希声线怎么配](#洛琪希声线怎么配)。

---

## 功能一览

| 需求 | 实现 | 验证方式 |
| --- | --- | --- |
| **1. 视线小幅度跟随鼠标** | 眼球 `ParamEyeBallX/Y` + 头部 `ParamAngleX/Y/Z` + 身体 `ParamBodyAngleX/Y`，带距离衰减、自然漂移与微眼跳，全部幅度可调 | 自动化测试实测：鼠标从屏幕最左移到右侧，`ParamEyeBallX` 由 **−0.135 → +0.334**（Δ0.468），`ParamAngleX` 变化 **2.95°** |
| **2. 对话框 + 接 API** | 独立对话面板，流式输出，OpenAI 兼容接口（DeepSeek / OpenAI / 月之暗面 / 智谱 / 硅基流动 / 通义 / Ollama / LM Studio …），**人设已完全按洛琪希重写**，带情绪标签、历史记忆 | 用内置模拟接口跑通全流程，流式增量、情绪标签 `[smile]` 解析正确 |
| **3. 鼠标移到模型上按下抚摸** | 基于 GPU 像素级 alpha 命中检测（贴合真实轮廓，不是矩形框），按住左键即抚摸：**摸头时冒爱心**、眯眼、**洛琪希专属台词** | 自动化测试用真实鼠标事件按住并来回抚摸，情绪切换为 `happy`，好感度正常增长 |
| **3b. 动作参数与 psd2live 对齐** | 参数范围改为**从 moc3 实时读取**（`ParamAngleX` 实测 ±45°，非 Cubism 默认的 ±30）；视线改为**叠加**而非覆盖，动作曲线不再被抹平；眨眼改到 physics 之前写入，**果冻眼**复活 | 点头摆幅 **23.7°**（曲线 24°）、摇头摆幅 **39.0°**（曲线 40°）、待机呼吸 **0.00~1.00**（曲线 0↔1）、待机头部摇摆 **±2°**（曲线 ±2°）、果冻眼 **[-0.96, 1.00]** |
| **4. 接入语音** | **朗读**：GPT-SoVITS（洛琪希专用微调模型）/ Edge TTS / VOICEVOX / Windows 系统语音 / 在线 TTS / 浏览器语音，六引擎自动降级；**按语言自动切换音色**；Web Audio 分析真实波形驱动口型。**输入**：麦克风录音 → Whisper 兼容接口识别 | 口型 `ParamMouthOpenY` 峰值 **0.53~0.75**；真实麦克风录音识别通过；音调 0.85/1.00/1.15/1.35 四档源时长单调增长而最终时长稳定在 6.4–7.0 秒（偏差 8.3%）；语言识别 8/8 |
| **5. 设置面板** | **VS Code 风格**：分类树 + 搜索 + 键名显示 + 修改标记；参数**支持锁定**（锁定后不可编辑、也不被预设覆盖） | ![设置面板](docs/screenshots/screenshot-settings.png) |
| **7. 洛琪希音色开箱即用** | 内置洛琪希参考音频 + 逐字文稿，零样本克隆；首次启动自动配置、自动起服务，无需任何手动步骤 | `[selftest] GPT-SoVITS PASS — promptLang=ja` |
| **7a. GPT-SoVITS 自动启动** | 启动桌宠时自动拉起语音服务；端口已开则复用，不会抢占手动启动的实例。实测冷启动 27 秒 | `[gptsovits] 已启动（127.0.0.1:9880）` |
| **7b. 参数种类与 psd2live 一致** | 设置 → **模型参数**：6 组 / 18 个参数，与 `cdi3.json` 一一对应。自动模式可设**上下限**并显示**实时曲线**；也可切「偏移 / 固定」 | `[selftest] 参数上下限 PASS` + `模型参数 PASS 18/18` |
| **6b. 口型张开度** | 加入峰值跟随归一化，合成语音的开口度用满整个行程（0.60 → 0.97） | `[selftest] LIPSYNC PASS — peak 0.970` |
| **6. 去除好感度** | 好感度系统已完全移除；特效**只在摸头时冒爱心**，无任何数值展示 | 抚摸测试中头部按压出现爱心，界面无 HUD |

---

## 快速开始

```bash
git clone https://github.com/P1r2y/L2dvpet.git
cd L2dvpet

npm install        # 首次安装依赖（Electron + PixiJS + Live2D 库）
npm start          # 构建前端并启动桌宠
```

启动后小汐会出现在屏幕右下角，并跟你打招呼。

> 只想重新打包前端资源（不启动）：`npm run build`
> 直接启动（跳过构建）：`npm run app`

### 环境要求
- Windows 10 / 11
- Node.js ≥ 18（本项目在 Node 24 + Electron 38 上开发验证）
- 支持 WebGL 2 的显卡（实测 RTX 3060 Ti + ANGLE/D3D11 正常）

---

## 操作方式

| 操作 | 效果 |
| --- | --- |
| **按住左键在她身上移动** | **抚摸** —— 摸到头部时冒爱心、眯眼、随机台词 |
| **按住右键拖动**（或 `Alt` + 左键拖动） | **移动**桌宠位置（松开自动保存） |
| **右键单击** | 弹出菜单：聊天 / 语音输入 / 让她点头摇头 / 语音开关 / 鼠标穿透 / 设置 / 隐藏 / 退出 |
| **鼠标移到她身上** | 右侧浮出快捷按钮条（💬 聊天、🎤 说话、🔊 语音、⚙️ 设置、👁 隐藏） |
| `Esc` | 取消当前抚摸或拖动；再按一次关闭面板 |

### 全局快捷键

| 快捷键 | 效果 |
| --- | --- |
| `Ctrl+Shift+H` | 显示 / 隐藏桌宠（隐藏后从托盘图标唤回） |
| `Ctrl+Shift+C` | 打开 / 关闭对话 |
| `Ctrl+Shift+S` | 打开 / 关闭设置 |
| `Ctrl+Shift+Space` | 语音输入（可在设置 → 语音 中修改或清空） |

界面内快捷键（焦点不在输入框时）：`C` 对话、`S` 设置、`M` 麦克风、`H` 隐藏。

> **鼠标穿透**：窗口默认是"智能穿透"——鼠标不在她身上、也不在面板上时，点击会正常穿透到桌面，
> 所以桌宠不会挡住你操作其他软件。若担心出问题，随时可以从托盘菜单退出。

---

## 洛琪希声线怎么配

设置 → 语音 → **引擎 → 声线预设**，点一下即可：

| 预设 | 用什么 | 说明 |
| --- | --- | --- |
| **洛琪希 · GPT-SoVITS 原声模型** | 社区微调的洛琪希专用模型 | **最还原**，需本地跑 GPT-SoVITS（见下） |
| 洛琪希 · 日本語 | Edge `ja-JP-NanamiNeural`，音调 1.15 | 日语，需联网 |
| 洛琪希 · 中文 | Edge `zh-CN-XiaoyiNeural`；离线退 Huihui | 中文对话为主 |
| 洛琪希 · 多语言自动 | 中日英三套音色按回复语言切换 | 最省心 |
| 洛琪希 · VOICEVOX 动漫音色 | 动漫风格日语女声 | 需自装 VOICEVOX |
| 原声 · 不做处理 | 关闭音调处理 | 调试用 |

### 启用洛琪希的音色（已默认启用，开箱即用）

**结论：什么都不用做。** 启动桌宠即自动完成 —— 会自动配置好参考音频、自动拉起语音服务、
语音引擎自动选中 GPT-SoVITS。实测（清空全部配置后的首次运行）：

```
[gptsovits] 已自动配置：...\GPT-SoVITS-v2pro-20250604
[gptsovits] GPT-SoVITS 已启动（127.0.0.1:9880）
[selftest] GPT-SoVITS PASS — provider=gptsovits, promptText="ルディほどではないですが…", promptLang=ja
```

#### 音色是怎么来的

微调模型（视频里的 RoxyPro）只在百度网盘 / 迅雷 / Google Drive 分发，这三个从本机都下不动。
所以走的是一条**能立刻用上洛琪希音色**的替代路线 —— GPT-SoVITS 的**零样本克隆**：
只要一段 5~10 秒的干净人声，底模就能克隆出很接近的音色。

参考音频取自 HuggingFace 上公开的洛琪希语音模型仓库
[`Anexdeus/Roxy_Migurdia_coqui_XTTS`](https://huggingface.co/Anexdeus/Roxy_Migurdia_coqui_XTTS)
里随模型一起发布的 `reference.wav`，并已放在：

```
GPT-SoVITS-v2pro-20250604\refs\roxy-reference.wav     6.08 秒，44.1 kHz
GPT-SoVITS-v2pro-20250604\refs\roxy-reference.txt     逐字文稿（程序自动读取）
```

音频内容是洛琪希的一句台词：

> ルディほどではないですが、魔術の飲み込みは早いですし、頭もいいです。

> 那段音频原本没有配文稿。是**用整合包自带的 faster-whisper 转录出来的**
> （识别为日语，置信度 0.99），转录结果写进同名的 `.txt`，程序启动时自动读取。

#### 换成你自己的参考音频

把新的音频丢进 `refs\`，**再写一个同名的 `.txt` 放文稿**：

```
my-roxy.wav
my-roxy.txt    ← 就是 wav 里逐字说的那句话
```

然后「设置 → 语音 → GPT-SoVITS → 自动检测」。程序会选最新的音频、
自动读文稿、并按文稿内容判断语言（有假名→日语，汉字为主→中文）。
**文稿必须逐字一致**，写错音色会跑偏。

想试听效果可以直接播放 `docs/voice-demo/洛琪希-中文示例.wav`（用这个音色合成的中文）。

#### 想要更还原：换成微调模型

零样本克隆只是"接近"。拿到视频里的 RoxyPro 后：

| 文件 | 放到 |
| --- | --- |
| `*.ckpt` | `GPT-SoVITS-v2pro-20250604\GPT_weights_v2ProPlus\` |
| `*.pth` | `GPT-SoVITS-v2pro-20250604\SoVITS_weights_v2ProPlus\` |

再点一次「自动检测」，程序会发现微调权重，自动把「参考方式」切到**常驻模型**，
优先使用它们 —— 这时不再需要参考音频，效果最好。

#### 手动控制

设置 → 语音 → GPT-SoVITS 里可以逐项调整：

| 项 | 作用 |
| --- | --- |
| **启动桌宠时自动运行** | 默认开；关掉就只在你点「立即启动」时启动 |
| **立即启动** | 手动拉起服务，并显示当前状态 |
| **参考方式** | 「参考音频」（零样本克隆）/「常驻模型」（微调权重） |
| **合成语言** | 日语 / 中文 / 中英混合 …；要和你想让她说的话一致 |
| **参考音频文本** | 对应参考音频的逐字文稿 |

服务本身是独立进程，**关掉桌宠不会退出它**（下次启动直接复用，省掉 30 秒加载）。
不想让它常驻的话，任务管理器里结束 `python.exe` 即可。

### 用真正的洛琪希 AI 语音模型（已装好）

B 站 [**BV1HfF6zNEK8**](https://www.bilibili.com/video/BV1HfF6zNEK8/)（UP：独孤欲雪）
分享的是**用洛琪希语音集微调的 GPT-SoVITS 模型**（RoxyPro），这是目前最还原的洛琪希声线。
**GPT-SoVITS 已经装在这台机器上了**，随时可用。

#### 安装位置与状态

下文用 `<GPT-SoVITS 根目录>` 指代你自己的 GPT-SoVITS 安装目录，整合包解压后形如：

```
<GPT-SoVITS 根目录>\GPT-SoVITS-v2pro-20250604\
```

| 项目 | 状态 |
| --- | --- |
| 版本 | 官方整合包 **v2Pro / 20250604**（解压后 14.1 GB，50612 个文件） |
| 内置运行时 | Python 3.9.13 —— **不需要另装 Python** |
| 推理框架 | torch 2.0.0+cu118，**CUDA 可用，实测跑在 RTX 3060 Ti 上** |
| 预训练模型 | 全部随包附带（含 `v2ProPlus`） |
| 当前配置 | `tts_infer.yaml` 的 `custom` 段已指向 **v2ProPlus + cuda + half** |

#### 怎么启动

服务需要**独立进程常驻**（关掉窗口就停止），二选一：

```powershell
# 只启动 API（桌宠只需要这个）
powershell -ExecutionPolicy Bypass -File "<GPT-SoVITS 根目录>\GPT-SoVITS-v2pro-20250604\start-gptsovits-api.ps1"

# 或者启动完整 WebUI（含训练/推理界面，也会开 API）
双击安装目录里的 go-webui.bat
```

启动成功的标志是看到 `Uvicorn running on http://127.0.0.1:9880`。

#### 随桌宠自动启动

设置 → 语音 → GPT-SoVITS → **「启动桌宠时自动运行」**（默认开）。

启动流程是**惰性且不打扰**的：桌宠先把界面显示出来，2.5 秒后再去检查 9880 端口。

- **端口已经开着** → 什么都不做（你手动跑的 `go-webui.bat` 不会被抢）
- **端口关着** → 用整合包自带的 `runtime\python.exe` 拉起 `api_v2.py`，然后轮询端口直到就绪
- **没有安装目录** → 只在日志里说一声，不弹窗、不阻塞

实测冷启动：

```
[gptsovits] ...\runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c ...\tts_infer.yaml
结果: {"ok":true,"started":true,"message":"GPT-SoVITS 已启动（127.0.0.1:9880）"}  耗时 27.2s
```

v2ProPlus 要加载约 340 MB 权重，**首次启动约 30 秒**；之后就一直在后台待命，
关掉桌宠也不会退出（它是独立进程，下次启动会直接复用它）。

设置面板里的「立即启动」按钮走的是同一条路径，用来手动确认服务状态。

> 自我测试（`--selftest`）**永远不会**启动它，也不会创建托盘或注册全局快捷键 ——
> 自测跑在离屏渲染里，不会在你的桌面上出现任何窗口。

#### 在桌宠里接上

设置 → 语音 → **GPT-SoVITS** → 点 **「自动检测」**。
它会自动找到安装目录、填好权重路径，并把 GPT-SoVITS 接到降级链的最前面
（只要它在跑，就优先于 Edge / VOICEVOX / 系统语音）。

实测（`--selftest --selftest-gsv`）：

```
[selftest] GPT-SoVITS PASS — provider=gptsovits, duration=2.98s, elapsed=1.29s
```

#### 还差一步：洛琪希的音色

视频里那个微调模型放在**百度网盘 / 迅雷网盘 / Google Drive**（解压密码 `Roxy0721`）。
这三个在这台机器上都下不动（G Drive 直接被墙、网盘需要登录客户端），
所以这一次需要你手动下载。**在那之前也有能用的方案** —— 见下。

#### 方案 A：零样本克隆（现在就能用）

GPT-SoVITS 底模只需要**一段 5~10 秒的干净人声**就能克隆出相近音色。

1. 把洛琪希的一段独白音频（`.wav` / `.mp3`，无 BGM、无重叠人声）放进
   `GPT-SoVITS-v2pro-20250604\refs\`
2. 设置 → 语音 → GPT-SoVITS → 点「自动检测」，参考音频路径会自动填好
3. **手动填「参考音频文本」** —— 就是那段音频里逐字对应的那句话，写错音色会跑偏

> `refs\` 里现在有一个 `example-placeholder.wav`，是用系统语音生成的占位样本，
> 用来验证链路是否通畅。确认能出声后就可以删掉它，换成真正的洛琪希音频。

#### 方案 B：微调模型（效果最好）

从视频置顶评论下载 `洛琪希GSV模型` 压缩包（密码 `Roxy0721`）并解压，然后：

| 文件 | 放到 |
| --- | --- |
| `*.ckpt` | `GPT-SoVITS-v2pro-20250604\GPT_weights_v2ProPlus\` |
| `*.pth` | `GPT-SoVITS-v2pro-20250604\SoVITS_weights_v2ProPlus\` |

再点一次「自动检测」，程序会检测到微调权重，自动把「参考方式」切到
**常驻模型** 并优先使用它们 —— 这时不再需要参考音频。

#### 推理速度

RTX 3060 Ti 上，一句 3 秒的话约 1.3 秒生成（模型预热后），比实时快。
第一次合成会慢一些（要加载权重）。

### 语音引擎对比

设置 → 语音 → **语音引擎**，默认「**自动**」：依次尝试
GPT-SoVITS → Edge → VOICEVOX → 在线接口 → 系统语音 → 浏览器语音，
**连不上的引擎自动跳过 30 分钟**。面板上实时显示每个引擎的状态。

| 引擎 | 音质 | 离线 | 可选音色 | 说明 |
| --- | --- | --- | --- | --- |
| **自动** | — | — | — | 推荐 |
| **GPT-SoVITS** | ★★★★★ | ✓ | 取决于模型 | 洛琪希专用微调模型，最还原 |
| **Edge TTS** | ★★★★★ | ✗ | 300+ | 免费、自然，需联网 |
| **VOICEVOX** | ★★★★☆ | ✓ | 几十种 | 动漫风格日语，需自装 |
| **在线 TTS 接口** | ★★★★★ | ✗ | 取决于服务 | 任意 OpenAI 兼容 `/audio/speech` |
| **Windows 系统语音** | ★★☆☆☆ | ✓ | 本机音色 | 走 SAPI 5，可真正挑选音色 |
| **浏览器内置语音** | ★★☆☆☆ | ✓ | 见 FAQ | 兜底方案 |
| **不朗读** | — | — | — | 只显示文字 |

### 多语言：按内容自动切换音色

设置 → 语音 → **语言 → 朗读语言**：**自动识别**（假名→日语、谚文→韩语、
汉字为主→中文、拉丁为主→英语）或固定某语言。每种语言**各有一套音色设置**。

语言识别实测 8/8（中/日/英/韩/俄 全部正确）。

**引擎也会按语言筛选**：若当前语言没有任何可用引擎，程序会先试所有支持该语言的引擎；
全失败才降级，并**明确弹窗告知**，而不是默默用中文腔念日语。

### 音调是怎么实现的

引擎本身都不提供可用的音高控制（实测：Windows SAPI 的 SSML `pitch` 参数被完全忽略，
三个不同 pitch 值合成的文件字节数完全相同）。所以走的是变声器思路：

1. 让引擎**放慢**合成；2. 播放时用 `playbackRate` 加速回来，并设 `preservesPitch = false`。

结果是**语速不变、只有音高变化**。实测：

```
音调 0.85 -> 源 5.44s × 倍率 0.85 = 最终 6.40s
音调 1.00 -> 源 6.77s × 倍率 1.00 = 最终 6.77s
音调 1.15 -> 源 7.57s × 倍率 1.15 = 最终 6.58s
音调 1.35 -> 源 9.40s × 倍率 1.35 = 最终 6.97s
=> 源时长随音调单调增长 ✅；补偿后语速偏差 8.3% ✅
```

## 与 psd2live 的参数契约

本模型是用 [psd2live](https://github.com/) 从 PSD 生成的（`assets/model/roxy/seethrough_skirt_split.psd2live.json` 就是它的工程文件）。
运行时的参数驱动严格按它的规范来，权威来源是 psd2live 仓库里的两份文件：

- `docs/zh/spec/DEFORMER_AND_PARAMETER_SPEC.md` —— 「Cubism 标准参数清单与映射表」
- `src/main/kotlin/io/github/psd2live/core/MotionGenerator.kt` —— 四个动作曲线的确切数值

### 1. 参数范围不是 Cubism 的默认值

psd2live 用 **8×8 九轴面部经纬网**，关键帧打在 `ParamAngleX ∈ {−45°, 0, +45°}`、
`ParamAngleY ∈ {−30°, 0, +30°}` 上，所以头部的行程比 Cubism 常见的示例（±30）更大：

| 参数 | psd2live 范围 | Cubism 常见示例 |
| --- | --- | --- |
| `ParamAngleX` | **±45°** | ±30 |
| `ParamAngleY` | **±30°** | ±30 |
| `ParamAngleZ` | ±30° | ±30 |
| `ParamBodyAngleX/Y/Z` | **±10°** | ±10 |
| `ParamEyeBallX/Y`、`ParamEyeBallForm` | ±1 | ±1 |
| `ParamMouthOpenY`、`ParamBreath`、`ParamEyeL/ROpen` | 0…1 | 0…1 |

**运行时不再硬编码这些数字**，而是模型加载后直接读 moc3 里的真实上下限
（设置 → 动作 / 视线 页底部会实时列出）。实测输出：

```
AngleX [-45, 45]  AngleY [-30, 30]  AngleZ [-30, 30]  BodyAngleX [-10, 10]  BodyAngleY [-10, 10]  BodyAngleZ [-10, 10]
EyeLOpen [0, 1]  EyeROpen [0, 1]  EyeBallX [-1, 1]  EyeBallY [-1, 1]  EyeBallForm [-1, 1]
BrowLY [-1, 1]  BrowRY [-1, 1]  MouthForm [-1, 1]  MouthOpenY [0, 1]  Breath [0, 1]  HairFront [-1, 1]  HairBack [-1, 1]
```

默认视线幅度是按这个行程定的：转头 14°（约三成行程）、抬头 9°、身体 5°，**留出余量给动作**。

### 2. 动作曲线的确切含义

`MotionGenerator.kt` 生成的四条曲线（设置 → 动作 页也有同样的说明）：

| 动作 | 时长 | 曲线 |
| --- | --- | --- |
| **Idle** | 6.0s 循环 | `ParamBreath` 0↔1；`ParamAngleZ` ±2°；`ParamBodyAngleX` ∓1.2°；第 2.78 秒自带一次眨眼 |
| **Blink** | 1.2s | 眼睛 1→1→0→1→1 |
| **Nod** | 2.0s | `ParamAngleY` 0→**−18°**→+6°→0；`ParamBodyAngleY` ∓4°；眼睛压到 0.75 |
| **Shake** | 2.0s | `ParamAngleX` 0→**−20°**→**+20°**→−8°→0；`ParamBodyAngleX` ±3°；`ParamAngleZ` ±2° |

> 这四个 motion 文件**没有写 `Meta.FadeInTime`**，Cubism 运行时会套用默认的 **1 秒淡入**。
> 结果是落在片段前 1 秒内的峰值会被平滑衰减 —— 例如 Shake 的 −20° 出现在 0.4 秒处，
> 实测只到 −12°；但整体摆幅仍达 **36.9°**（曲线 40°），动作清晰可见。
> 这是 Cubism 的正常行为，不是被覆盖。

### 3. 三个必须遵守的运行时约定（都是踩过的坑）

**① 角度参数必须「叠加」，不能「赋值」。**
Idle/Nod/Shake 已经在写 `ParamAngleX/Y/Z` 和 `ParamBodyAngleX/Y`。
如果视线跟随用 `setParameterValueById` 直接赋值，点头瞬间就会被压回 0.5° —— 动作等于不存在。
所以视线改成了 `add + clamp 到模型范围`（这也正是 Cubism 自带 focus controller 的做法）。
修复前后实测同一个点头动作：

```
修复前：ParamAngleY 区间 ≈ [0.0, 0.5]      ← 动作被视线抹平
修复后：ParamAngleY 区间 [-18.2, 5.5]      ← 与曲线的 -18° 相符，摆幅 23.7°（曲线 24°）
         ParamAngleX 区间 [-20.1, 18.9]    ← Shake 的 ±20° 出来了，摆幅 39.0°（曲线 40°）
```

**② 眨眼必须写在 physics 之前。**
模型的 `physics3.json` 里有：

```
PhysicsEyeJelly:  INPUT ParamEyeLOpen(50) + ParamEyeROpen(50)  →  OUTPUT ParamEyeBallForm (scale 0.32)
PhysicsHairFront: INPUT ParamAngleX/Z + ParamBodyAngleX/Z      →  OUTPUT ParamHairFront (scale 1.522)
PhysicsHairBack:  同上                                          →  OUTPUT ParamHairBack  (scale 2.061)
```

Cubism 的更新顺序是 `motion → eyeBlink → focus → breath → **physics** → 我们的钩子 → 网格形变`。
只写在最后的钩子里，物理永远看不到我们的眨眼值，**果冻眼就一直是死的**。
所以眨眼现在写两次：`afterMotionUpdate` 时写一次（喂给物理），`beforeModelUpdate` 再确认一次。
修复后果冻眼在点头时摆到 `[−0.35, 0.29]`、摇头时 `[−0.96, 1.00]`。

**③ 眼睛开合用「相乘」而不是「赋值」。**
Nod 曲线会把眼睛压到 0.75。直接赋值会丢掉这个细节，
改成 `现行值 × 本次眨眼系数` 之后，动作里的眯眼和自动眨眼能同时生效。

**④ `ParamHairFront` / `ParamHairBack` 一律不碰**，由物理设置驱动。

### 4. 关掉 pixi-live2d-display 自带的「示例呼吸」（重要）

pixi-live2d-display 在创建模型时会塞进一个**通用示例呼吸**，它驱动的是：

| 参数 | 幅度 |
| --- | --- |
| `ParamAngleX` | **±15°** |
| `ParamAngleY` | ±8° |
| `ParamAngleZ` | ±10° |
| `ParamBodyAngleX` | ±4° |
| `ParamBreath` | 0↔1（偏移 0.5 + 幅度 0.5） |

这跟 psd2live 的绑定毫无关系 —— 它的规范写明呼吸只通过 `ParamBreath` 表现（胸腔高斯膨胀），
头身摇摆属于生成的 Idle 曲线。开着它，等于在一切之上再加一层 ±15° 的幽灵摇头。

排查方法：临时包装 `coreModel.setParameterValueById` / `addParameterValueById`，
只记录 `ParamAngleX` 的调用并抓栈，抓到的是

```
add 12.378  ← at a.updateParameters
              at He.updateNaturalMovements
              at He.update
```

修复：加载后把 `internalModel.breath` 摘掉，由 `Pet` 自己驱动 `ParamBreath`
（一个 3.4 秒周期的余弦，受「呼吸起伏 / 呼吸速度」设置控制）。

修复前后对比：

```
待机头部摇摆   修复前 -5.9 ~ +5.8°   →  修复后 -2.1 ~ +1.8°  （正好是 idle 曲线的 ±2°）
Shake 摆幅     修复前  38.5°          →  修复后  39.4°        （曲线 40°，不再被呼吸噪声干扰）
```

### 5. 为什么 motion 文件看起来"很空"

psd2live 官方文档 `docs/zh/spec/RUNTIME_EXPORT_ARCHITECTURE_AND_GAPS.md` 明确说明：

> **Motion/Expression/Pose/UserData**：不在核心模型……边车生成或透传……**缺少统一可编辑领域模型**

也就是说 `.motion3.json` 是生成器写出的**声明式曲线**（每条只有 3–5 个关键帧），
不是美术手 K 的动画。真正让它"活起来"的责任在运行时——也就是这个程序。

用 `node scripts/tools/inspect-model-params.cjs <模型目录>` 可以随时把任一模型的动作曲线、时长、
参数范围打印出来，用来核对上面这些结论。

---

## 配置对话 API

打开 **设置 → 对话**。人设已经按洛琪希写好了，一般不用动。

1. **接口地址**：下拉选择服务商（或选"自定义…"手填）。任何兼容 `POST /chat/completions` 的服务都能用。
2. **API Key**：填入你的密钥。**只保存在本机** `%APPDATA%\ai-computer-pet\settings.json`，不会发送到任何第三方。
3. **模型名称**：可点「获取模型列表」自动拉取后下拉选择。
4. 点 **「测试连接」** 确认可用。

常用配置示例：

| 服务 | 接口地址 | 模型 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5:7b` |
| LM Studio（本地） | `http://localhost:1234/v1` | 本地已加载的模型 |

### 情绪标签

系统提示词要求模型在回复最前面加一个情绪标签，例如 `[happy]`、`[shy]`、`[think]`：

```
[happy]当然记得呀！我们刚刚才聊过天呢～
```

支持 `happy / smile / sad / angry / surprised / shy / think / love / sleepy / neutral`
（以及 `joy`、`excited`、`embarrassed` 等同义词）。
还可以用 `[motion:nod]` / `[motion:shake]` 让她点头或摇头。

这些标签会在流式接收时**边收边解析**——标签一到位表情立刻变化，正文继续往下流。
标签不会显示在气泡里。若模型不听话，可在设置里关掉「解析情绪标签」。

---

## 设置面板

面板是 **VS Code 风格**：顶部标题栏 + 搜索框，左侧分类树，右侧设置项，底部状态栏。
每一项都显示自己在 settings.json 里的键名（等宽字体），改过的项左侧有蓝色标记条，
搜索框可跨分类按名称或键名搜索。

### 参数锁定

设置项行右侧有 🔓 按钮，点一下变成 🔒：

- **锁定后不可编辑** —— 控件置灰，防误操作；
- **锁定后不会被声线预设覆盖** —— 可以锁住 API Key、音调、音量等，然后放心切换预设；
- 支持锁定整个分组（例如锁 `voice` 会锁住它下面所有项）；
- 锁定的项列在 **设置 → 锁定** 页，可一键全部解锁。

自动化测试实测（`--selftest`）：

```
[selftest] 锁定 PASS — 预设 1.06→1.5, 锁定中未被覆盖=true, 解锁后生效=true
```

> **实现注意**：`locks` 在配置存储里是**整体替换**语义，不走深度合并。
> 深度合并只能新增/覆盖键、无法删除，所以「解锁」如果走合并就永远删不掉已有锁 —— 这是踩过的坑，
> 已在 `src/main/lib/store.cjs` 里用 `REPLACE_KEYS` 显式处理。

### 模型参数（与 psd2live 一一对应）

设置 → **模型参数**，6 个分组、18 个参数，**和 psd2live 的 `cdi3.json` 完全对应**：

| 分组 | 参数 |
| --- | --- |
| **面部** | `ParamAngleX` `ParamAngleY` `ParamAngleZ` |
| **眼睛** | `ParamEyeLOpen` `ParamEyeROpen` `ParamEyeBallX` `ParamEyeBallY` `ParamEyeBallForm` |
| **眉毛** | `ParamBrowLY` `ParamBrowRY` |
| **嘴巴** | `ParamMouthForm` `ParamMouthOpenY` |
| **身体** | `ParamBodyAngleX` `ParamBodyAngleY` `ParamBodyAngleZ` `ParamBreath` |
| **物理** | `ParamHairFront` `ParamHairBack` |

已用脚本核对过模型与 psd2live 源码：**18 个，不多不少，分组也一致**。

每个参数有三种模式：

| 模式 | 行为 |
| --- | --- |
| **自动**（默认） | 交给程序驱动，可以设**上下限**把自动结果夹在区间内 |
| **偏移** | 在自动结果之上加一个固定偏移，不夺走原有动画 |
| **固定** | 直接把该参数钉死在指定值，压过所有自动逻辑 |

自动模式下每一项右侧有一条**实时曲线**（最近 2 秒、120 个采样点），
蓝色折线是当前值、浅蓝填充是它的历史范围。上下限和曲线只在
**模型参数这一页打开时**才启用采样 —— 离开页面就自动停掉，不占性能。

上下限为空表示不限制；点「清除」恢复不限。实测：

```
[selftest] 参数上下限 PASS — 上限 0.572→0.229（限 0.229）, 下限 0.572→5.572（限 5.572）, 曲线采样 20 点
```

（测试故意把上限设到引擎值之下、下限设到之上，确认自动结果被**精确**夹到边界。）

滑杆的范围**不是硬编码**，而是模型加载后从 moc3 里读出的真实上下限
（`ParamAngleX` 是 −45~45，`ParamBodyAngleX` 是 −10~10，`ParamEyeL/ROpen` 是 0~1 ……）。
面板顶部会把 18 个参数的实测范围列出来。

自动化验证：

```
[selftest] 模型参数 PASS — 18/18 个参数可手动驱动
```

测试会把 18 个参数逐个钉到各自范围内的一个特征值，再从模型里读回来比对，
所以它是真的在验证「每一个都能写进去」，而不是只看代码路径。

> **实现细节**：眼球开合两个参数（`ParamEyeLOpen` / `ParamEyeROpen`）的手动值会**写在物理步之前**，
> 因为 `PhysicsEyeJelly` 要读它们来算果冻眼；其余 16 个在最后的钩子里写。
> 分成两批是为了避免同一个偏移被叠加两次。

'use strict'
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const readme = path.join(root, 'README.md')
const autostart = fs.readFileSync(path.join(root, 'docs', 'gsv-autostart.md'), 'utf8')

let t = fs.readFileSync(readme, 'utf8')

/* 1. auto-start section, right after the "怎么启动" block */
const anchor = '#### 在桌宠里接上'
const i = t.indexOf(anchor)
if (i < 0) {
  console.error('anchor not found')
  process.exit(1)
}
t = t.slice(0, i) + autostart + '\n' + t.slice(i)

/* 2. mouth section: append after the 参数锁定 subsection */
const mouthSec = `
### 嘴巴为什么看不见（模型缺陷，非程序问题）

排查结论：**这个模型的嘴部网格是坏的** —— 它存在、位置正确、但不产生任何像素。

实测证据（`--selftest-mouth`，全部离屏运行）：

| 检查项 | 结果 |
| --- | --- |
| 网格存在 | ✅ \`ArtMeshMouth\` 75 顶点 / 288 索引，另有上下唇描边各 98 顶点 |
| 渲染顺序 | ✅ 17，在 \`ArtMeshFace\`(15) **之后**，在上层 |
| 不透明度 / 可见性 | ✅ 都是 1 / true，无遮罩，混合模式正常 |
| 位置尺寸 | ✅ 在鼻子正下方（鼻子可见），宽度约为脸的 10% |
| 对参数的响应 | ⚠️ 有，但很弱：\`ParamMouthOpenY\` 0→1 时面积只从 2.26e-5 涨到 5.86e-5 |
| 贴图像素 | ✅ 该 UV 区域**有**画（31% 不透明，比鼻子还多） |
| **实际画面** | ❌ 8 倍放大后，无论 \`ParamMouthOpenY\` 是多少都**完全看不到嘴** |

对照组证明测量方法可靠：把 \`ParamAngleX\` 设为 45° 时，面部网格顶点确实移动了
（\`[-0.035,0.418,…] → [-0.023,0.421,…]\`），所以顶点探针读的是真实形变数据，不是静态数据。

`seethrough_skirt_split.psd2live.json` 里有一条警告解释了成因：

> CMO3：未保留原始 PSD 源图编辑链；已从 1 页贴图重建可编辑图层（模型/Rig 数据仍保留）

也就是说这个模型是**从单页贴图重建导出的**，重建过程里嘴部画层的顶点/权重出了问题。
**程序端无法修复** —— 需要拿源 PSD 重新导出一次。

源 PSD 名为 `seethrough_skirt_split.psd`（不在本仓库内，重新导出时请自备）。

#### 已经做的补救：让嘴张得更大

虽然网格坏了，但**口型驱动的数值映射确实有问题，已经修好**。

原先合成语音经分析器算出的电平峰值只有 0.6 左右，嘴巴最多张到 60% —— 本来就不明显的嘴更难看见。
现在加了一个**峰值跟随归一化**（跟踪近期峰值并把最响的音节映射到 1.0），并把
\`mouthMax\` 默认值从 0.85 提到 **1.0**：

\`\`\`
修复前：LIPSYNC peak ParamMouthOpenY = 0.597
修复后：LIPSYNC peak ParamMouthOpenY = 0.970   ← 用满整个行程
\`\`\`

所以一旦模型重新导出，嘴巴会是**完全张开**的，而不是只张六成。

### 设置项

| 分类 | 分组 |
| --- | --- |
| **显示** | 窗口、模型、外观 |
| **视线** | 跟随、自然感 |
| **动作** | 眨眼、呼吸与物理、随机动作 |
| **抚摸** | 互动、台词 |
| **对话** | 接口、生成参数、人格 |
| **语音** | 引擎、语言、声线、GPT-SoVITS、VOICEVOX、Edge TTS、系统语音、在线 TTS 接口、浏览器语音、口型同步、语音输入 |
| **模型参数** | 总览、面部、眼睛、眉毛、嘴巴、身体、物理（18 个参数） |
| **锁定** | 已锁定项 |
| **关于** | 版本、操作说明、开机自启、开发者工具 |

全部改动即时生效并写入 `%APPDATA%\ai-computer-pet\settings.json`；
面板位置与聊天窗口位置存在同目录的 `state.json`。

## 常见问题

**Q：Edge TTS 提示不可用，自动切成了别的引擎？**
A：Edge TTS 走 `wss://speech.platform.bing.com`，部分网络环境（公司网络、代理、境外 IP）会被拒绝，
表现为 403 或连接被重置。程序会自动跳过它并记住 30 分钟，改用下一个可用引擎。
想恢复：确认网络后点 **设置 → 语音 → 重试已失败的引擎**；或改用「在线 TTS 接口」；
或就用「Windows 系统语音」（离线、稳定）。
可用 `node scripts/tools/test-tts.cjs` 单独诊断 Edge TTS，`node scripts/tools/test-voice.cjs` 看引擎全貌与音调补偿效果。

**Q：GPT-SoVITS 不出声？**
A：按顺序查三件事：

1. 服务是否在跑 —— 运行 `node scripts/tools/check-gptsovits.cjs`，或看 9880 端口是否在监听；
2. 设置 → 语音 → GPT-SoVITS 的「安装目录」是否为空，空了就点「自动检测」；
3. 若用「参考音频」模式，**参考音频文本必须和音频里说的话逐字一致**，不一致会导致音色错乱甚至报错。

**Q：语音下拉框里没有音色可选 / 选了没反应？**
A：分两种情况，别搞混：
- **「Windows 系统语音 → 声音」为空** → 本机没装任何 SAPI 语音。跑一次
  `scripts\enable-more-voices.ps1`（需管理员）通常就能补上康康（男声）和瑶瑶（女声）。
- **「浏览器内置语音 → 系统音色」为空** → Chromium 在这台机器上枚举不到语音
  （`speechSynthesis.getVoices()` 返回空数组，但默认音色仍能发声）。这是 Chromium 的行为，不是程序坏了；
  改用「Windows 系统语音」就能正常选音色。

**Q：换了音色但听起来差不多？**
A：同一引擎内不同音色的差异有限。想明显改变听感，请调 **声线调整 → 音调（声线）** 滑杆
（1.22 少女、0.85 低沉），或换成「Edge TTS / 在线 TTS」这类多音色引擎。

**Q：她挡住了我的操作 / 点不到桌面上的东西？**
A：正常情况下鼠标移开她就会穿透。如果确实出现异常，右键托盘图标 → 勾选「鼠标穿透（点击穿过桌宠）」强制穿透，
或直接「退出」。

**Q：模型没显示出来？**
A：先把窗口调到前台看左下角状态浮层（设置 → 界面 → 打开状态信息）。
也检查 `%APPDATA%\ai-computer-pet\settings.json` 里 `model.path` 是否指向存在的文件。
若显卡不支持 WebGL 2，可尝试在设置里把帧率降到 30。

**Q：太占资源？**
A：设置 → 显示 → 渲染帧率 改成 30 FPS；关掉「物理演算」；把「整体大小」调小。
窗口隐藏时渲染会自动暂停。

**Q：她一直重复同一句话 / 不记得聊过什么？**
A：设置 → 对话 → 「记忆轮数」调大（默认 20）；另外「系统提示词」里可以补充设定。

---

### 排查：为什么会提示「gptsovits 不可用，已改用系统语音」

有**两个叠加的原因**，其中一个是真 bug。

#### 主因：语言门禁把 GPT-SoVITS 排到了系统语音后面（已修）

`synthesizeWithFallback` 会先挑「支持当前语言」的引擎排在前面。而原来的判断是：

```js
case 'gptsovits': {
  // 只在与模型训练语言一致时才认为支持
  const want = String(settings?.voice?.gptsovits?.textLang || 'zh').slice(0, 2)
  return want === profileLang
}
```

问题在于 `gptsovits.textLang` 被设成了 **`ja`**（跟着日文参考音频走的），
而桌宠说的话是**中文**（`zh-CN`）—— 于是判定「GPT-SoVITS 不会说中文」，把它排到链尾：

```
排序前: [edge, sapi, webspeech, gptsovits]   ← gptsovits 垫底
执行:   edge 失败 → sapi 成功 → 直接返回
结果:   用了系统语音，gptsovits 根本没被调用
```

**这个判断本身就是错的**：GPT-SoVITS 里参考音频的语言（`prompt_lang`）和朗读的语言
（`text_lang`）是**两个独立参数**，v2ProPlus 也是多语言的。能力属于**模型**，不属于当前选中的 `text_lang`。

修复后：

```
zh-CN  gptsovits supports -> true
ja-JP  gptsovits supports -> true
en-US  gptsovits supports -> true
ko-KR  gptsovits supports -> true
ru-RU  gptsovits supports -> false   （模型确实不会）
```

用真实配置跑降级链：

```
修复前:  最终引擎: sapi        ← 系统语音
修复后:  最终引擎: gptsovits   耗时 5.5s，失败的引擎: 无 ✅
```

顺带修了**朗读语言**：以前无论说什么都把设置里的 `textLang` 发给服务，
现在按**文本实际语言**自动选（中文→`zh`、日语→`ja`…），只有用户手动固定语言时才用设置值。
否则中文台词会被日文 G2P 念出来。

#### 帮凶：一次失败 = 锁死 30 分钟（已修）

GPT-SoVITS 偶尔会返回 **HTTP 500**（服务端内部错误，和具体文本有关，是偶发的）。
原来的策略是**任何一次失败都冷却 30 分钟，而且写进 `state.json` 持久化**：

```json
"voiceFailures": { "gptsovits": 1789824892460 }
```

重启桌宠也不清除 —— 一次几秒钟的偶发错误，变成半小时用不了洛希琪的声音。

现在改成**递增退避 + 自动重试**：

| 连续失败 | 冷却 |
| --- | --- |
| 1 次 | **20 秒** |
| 2 次 | 1 分钟 |
| 3 次 | 5 分钟 |
| 4 次以上 | 30 分钟 |

并且每次失败会**先自动重试一次**（间隔 400ms）才计入失败。

#### 附带：失败原因现在会被记下来

以前只存一个时间戳，事后完全查不出为什么。现在存 `{ at, count, error }`：

```json
"gptsovits": { "at": 1789825392500, "count": 1,
               "error": "GPT-SoVITS /tts 失败 HTTP 500: Internal Server Error" }
```

设置 → 语音 的引擎状态里能看到这条原因，也能一键清除。

#### 还有一处潜在竞态（已修）

启动后台词在 **0.9 秒**就朗读，而 GPT-SoVITS 冷启动要 **约 30 秒**加载权重。
第一次启动时问候语必然落在备用引擎上。现在问候语会**等服务就绪**（最多等 45 秒）再朗读。

#### 如果又遇到

1. 设置 → 语音 → 点「清除降级记录」，立刻恢复
2. 引擎状态里会显示具体错误；若是 `HTTP 500`，那是服务端的偶发错误，重试即可
3. 实在不行重启桌宠（服务是独立进程，不受影响，不用重新加载 30 秒）

---

## 项目结构

```
aicomputerpet/
├─ package.json
├─ README.md
├─ LICENSE                       # 源代码：MIT
├─ NOTICE.md                     # 模型 / 美术素材 / 第三方库的授权范围
├─ .editorconfig · .gitattributes · .gitignore
├─ src/                           # 全部源码
│  ├─ shared/defaults.json       # 全部设置项的默认值（主进程与渲染进程共用）
│  ├─ main/                      # 主进程
│  │  ├─ main.cjs                # 窗口、托盘、全局快捷键、app:// 协议、IPC
│  │  ├─ preload.cjs             # contextBridge：window.pet
│  │  └─ lib/
│  │     ├─ store.cjs            # 防抖 + 原子写入的 JSON 配置存储
│  │     ├─ llm.cjs              # OpenAI 兼容 Chat Completions（SSE 流式）
│  │     ├─ tts.cjs              # TTS 分发 + 四引擎自动降级 + 音调补偿
│  │     ├─ edge-tts.cjs         # 零依赖 Edge TTS 客户端（含 Sec-MS-GEC 与时钟偏移重试）
│  │     ├─ gptsovits.cjs        # GPT-SoVITS api_v2 客户端（洛琪希微调模型）
│  │     ├─ sapi.cjs             # 调用 Windows SAPI 5（PowerShell 子进程）
│  │     └─ stt.cjs              # Whisper 兼容的语音识别上传
│  └─ renderer/                  # 渲染进程（esbuild 打包）
│     ├─ index.html · styles.css
│     ├─ main.js                 # 启动装配 + 抚摸体验（爱心 / 台词）
│     ├─ pet.js                  # 模型 × 行为控制器 × 每帧参数写入
│     ├─ core/                   # util / bus
│     ├─ live2d/
│     │  ├─ stage.js             # PIXI + 模型加载、轮廓测量、像素级命中检测、参数合成
│     │  ├─ params.js            # psd2live 参数契约：范围、归属、生成的 motion 曲线
│     │  ├─ gaze.js              # 视线跟随（衰减 / 漂移 / 微眼跳 / 平滑）
│     │  ├─ idle.js              # 眨眼调度 + 随机动作
│     │  └─ emotion.js           # 10 种情绪 → 参数映射与混合
│     ├─ features/
│     │  ├─ interaction.js       # 指针状态机：命中检测 / 抚摸 / 拖动 / 穿透
│     │  ├─ voice.js             # 播放 + 口型同步 + 录音识别
│     │  ├─ chat.js              # 会话状态、流式接收、标签解析
│     │  └─ fx.js                # 爱心特效（仅摸头时）
│     └─ ui/                     # 气泡 / 对话面板 / 设置面板 / 快捷条 / 菜单 / 提示
├─ assets/model/roxy/            # Live2D 模型（由 psd2live 自 PSD 生成）
├─ vendor/                       # 第三方运行期库：live2dcubismcore.min.js（官方 CDN 下载）
├─ dist/                         # 构建产物（renderer.js + 复制的 pixi / live2d 库 + 托盘图标）
├─ docs/                         # 文档与参考素材
│  ├─ 优化建议.md                 # 技术交接清单（缺陷 / 优化项 / 约束）
│  ├─ screenshots/               # README 引用的界面截图
│  ├─ source/                    # 模型原图
│  └─ voice-demo/                # 音色试听
└─ scripts/
   ├─ build.mjs                  # esbuild 打包 + 生成托盘图标
   ├─ tools/                     # 诊断脚本（与运行期无关，按需手动跑）
   │  ├─ mock-api.cjs            # 本地 OpenAI 兼容模拟服务
   │  ├─ check-gptsovits.cjs     # GPT-SoVITS 接入自检
   │  ├─ inspect-model-params.cjs # 打印模型的 motion 曲线 / 时长 / 参数范围
   │  └─ test-tts.cjs / test-voice.cjs / test-stt.cjs / list-voices.cjs
   └─ ps/
      ├─ sapi-tts.ps1            # SAPI 合成助手（主进程运行时调用）
      └─ enable-more-voices.ps1  # 解锁 Windows 隐藏语音（需管理员，可 -Undo）
```

---

## 实现要点（给后来改代码的人）

**为什么窗口是全屏透明的？**
桌宠、气泡、对话面板、设置面板都在同一个全屏透明窗口里，靠 `setIgnoreMouseEvents(true, {forward:true})`
实现"平时穿透、需要时接管"。`features/interaction.js` 每帧判断鼠标是否落在她身上（GPU 像素命中）
或某个真实 UI 元素上（`document.elementFromPoint`），只在需要时把窗口切换为可交互。
主进程有 4 秒心跳看门狗：万一渲染进程卡死，会自动恢复穿透，保证桌面不会被锁住。

**参数写入时机**
Cubism 的更新顺序是
`motion → saveParameters → expression → eyeBlink → focus → breath → physics → [beforeModelUpdate] → model.update() → loadParameters()`。
所有自定义参数都写在 `beforeModelUpdate` 钩子里，所以永远覆盖动作与眨眼的结果；
而 `loadParameters()` 会在每帧末尾把它们还原，因此参数**每帧写一次**是正确的、也是必须的。
（这也意味着 `model.update()` 之后读参数只能读到动作值——自测因此改为在钩子内部回读。）

**轮廓测量**
Live2D 画布通常远大于角色（这个模型是 1024² 画布、角色只占约 1/3）。
启动时读一次 GPU 帧缓冲算出真实的 alpha 包围盒，之后气泡、快捷条、视线原点
都以这个"剪影"为基准，所以它们会紧贴在她身上而不是漂在画布角落。

**命中检测**
每次渲染后（`postrender`）对鼠标位置做 1×1 的 `gl.readPixels`，拿到真实 alpha，
因此头发、手臂、双腿之间的空隙都能正确判断。

**修改后请重新构建**：`npm run build`（只改 `src/main/` 下的主进程代码则无需构建，重启即可）。

---

## 开发者：自动化验证

内置了一套无人值守自测，会启动真实 Electron、注入真实鼠标事件、截图并断言模型参数：

```bash
# 基础自测：截图 + 视线 + 抚摸
node_modules\.bin\electron.cmd . --selftest

# 完整自测：额外验证对话流式、TTS 口型、语音识别
node scripts/tools/mock-api.cjs 8787          # 另开一个终端，启动模拟接口
node_modules\.bin\electron.cmd . --selftest --selftest-api=http://127.0.0.1:8787/v1
```

输出示例：

```
[selftest] GAZE PASS — ΔeyeBallX=0.465 (-0.134→0.331), ΔAngleX=6.45°, ΔBodyAngleX=-1.25°
[selftest] LIPSYNC PASS — peak ParamMouthOpenY = 0.621, pet mouth = 0.730, audio level = 0.878
[selftest] STT(upload) PASS — {"ok":true,"text":"这是模拟语音识别返回的文字…"}
[selftest] STT(mic)    PASS — {"ok":true,"text":"这是模拟语音识别返回的文字…"}
[selftest] 锁定 PASS — 预设 1.06→1.5, 锁定中未被覆盖=true, 解锁后生效=true
[selftest] 动作 nod -> PASS 区间 [-21.19, 7.08] 摆幅 28.3°  曲线 AngleY 0→−18→+6（共 24°）
[selftest] 动作 shake -> PASS 区间 [-12.1, 24.76] 摆幅 36.9°  曲线 AngleX 0→−20→+20（共 40°）
[selftest] 待机曲线 PASS — 呼吸 0.24~0.90（idle 曲线 0↔1），头部摇摆 -5.94~5.77°（idle 曲线 ±2°）
[selftest] PITCH PASS — 源时长 3.43/4.27/5.32s 随音调增长=true, 播放倍率=true, preservesPitch=false=true
```

截图会写到 `scripts/selftest-*.png`。

单独诊断：

```bash
node scripts/tools/inspect-model-params.cjs assets/model/roxy     # 核对动作曲线与参数范围
node scripts/tools/check-gptsovits.cjs                       # GPT-SoVITS 服务与模型文件检查
node scripts/tools/test-voice.cjs   # 引擎可用性、音调补偿数学、自动降级链
node scripts/tools/test-tts.cjs     # Edge TTS 连通性与在线音色列表
node scripts/tools/test-stt.cjs     # multipart 上传格式（Node 与 Electron 两种运行时）
node scripts/tools/mock-api.cjs     # 本地 OpenAI 兼容模拟服务
node_modules\.bin\electron.cmd scripts\tools\list-voices.cjs   # Chromium 能看到哪些语音
```

`--selftest` 模式会在渲染进程挂载 `window.__petTest`（设置、对话、朗读、参数回读等），
正常启动时不存在，不影响普通使用。

---

## 许可与致谢

**授权分层**：本仓库**源代码**适用 [MIT 许可](LICENSE)；**模型与美术素材不在 MIT 范围内**，
其权利人另有规定 —— 详见 [NOTICE.md](NOTICE.md)。

- 代码许可：[MIT](LICENSE)
- 素材与第三方库：[NOTICE.md](NOTICE.md)
- Live2D 渲染： [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) + [PixiJS 6](https://pixijs.com/)
- Live2D Cubism Core © Live2D Inc.，遵循 [Live2D 专有软件许可](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)（可再分发代码）
- 请遵守 Live2D 的许可条款使用本模型；模型版权归原作者所有。
