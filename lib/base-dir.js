/**
 * 「新建位置」的解析与校验。
 *
 * 这个文件回答一个问题：只填名称、不选文件夹时，工作区文件夹该建在哪里？
 * 早先的版本把答案写死成开发机上的一个固定路径，那对别人是坏的：没有那个盘符
 * 就直接报错，有那个盘符就在别人机器上凭空造目录。现在它按四层优先顺序解析，
 * 且**允许用户在创建窗口里改**：
 *
 * 1. `saved`——用户在界面上设置过的位置（落盘，优先级最高，改了就归他管）；
 * 2. `configured`——profile patch 里的 `baseDir`（安装时的初始值）；
 * 3. 注册表里默认工作区（固定目录名 `default-workspace`）的父目录——也就是
 *    「默认工作区所在的根目录」，新增工作区与它同级，最符合直觉；
 * 4. `fallback`——宿主算出来的兜底路径（官方约定是 `<Documents>/deepseek-harness`）。
 *
 * 这里只做纯字符串判断，不碰文件系统，因此自测可以直接把四层顺序钉住。
 */

/** 默认工作区的固定目录名。由 Host 拥有，不随界面语言变化。 */
export const DEFAULT_WORKSPACE_DIRNAME = 'default-workspace'

/**
 * 取父目录。
 * @param {string} path - 绝对路径。
 * @returns {string} 父目录；盘符根（`C:\`）的父目录仍是它自己。
 */
export function parentOf(path) {
  if (typeof path !== 'string') return ''
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (index < 0) return trimmed
  const parent = trimmed.slice(0, index)
  // `C:\default-workspace` 的父目录是 `C:\`，而不是 `C:`
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
}

/**
 * 路径是否为一个绝对目录。
 *
 * 接受 Windows 盘符路径（`D:\x`、`D:/x`）、UNC 路径（`\\server\share`）与
 * POSIX 绝对路径（`/home/x`）；拒绝相对路径与 `C:foo` 这种盘符相对路径
 * （后者会被解析成「当前目录所在的盘」，是真实的踩坑点）。
 * @param {unknown} path - 待判断的路径。
 * @returns {boolean} 是否绝对。
 */
export function isAbsoluteDir(path) {
  if (typeof path !== 'string' || path.trim() === '') return false
  const value = path.trim()
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  if (/^\\\\[^\\/]/.test(value)) return true
  if (value.startsWith('/')) return true
  return false
}

/**
 * 按四层优先顺序解析「新建位置」。
 * @param {object} input - 解析输入。
 * @param {string} [input.saved] - 用户在界面上设置过的位置。
 * @param {string} [input.configured] - profile patch 里的初始值。
 * @param {{path: string}[]} [input.workspaces] - 工作区注册表快照。
 * @param {string} [input.fallback] - 兜底路径。
 * @returns {string} 解析结果（可能为空串——此时调用方应拒绝建目录）。
 */
export function resolveBaseDir(input = {}) {
  const saved = typeof input.saved === 'string' ? input.saved.trim() : ''
  if (saved !== '') return saved
  const configured = typeof input.configured === 'string' ? input.configured.trim() : ''
  if (configured !== '') return configured
  const workspaces = Array.isArray(input.workspaces) ? input.workspaces : []
  for (const workspace of workspaces) {
    const path = typeof workspace?.path === 'string' ? workspace.path : ''
    if (path === '') continue
    const trimmed = path.replace(/[\\/]+$/, '')
    const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
    const segment = index === -1 ? trimmed : trimmed.slice(index + 1)
    if (segment === DEFAULT_WORKSPACE_DIRNAME) return parentOf(path)
  }
  return typeof input.fallback === 'string' ? input.fallback.trim() : ''
}
