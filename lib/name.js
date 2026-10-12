/**
 * 名称与路径的纯函数层。
 *
 * 单独成文件的原因：这一层没有 IO、没有 DSH 依赖，因此 tools/selftest.mjs 可以
 * 直接 import 来验证「哪些名字不能当目录名」这条规则，不需要启动宿主。
 */

/** 名称长度上限：留足余量，避免撞上 MAX_PATH 或某些工具的长度假设。 */
export const MAX_NAME_LENGTH = 64

/** Windows 文件名禁用字符（含控制字符）。 */
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/

/** Windows 保留设备名，不能作为目录名。 */
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 校验一个「工作区名称」能否作为单个目录段。
 *
 * 规则按 Windows 实现（本插件只在 Windows 上有原生选择器，但基底目录的创建
 * 本身跨平台）：拒绝空、过长、`.`/`..`、禁用字符、保留设备名，以及 Windows
 * 会静默去掉的结尾点。名称先 trim，因此结尾空格不可能出现，不需要单独判。
 * @param {unknown} raw - 用户输入。
 * @returns {{ok: true, name: string} | {ok: false, reason: string}} 结果。
 */
export function validateName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name === '') return { ok: false, reason: 'empty' }
  if (name.length > MAX_NAME_LENGTH) return { ok: false, reason: 'too-long' }
  if (name === '.' || name === '..') return { ok: false, reason: 'dot' }
  if (INVALID_CHARS.test(name)) return { ok: false, reason: 'invalid-char' }
  if (RESERVED_NAMES.test(name)) return { ok: false, reason: 'reserved' }
  if (name.endsWith('.')) return { ok: false, reason: 'trailing-dot' }
  return { ok: true, name }
}

/**
 * 把基底目录与名称拼成一个绝对路径。
 *
 * 只做字符串拼接，不依赖 node:path——浏览器半区也要用同一套判断（它自己带一份
 * 同义的小函数，因为 client bundle 不能 import 本文件）。
 * @param {string} baseDir - 基底目录（不带结尾分隔符也没关系）。
 * @param {string} name - 已校验的名称。
 * @returns {string} 目标路径。
 */
export function joinName(baseDir, name) {
  const base = baseDir.replace(/[\\/]+$/, '')
  return `${base}\\${name}`
}

/**
 * 取路径最后一段（`D:\a\b\` → `b`）。
 *
 * 盘符根 `D:\` 只剩盘符本身（`D:`）——它同时是「这个目录叫什么」的合理答案。
 * @param {string} path - 任意路径。
 * @returns {string} 最后一段；空输入返回空串。
 */
export function lastSegment(path) {
  if (typeof path !== 'string') return ''
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}
