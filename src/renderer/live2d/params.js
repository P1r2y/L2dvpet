/**
 * Parameter contract for models produced by **psd2live**.
 *
 * Source of truth: `psd2live/docs/zh/spec/DEFORMER_AND_PARAMETER_SPEC.md`
 * ("Cubism 标准参数清单与映射表") and `core/MotionGenerator.kt`.
 *
 * Two things matter to the runtime:
 *
 *  1. **The ranges are not the Cubism defaults.** psd2live bakes a 9-pose face
 *     lat/long grid keyed at ParamAngleX ∈ {−45, 0, +45} and
 *     ParamAngleY ∈ {−30, 0, +30}, so head yaw runs to ±45° (Cubism's usual
 *     sample value is ±30) and the body angles are ±10°.
 *
 *  2. **Which parameters the authored motions already drive.** The generated
 *     sidecars (idle / blink / nod / shake) animate AngleX, AngleY, AngleZ,
 *     BodyAngleX, BodyAngleY and EyeLOpen/EyeROpen. The runtime must *compose*
 *     with those, not overwrite them — otherwise a nod or a shake is flattened
 *     to nothing the moment the gaze writes ParamAngleY.
 *
 * The values below are only fallbacks: at runtime the real min/max are read
 * straight out of the loaded Cubism model.
 */

/** `[min, max]` per parameter, as authored by psd2live. */
export const PARAM_RANGES = {
  ParamAngleX: [-45, 45],
  ParamAngleY: [-30, 30],
  ParamAngleZ: [-30, 30],
  ParamBodyAngleX: [-10, 10],
  ParamBodyAngleY: [-10, 10],
  ParamBodyAngleZ: [-10, 10],
  ParamEyeLOpen: [0, 1],
  ParamEyeROpen: [0, 1],
  ParamEyeBallX: [-1, 1],
  ParamEyeBallY: [-1, 1],
  ParamEyeBallForm: [-1, 1],
  ParamBrowLY: [-1, 1],
  ParamBrowRY: [-1, 1],
  ParamMouthForm: [-1, 1],
  ParamMouthOpenY: [0, 1],
  ParamBreath: [0, 1],
  ParamHairFront: [-1, 1],
  ParamHairBack: [-1, 1],
}

/**
 * How the runtime is allowed to touch each parameter.
 *
 *  - `add`     the authored motions own this value; we contribute an offset
 *              (this is what Cubism's own focus controller does).
 *  - `scale`   we multiply whatever the motion produced (used for eye openness
 *              so a nod's eye-dip survives our blink).
 *  - `set`     nothing else writes it; we own it outright.
 *  - `leave`   physics / the engine owns it; we must not touch it.
 */
export const PARAM_OWNERSHIP = {
  ParamAngleX: 'add',
  ParamAngleY: 'add',
  ParamAngleZ: 'add',
  ParamBodyAngleX: 'add',
  ParamBodyAngleY: 'add',
  ParamBodyAngleZ: 'set',
  ParamEyeLOpen: 'scale',
  ParamEyeROpen: 'scale',
  ParamEyeBallX: 'set',
  ParamEyeBallY: 'set',
  // PhysicsEyeJelly drives this from ParamEyeL/ROpen; we must leave it alone.
  ParamEyeBallForm: 'leave',
  ParamBrowLY: 'set',
  ParamBrowRY: 'set',
  ParamMouthForm: 'set',
  ParamMouthOpenY: 'set',
  // The idle motion owns the breath cycle (0↔1 over 6 s).
  ParamBreath: 'leave',
  ParamHairFront: 'leave',
  ParamHairBack: 'leave',
}

/** Natural neutral values, used when a parameter is missing from a model. */
export const PARAM_NEUTRAL = {
  ParamAngleX: 0,
  ParamAngleY: 0,
  ParamAngleZ: 0,
  ParamBodyAngleX: 0,
  ParamBodyAngleY: 0,
  ParamBodyAngleZ: 0,
  ParamEyeLOpen: 1,
  ParamEyeROpen: 1,
  ParamEyeBallX: 0,
  ParamEyeBallY: 0,
  ParamEyeBallForm: 0,
  ParamBrowLY: 0,
  ParamBrowRY: 0,
  ParamMouthForm: 0,
  ParamMouthOpenY: 0,
  ParamBreath: 0,
  ParamHairFront: 0,
  ParamHairBack: 0,
}

/**
 * Motion groups psd2live generates, with the parameter excursions they contain.
 * Reported by `MotionGenerator.kt`; useful for sanity-checking amplitudes and
 * for telling the user what a reaction should look like.
 */
export const GENERATED_MOTIONS = {
  Idle: { duration: 6.0, loop: true, drives: ['ParamBreath', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamEyeLOpen', 'ParamEyeROpen'] },
  Blink: { duration: 1.2, loop: false, drives: ['ParamEyeLOpen', 'ParamEyeROpen'] },
  Nod: { duration: 2.0, loop: false, drives: ['ParamAngleY', 'ParamBodyAngleY', 'ParamEyeLOpen', 'ParamEyeROpen'] },
  Shake: { duration: 2.0, loop: false, drives: ['ParamAngleX', 'ParamBodyAngleX', 'ParamAngleZ'] },
}

/**
 * The 18 parameters psd2live generates, grouped exactly the way its `cdi3.json`
 * declares them. `mode` records who drives each one by default, which is what
 * the manual-override panel offers to take over.
 */
export const PARAM_CATALOG = [
  {
    group: 'ParamGroupFace',
    label: '面部',
    params: [
      { id: 'ParamAngleX', name: '角度 X', owner: '动作曲线 + 视线（叠加）' },
      { id: 'ParamAngleY', name: '角度 Y', owner: '动作曲线 + 视线（叠加）' },
      { id: 'ParamAngleZ', name: '角度 Z', owner: 'idle 摇摆 ±2° + 视线侧倾' },
    ],
  },
  {
    group: 'ParamGroupEyes',
    label: '眼睛',
    params: [
      { id: 'ParamEyeLOpen', name: '左眼开合', owner: '眨眼 × 动作曲线' },
      { id: 'ParamEyeROpen', name: '右眼开合', owner: '眨眼 × 动作曲线' },
      { id: 'ParamEyeBallX', name: '眼球 X', owner: '视线跟随' },
      { id: 'ParamEyeBallY', name: '眼球 Y', owner: '视线跟随' },
      { id: 'ParamEyeBallForm', name: '果冻眼', owner: '物理 PhysicsEyeJelly（scale 0.32）' },
    ],
  },
  {
    group: 'ParamGroupBrows',
    label: '眉毛',
    params: [
      { id: 'ParamBrowLY', name: '左眉 Y', owner: '情绪' },
      { id: 'ParamBrowRY', name: '右眉 Y', owner: '情绪' },
    ],
  },
  {
    group: 'ParamGroupMouth',
    label: '嘴巴',
    params: [
      { id: 'ParamMouthForm', name: '嘴型', owner: '情绪（微笑 / 悲伤）' },
      { id: 'ParamMouthOpenY', name: '嘴巴开合', owner: '语音口型同步' },
    ],
  },
  {
    group: 'ParamGroupBody',
    label: '身体',
    params: [
      { id: 'ParamBodyAngleX', name: '身体 X', owner: 'idle ∓1.2° + 视线（叠加）' },
      { id: 'ParamBodyAngleY', name: '身体 Y', owner: 'nod 动作 ∓4° + 视线（叠加）' },
      { id: 'ParamBodyAngleZ', name: '身体 Z', owner: '情绪侧倾' },
      { id: 'ParamBreath', name: '呼吸', owner: 'idle 曲线 0↔1' },
    ],
  },
  {
    group: 'ParamGroupPhysics',
    label: '物理',
    params: [
      { id: 'ParamHairFront', name: '前发摆动', owner: '物理 PhysicsHairFront（1.522）' },
      { id: 'ParamHairBack', name: '后发摆动', owner: '物理 PhysicsHairBack（2.061）' },
    ],
  },
]

/** Flat id → {name, group label, owner} lookup. */
export const PARAM_INFO = (() => {
  const out = {}
  for (const g of PARAM_CATALOG) {
    for (const p of g.params) out[p.id] = { ...p, group: g.label, groupId: g.group }
  }
  return out
})()

/** Parameters whose value the physics step consumes (must be set before it runs). */
export const PHYSICS_INPUTS = ['ParamEyeLOpen', 'ParamEyeROpen']

/** Every psd2live parameter id, in catalog order. */
export const PARAM_IDS = PARAM_CATALOG.flatMap((g) => g.params.map((p) => p.id))

export function rangeOf(id) {
  return PARAM_RANGES[id] || [-1, 1]
}

export function ownershipOf(id) {
  return PARAM_OWNERSHIP[id] || 'set'
}
