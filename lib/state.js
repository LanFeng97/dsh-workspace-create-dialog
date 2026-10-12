/**
 * 插件状态的持久化层。
 *
 * 只存两个字段，都直接服务于体验：
 * - `baseDir`——「新建位置」，用户在创建窗口里设置过就归他管；
 * - `lastDir`——上一次原生对话框停在哪个目录，让「延续上次目录」跨重启成立。
 *
 * 文件损坏或字段缺失按空状态处理：一个坏文件绝不能让「创建工作区」按钮失灵。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 版本号写进文件，未来改结构时能识别旧格式。 */
const STATE_VERSION = 1

/**
 * 读取状态文件。
 * @param {string} file - 状态文件绝对路径。
 * @returns {Promise<{version: number, baseDir: string, lastDir: string, updatedAt: number}>} 状态对象。
 */
export async function readState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: STATE_VERSION,
        baseDir: typeof parsed.baseDir === 'string' ? parsed.baseDir : '',
        lastDir: typeof parsed.lastDir === 'string' ? parsed.lastDir : '',
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      }
    }
  } catch {
    // 首次运行或文件损坏：都退化成空状态
  }
  return { version: STATE_VERSION, baseDir: '', lastDir: '', updatedAt: 0 }
}

/**
 * 原子写入状态文件：先写临时文件再改名，避免写到一半崩溃留下半个 JSON。
 * @param {string} file - 状态文件绝对路径。
 * @param {{baseDir: string, lastDir: string}} state - 要落盘的状态。
 * @returns {Promise<void>} 写完后 resolve。
 */
export async function writeState(file, state) {
  const payload = {
    version: STATE_VERSION,
    updatedAt: Date.now(),
    baseDir: typeof state.baseDir === 'string' ? state.baseDir : '',
    lastDir: typeof state.lastDir === 'string' ? state.lastDir : '',
  }
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  // 显式 utf8：不依赖系统代码页，否则中文路径会以乱码落盘
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
  state.updatedAt = payload.updatedAt
}
