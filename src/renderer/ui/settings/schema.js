/**
 * Settings schema — the single source of truth for the VSCode-style panel.
 *
 * Layout mirrors `SETTINGS_TREE`: category → group → fields. Every field maps to
 * one key path in settings.json; there are no aliases and no duplicate keys.
 */

import { PARAM_CATALOG } from '../../live2d/params.js'

/* helpers ---------------------------------------------------------------- */
const F = (key, label, extra = {}) => ({ key, label, ...extra })
const SW = (key, label) => F(key, label, { type: 'switch' })
const NUM = (key, label, extra = {}) => F(key, label, { type: 'number', ...extra })
const RNG = (key, label, min, max, step, unit, fmt) =>
  F(key, label, { type: 'range', min, max, step, unit, fmt })
const TXT = (key, label, extra = {}) => F(key, label, { type: 'text', ...extra })
const PWD = (key, label, extra = {}) => F(key, label, { type: 'password', ...extra })
const SEL = (key, label, options, extra = {}) => F(key, label, { type: 'select', options, ...extra })
const AREA = (key, label, rows) => F(key, label, { type: 'textarea', rows })
const LINES = (key, label, rows) => F(key, label, { type: 'lines', rows })
const BTNS = (id, items) => ({ type: 'buttons', id, items })
const RESULT = (id) => ({ type: 'result', id })
const INFO = (id, html) => ({ type: 'info', id, html })

const FPS_OPTIONS = [
  { value: 30, label: '30' },
  { value: 45, label: '45' },
  { value: 60, label: '60' },
  { value: 90, label: '90' },
  { value: 120, label: '120' },
]

const PROVIDER_OPTIONS = [
  { value: 'auto', label: '自动（GPT-SoVITS 优先，失败转在线）' },
  { value: 'gptsovits', label: 'GPT-SoVITS（本地声音克隆）' },
  { value: 'openai', label: '在线 TTS 接口（OpenAI 兼容）' },
  { value: 'off', label: '不朗读' },
]

const LANG_OPTIONS = [
  { value: 'auto', label: '自动识别' },
  { value: 'zh-CN', label: '中文（普通话）' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'zh-TW', label: '中文（台灣）' },
  { value: 'zh-HK', label: '粵語' },
  { value: 'ko-KR', label: '한국어' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'es-ES', label: 'Español' },
  { value: 'ru-RU', label: 'Русский' },
]

const STT_LANG_OPTIONS = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'auto', label: '自动检测' },
]

const CHAT_PRESETS = [
  { value: 'https://api.deepseek.com/v1', label: 'DeepSeek' },
  { value: 'https://api.openai.com/v1', label: 'OpenAI' },
  { value: 'https://api.moonshot.cn/v1', label: 'Moonshot 月之暗面' },
  { value: 'https://open.bigmodel.cn/api/paas/v4', label: '智谱 GLM' },
  { value: 'https://api.siliconflow.cn/v1', label: '硅基流动' },
  { value: 'https://dashscope.aliyuncs.com/compatible-mode/v1', label: '阿里通义千问' },
  { value: 'https://ark.cn-beijing.volces.com/api/v3', label: '火山方舟' },
  { value: 'http://localhost:11434/v1', label: 'Ollama（本地）' },
  { value: 'http://localhost:1234/v1', label: 'LM Studio（本地）' },
  { value: '__custom__', label: '自定义…' },
]

/**
 * The tree. `id` values are stable — they are used for navigation state and for
 * the `#settings-nav` links.
 */
/**
 * Model parameters — one control per parameter psd2live generates, grouped the
 * way its cdi3.json declares them. Each can be left automatic, nudged by an
 * offset, or pinned to a fixed value.
 */
const PARAM_SECTION = {
  id: 'params',
  label: '模型参数',
  groups: [
    {
      id: 'overview',
      label: '总览',
      fields: [
        SW('modelParams.enabled', '启用手动覆盖'),
        INFO(
          'params-info',
          '本模型由 psd2live 生成，共 18 个参数、6 个分组，与它的规范一一对应。自动模式下可设上下限把自动结果夹在区间内，右侧曲线显示实时值；也可以改成「偏移」或「固定」直接覆盖。'
        ),
        RESULT('params-ranges'),
      ],
    },
    ...PARAM_CATALOG.map((g) => ({
      id: g.group,
      label: g.label,
      fields: g.params.map((p) => ({
        type: 'param',
        key: `modelParams.items.${p.id}`,
        id: p.id,
        label: `${p.name}`,
        owner: p.owner,
        group: g.label,
      })),
    })),
  ],
}

export const SETTINGS_TREE = [
  {
    id: 'display',
    label: '显示',
    groups: [
      {
        id: 'window',
        label: '窗口',
        fields: [
          SW('display.alwaysOnTop', '始终置顶'),
          SEL('display.screenIndex', '显示器', [], { dynamic: 'screens' }),
          SEL('display.fps', '渲染帧率', FPS_OPTIONS, { unit: 'FPS' }),
          SW('display.clickThrough', '智能鼠标穿透'),
          SW('display.keepInScreen', '限制在屏幕内'),
          SW('display.startHidden', '启动时隐藏'),
          SW('display.showTray', '显示托盘图标'),
        ],
      },
      {
        id: 'model',
        label: '模型',
        fields: [
          TXT('model.path', '模型路径', { wide: true }),
          RNG('model.heightRatio', '人物高度', 0.2, 1.2, 0.01, '%', (v) => Math.round(v * 100)),
          RNG('model.scale', '尺寸微调', 0.4, 2, 0.01, '×', (v) => v.toFixed(2)),
          RNG('model.opacity', '不透明度', 0.2, 1, 0.01, '%', (v) => Math.round(v * 100)),
          NUM('model.offsetX', '水平偏移', { step: 1, unit: 'px' }),
          NUM('model.offsetY', '垂直偏移', { step: 1, unit: 'px' }),
          SW('model.mirror', '水平翻转'),
          SW('model.shadow', '投影'),
          BTNS('model-actions', [{ id: 'reset-position', label: '重置位置' }]),
        ],
      },
      {
        id: 'appearance',
        label: '外观',
        fields: [
          F('ui.accent', '主题色', { type: 'color' }),
          RNG('ui.panelOpacity', '面板不透明度', 0.4, 1, 0.01, '%', (v) => Math.round(v * 100)),
          RNG('ui.fontSize', '界面字号', 11, 18, 0.5, 'px', (v) => v),
          RNG('ui.bubbleDuration', '气泡停留', 2, 60, 1, 's', (v) => v),
          SW('ui.dockVisible', '显示快捷按钮条'),
          SW('ui.showStatusHud', '显示状态浮层'),
        ],
      },
    ],
  },

  {
    id: 'gaze',
    label: '视线',
    groups: [
      {
        id: 'follow',
        label: '跟随',
        fields: [
          SW('gaze.enabled', '开启视线跟随'),
          RNG('gaze.intensity', '跟随强度', 0, 2, 0.01, '×', (v) => v.toFixed(2)),
          RNG('gaze.eyeAmount', '眼球幅度', 0, 1.5, 0.01, '×', (v) => v.toFixed(2)),
          RNG('gaze.eyeMax', '眼球上限', 0.1, 1, 0.01, '', (v) => v.toFixed(2)),
          RNG('gaze.headAmount', '头部幅度', 0, 1.5, 0.01, '×', (v) => v.toFixed(2)),
          RNG('gaze.headYawMax', '左右转角', 0, 45, 0.5, '°', (v) => v),
          RNG('gaze.headPitchMax', '上下俯仰', 0, 30, 0.5, '°', (v) => v),
          RNG('gaze.bodyAmount', '身体幅度', 0, 1, 0.01, '×', (v) => v.toFixed(2)),
          RNG('gaze.bodyMax', '身体转角', 0, 10, 0.5, '°', (v) => v),
          RNG('gaze.smoothing', '跟随速度', 0.01, 1, 0.01, '', (v) => v.toFixed(2)),
        ],
      },
      {
        id: 'natural',
        label: '自然感',
        fields: [
          SW('gaze.distanceFalloff', '远距离衰减'),
          NUM('gaze.maxDistance', '衰减距离', { step: 50, min: 200, max: 4000, unit: 'px' }),
          SW('gaze.idleDrift', '自然漂移'),
          RNG('gaze.driftAmount', '漂移幅度', 0, 1, 0.01, '', (v) => v.toFixed(2)),
          RNG('gaze.driftSpeed', '漂移速度', 0.05, 2, 0.05, '×', (v) => v.toFixed(2)),
          SW('gaze.saccade', '微眼跳'),
          RNG('gaze.saccadeMin', '最短间隔', 0.5, 10, 0.1, 's', (v) => v.toFixed(1)),
          RNG('gaze.saccadeMax', '最长间隔', 1, 20, 0.1, 's', (v) => v.toFixed(1)),
          SW('gaze.invertX', '水平反向'),
          SW('gaze.invertY', '垂直反向'),
          RESULT('rig-ranges'),
        ],
      },
    ],
  },

  {
    id: 'idle',
    label: '动作',
    groups: [
      {
        id: 'blink',
        label: '眨眼',
        fields: [
          SW('idle.autoBlink', '自动眨眼'),
          RNG('idle.blinkMin', '最短间隔', 0.6, 12, 0.1, 's', (v) => v.toFixed(1)),
          RNG('idle.blinkMax', '最长间隔', 1, 20, 0.1, 's', (v) => v.toFixed(1)),
          RNG('idle.blinkDuration', '眨眼时长', 0.05, 0.4, 0.005, 'ms', (v) => Math.round(v * 1000)),
          RNG('idle.doubleBlinkChance', '连眨概率', 0, 1, 0.01, '%', (v) => Math.round(v * 100)),
        ],
      },
      {
        id: 'body',
        label: '呼吸与物理',
        fields: [
          SW('idle.breath', '呼吸起伏'),
          RNG('idle.breathSpeed', '呼吸速度', 0.2, 3, 0.05, '×', (v) => v.toFixed(2)),
          SW('idle.physics', '物理演算'),
        ],
      },
      {
        id: 'motions',
        label: '随机动作',
        fields: [
          SW('idle.autoMotion', '空闲时随机播放动作'),
          RNG('idle.motionMin', '最短间隔', 5, 120, 1, 's', (v) => v),
          RNG('idle.motionMax', '最长间隔', 6, 240, 1, 's', (v) => v),
          RNG('idle.motionSpeed', '播放速度', 0.2, 3, 0.05, '×', (v) => v.toFixed(2)),
          BTNS('motion-test', [
            { id: 'motion-nod', label: '点头' },
            { id: 'motion-shake', label: '摇头' },
          ]),
          RESULT('motion-result'),
        ],
      },
    ],
  },

  {
    id: 'petting',
    label: '抚摸',
    groups: [
      {
        id: 'interact',
        label: '互动',
        fields: [
          SW('petting.enabled', '开启抚摸'),
          RNG('petting.minStrokeDistance', '触发灵敏度', 1, 30, 1, 'px', (v) => v),
          SW('petting.hearts', '冒爱心'),
          RNG('petting.heartRate', '爱心密度', 0.2, 3, 0.1, '×', (v) => v.toFixed(1)),
          SW('petting.squint', '舒服地眯眼'),
          SW('petting.reactions', '动作反馈'),
          SW('petting.speakLines', '台词反馈'),
        ],
      },
      {
        id: 'lines',
        label: '台词',
        fields: [
          LINES('petting.reactLines', '抚摸中', 6),
          LINES('petting.greetLines', '开始抚摸', 3),
          LINES('petting.leaveLines', '停止抚摸', 3),
        ],
      },
    ],
  },

  {
    id: 'chat',
    label: '对话',
    groups: [
      {
        id: 'api',
        label: '接口',
        fields: [
          SEL('chat.baseUrl', '接口地址', CHAT_PRESETS, { editable: true }),
          PWD('chat.apiKey', 'API Key'),
          TXT('chat.model', '模型'),
          TXT('chat.extraHeaders', '额外请求头', { wide: true }),
          BTNS('chat-test', [
            { id: 'test-llm', label: '测试连接' },
            { id: 'list-models', label: '获取模型列表' },
          ]),
          RESULT('llm-result'),
        ],
      },
      {
        id: 'generate',
        label: '生成参数',
        fields: [
          RNG('chat.temperature', '温度', 0, 2, 0.05, '', (v) => v.toFixed(2)),
          RNG('chat.topP', 'Top P', 0.1, 1, 0.01, '', (v) => v.toFixed(2)),
          NUM('chat.maxTokens', '最大回复长度', { step: 32, min: 32, max: 8192 }),
          SW('chat.stream', '流式输出'),
          NUM('chat.timeoutMs', '超时时间', { step: 5000, min: 5000, max: 600000, unit: 'ms' }),
          NUM('chat.maxHistory', '记忆轮数', { step: 2, min: 0, max: 100 }),
        ],
      },
      {
        id: 'persona',
        label: '人格',
        fields: [
          TXT('chat.personaName', '名字'),
          AREA('chat.systemPrompt', '系统提示词', 12),
          SW('chat.autoGreeting', '启动时打招呼'),
          TXT('chat.greeting', '打招呼内容', { wide: true }),
          SW('chat.sendOnEnter', 'Enter 直接发送'),
          SW('chat.emotionTags', '解析情绪标签'),
          SW('chat.showThinking', '显示思考中'),
        ],
      },
    ],
  },

  {
    id: 'voice',
    label: '语音',
    groups: [
      {
        id: 'engine',
        label: '引擎',
        fields: [
          { type: 'presets', id: 'voice-presets', label: '声线预设' },
          RESULT('preset-result'),
          SW('voice.ttsEnabled', '开启语音朗读'),
          SEL('voice.ttsProvider', '语音引擎', PROVIDER_OPTIONS),
          RNG('voice.volume', '播放音量', 0, 1, 0.01, '%', (v) => Math.round(v * 100)),
          SW('voice.autoSpeak', '回复后自动朗读'),
          SW('voice.speakOnPet', '抚摸时说话'),
          BTNS('tts-test', [
            { id: 'test-tts', label: '试听' },
            { id: 'test-tts-ja', label: '日语' },
            { id: 'test-tts-zh', label: '中文' },
            { id: 'refresh-tts', label: '刷新状态' },
            { id: 'reset-tts', label: '清除降级记录' },
          ]),
          RESULT('tts-status'),
          RESULT('tts-result'),
        ],
      },
      {
        id: 'language',
        label: '语言',
        fields: [SEL('voice.languageMode', '朗读语言', LANG_OPTIONS), RESULT('lang-status')],
      },
      {
        id: 'pitch',
        label: '声线',
        fields: [
          RNG('voice.pitchShift', '音调', 0.6, 1.6, 0.01, '%', (v) => `${v.toFixed(2)} (${v >= 1 ? '+' : ''}${Math.round((v - 1) * 100)})`),
          {
            type: 'chips',
            key: 'voice.pitchShift',
            label: '预设',
            options: [
              { value: 0.85, label: '低沉' },
              { value: 0.95, label: '沉稳' },
              { value: 1.0, label: '原声' },
              { value: 1.1, label: '清亮' },
              { value: 1.18, label: '少女' },
              { value: 1.38, label: '童声' },
            ],
          },
        ],
      },
      {
        id: 'gptsovits',
        label: 'GPT-SoVITS',
        fields: [
          INFO(
            'gsv-info',
            '想用常驻模型：把微调好的 GPT 权重与 SoVITS 权重分别放进 GPT_weights_v2ProPlus / SoVITS_weights_v2ProPlus，点「自动检测」即可自动填好路径。没有微调权重时，可以先用「参考音频」模式做零样本克隆。'
          ),
          TXT('voice.gptsovits.root', '安装目录', { wide: true }),
          SW('voice.gptsovits.autoStart', '启动桌宠时自动运行'),
          BTNS('gsv-actions', [
            { id: 'scan-gsv', label: '自动检测' },
            { id: 'start-gsv', label: '立即启动' },
          ]),
          RESULT('gsv-result'),
          TXT('voice.gptsovits.baseUrl', '服务地址', { wide: true }),
          SEL('voice.gptsovits.mode', '参考方式', [
            { value: 'weights', label: '常驻模型（微调好的权重）' },
            { value: 'audio', label: '参考音频（零样本克隆）' },
          ]),
          TXT('voice.gptsovits.gptWeights', 'GPT 权重路径', { wide: true }),
          TXT('voice.gptsovits.sovitsWeights', 'SoVITS 权重路径', { wide: true }),
          TXT('voice.gptsovits.refAudio', '参考音频路径', { wide: true }),
          TXT('voice.gptsovits.promptText', '参考音频文本', { wide: true }),
          SEL('voice.gptsovits.promptLang', '参考语言', [
            { value: 'zh', label: '中文' },
            { value: 'ja', label: '日本語' },
            { value: 'en', label: 'English' },
            { value: 'ko', label: '한국어' },
            { value: 'yue', label: '粵語' },
          ]),
          SEL('voice.gptsovits.textLang', '合成语言', [
            { value: 'zh', label: '中文' },
            { value: 'ja', label: '日本語' },
            { value: 'en', label: 'English' },
            { value: 'ko', label: '한국어' },
            { value: 'yue', label: '粵語' },
            { value: 'auto', label: '中英混合自动切分' },
            { value: 'auto_yue', label: '粤英混合自动切分' },
            { value: 'all_ja', label: '日语优先' },
            { value: 'all_zh', label: '中文优先' },
          ]),
          SEL('voice.gptsovits.splitMethod', '切分方式', [
            { value: 'cut0', label: '不切分' },
            { value: 'cut1', label: '四句一切' },
            { value: 'cut2', label: '50字一切' },
            { value: 'cut3', label: '按中文句号' },
            { value: 'cut4', label: '按英文句号' },
            { value: 'cut5', label: '按标点（推荐）' },
          ]),
        ],
      },
      {
        id: 'openai',
        label: '在线 TTS 接口',
        fields: [
          TXT('voice.openaiBaseUrl', '接口地址', { wide: true }),
          PWD('voice.openaiApiKey', 'API Key'),
          TXT('voice.openaiModel', '模型'),
          INFO('openai-info', '需兼容 POST /audio/speech。未单独填 Key 时复用「对话」的 API Key。'),
          { key: 'voice.languageProfiles.zh-CN.openai', label: '中文音色', type: 'select', options: [] },
          { key: 'voice.languageProfiles.ja-JP.openai', label: '日语音色', type: 'select', options: [] },
          { key: 'voice.languageProfiles.en-US.openai', label: '英语音色', type: 'select', options: [] },
        ],
      },
      {
        id: 'lipsync',
        label: '口型同步',
        fields: [
          SW('voice.lipSync', '口型同步'),
          RNG('voice.lipSyncGain', '灵敏度', 0.1, 5, 0.1, '×', (v) => v.toFixed(1)),
          RNG('voice.lipSyncSmoothing', '平滑', 0.02, 1, 0.01, '', (v) => v.toFixed(2)),
          RNG('voice.mouthMax', '最大张嘴', 0.05, 1, 0.01, '%', (v) => Math.round(v * 100)),
        ],
      },
      {
        id: 'stt',
        label: '语音输入',
        fields: [
          SW('voice.sttEnabled', '开启语音输入'),
          TXT('voice.sttBaseUrl', '识别接口地址', { wide: true }),
          PWD('voice.sttApiKey', 'API Key'),
          TXT('voice.sttModel', '识别模型'),
          SEL('voice.sttLanguage', '识别语言', STT_LANG_OPTIONS),
          NUM('voice.sttMaxSeconds', '最长录音', { step: 5, min: 3, max: 300, unit: 's' }),
          SW('voice.sttAutoSend', '识别后自动发送'),
          TXT('voice.sttHotkey', '全局快捷键'),
          BTNS('stt-actions', [{ id: 'apply-hotkey', label: '应用快捷键' }]),
          RESULT('stt-result'),
        ],
      },
    ],
  },

  PARAM_SECTION,

  {
    id: 'locks',
    label: '锁定',
    groups: [
      {
        id: 'locked',
        label: '已锁定',
        fields: [RESULT('lock-list'), BTNS('lock-actions', [{ id: 'unlock-all', label: '全部解锁' }])],
      },
    ],
  },

  {
    id: 'about',
    label: '关于',
    groups: [{ id: 'about', label: '关于', fields: [{ type: 'about' }] }],
  },
]

/** Flat list of every field that maps to a settings path. */
export const ALL_FIELDS = SETTINGS_TREE.flatMap((section) =>
  section.groups.flatMap((g) => g.fields.filter((f) => f.key))
)
