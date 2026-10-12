/**
 * dsh-workspace-create-dialog 的宿主半区。
 *
 * 职责只有三件，都是浏览器做不到的事：
 * 1. 解析「新建位置」——只填名称时工作区文件夹建在哪。四层优先顺序见
 *    lib/base-dir.js；这里负责取注册表快照、算兜底路径、落盘，并允许用户在
 *    创建窗口里改（改完归他管，配置只作为安装时的初始值）；
 * 2. 建目录——注册表只接受已存在的目录（`dsh-workspace` 明确拒绝不存在的路径）；
 * 3. 开原生选择窗口——自己调的 IFileDialog 才能把「上次所在的目录」作为起始
 *    位置传进去，这也是本插件相对 harness 自带对话框的关键差别。窗口标题由
 *    浏览器半区按界面语言传下来，不再是写死的中文。
 *
 * 所有路由都套同一套回环围栏（lib/guard.js），因为它们都能在宿主机器上产生
 * 副作用。
 */
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isLocalRequest } from './guard.js'
import { readState, writeState } from './state.js'
import { joinName, validateName } from './name.js'
import { isAbsoluteDir, resolveBaseDir } from './base-dir.js'
import { DIALOG_TITLE, pickFolder } from './pick-folder.js'

/** 稳定插件名。 */
export const name = 'workspace-create-dialog'

/** 需要的宿主服务：只有路由器。工作区注册表按需 ctx.get，不作为硬依赖。 */
export const inject = ['webServer']

/**
 * 路由路径（浏览器半区镜像同一批字面量，两边改动必须同步）。
 * @type {{config: string, createFolder: string, pickFolder: string, baseDir: string}}
 */
export const ROUTES = {
  config: '/api/dsh-workspace-create/config',
  createFolder: '/api/dsh-workspace-create/create-folder',
  pickFolder: '/api/dsh-workspace-create/pick-folder',
  baseDir: '/api/dsh-workspace-create/base-dir',
}

/** 请求体上限：本插件最大的请求体只有一个目录名或标题，1 KiB 足够。 */
const MAX_BODY_BYTES = 1024

/** 原生窗口标题的长度上限（传给 C# 的 LPWSTR，正常文案远小于它）。 */
const MAX_TITLE_LENGTH = 80

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {object} body - 响应体。
 * @returns {void}
 */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * 读一个上限受控的 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @returns {Promise<object | null>} 解析出的对象；空、超限或非法时返回 null。
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 清洗浏览器传来的窗口标题。
 * @param {unknown} raw - 请求体里的 title。
 * @returns {string} 可安全交给 C# 的标题；非法时回退到内置标题。
 */
function sanitizeTitle(raw) {
  if (typeof raw !== 'string') return DIALOG_TITLE
  // 去掉控制字符与换行，避免任何注入到对话框文本里的可能
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (cleaned === '') return DIALOG_TITLE
  return cleaned.slice(0, MAX_TITLE_LENGTH)
}

/**
 * 插件入口。
 * @param {object} ctx - 宿主插件上下文（webServer，可选 workspaceRegistry）。
 * @param {object} [config] - 插件配置。
 * @param {string} [config.baseDir] - 安装时的「新建位置」初始值（界面可覆盖）。
 * @param {string} [config.stateFile] - 状态文件路径覆盖。
 * @returns {void}
 */
export function apply(ctx, config) {
  const configuredBaseDir = typeof config?.baseDir === 'string' ? config.baseDir.trim() : ''
  const stateFile = typeof config?.stateFile === 'string' && config.stateFile.trim() !== ''
    ? config.stateFile.trim()
    : join(process.env.DSH_HOME ?? '', 'storages', 'dsh-workspace-create-dialog', 'state.json')

  /** 状态在内存里保持一份；第一次用到时才读盘，挂载不因文件 IO 失败而失败。 */
  const state = { version: 1, baseDir: '', lastDir: '', updatedAt: 0 }
  let loaded = false
  /** 原生对话框是模态的单例：同时只允许一个在屏上。 */
  let picking = false
  /** 首次解析「新建位置」只做一次，避免并发请求各算一遍。 */
  let baseDirResolved

  /**
   * 惰性加载状态。
   * @returns {Promise<object>} 状态对象。
   */
  const ensureState = async () => {
    if (!loaded) {
      const disk = await readState(stateFile)
      state.baseDir = disk.baseDir
      state.lastDir = disk.lastDir
      state.updatedAt = disk.updatedAt
      loaded = true
    }
    return state
  }

  /**
   * 落盘当前状态。
   * @returns {Promise<void>} 写完或失败后 resolve（失败只警告）。
   */
  const persist = async () => {
    try {
      await writeState(stateFile, state)
    } catch (error) {
      // 记不住设置只是「下次要重设一遍」，不能让本次创建失败
      ctx.logger?.warn?.(`[workspace-create-dialog] 状态落盘失败：${String(error)}`)
    }
  }

  /**
   * 宿主兜底路径：官方约定 Host 把工作区放在 `<Documents>/deepseek-harness` 下。
   * @returns {string} 兜底目录。
   */
  const fallbackBaseDir = () => {
    const documents = join(homedir(), 'Documents')
    return existsSync(documents) ? join(documents, 'deepseek-harness') : join(homedir(), 'deepseek-harness')
  }

  /**
   * 读工作区注册表快照（用来找默认工作区所在的根目录）。
   * @returns {{path: string}[]} 工作区列表；服务不可用时为空数组。
   */
  const registryWorkspaces = () => {
    try {
      const registry = ctx.get('workspaceRegistry')
      const listed = registry?.list?.()
      return Array.isArray(listed) ? listed : []
    } catch {
      // 注册表不可用只是拿不到默认工作区，兜底路径仍然有效
      return []
    }
  }

  /**
   * 取「新建位置」，首次调用时解析并落盘（安装后的初始值就此固定下来）。
   *
   * 落盘值必须仍是一个绝对路径才采信：相对路径会被当成「相对宿主当前目录」，
   * 从而在莫名其妙的地方建目录。不合法就当作没设置，重新解析并覆盖回去。
   * @returns {Promise<string>} 绝对目录。
   */
  const ensureBaseDir = async () => {
    const current = await ensureState()
    if (current.baseDir !== '' && isAbsoluteDir(current.baseDir)) return current.baseDir
    if (baseDirResolved === undefined) {
      baseDirResolved = (async () => {
        const resolved = resolveBaseDir({
          saved: '',
          configured: configuredBaseDir,
          workspaces: registryWorkspaces(),
          fallback: fallbackBaseDir(),
        })
        current.baseDir = resolved
        await persist()
        return resolved
      })()
    }
    return await baseDirResolved
  }

  /**
   * 记住这次停在哪个目录。
   * @param {string} dir - 目录绝对路径。
   * @returns {Promise<void>} 落盘后 resolve。
   */
  const rememberDir = async (dir) => {
    state.lastDir = dir
    await persist()
  }

  const routes = [
    {
      kind: 'exact',
      path: ROUTES.config,
      handler: async (req, res) => {
        if (!isLocalRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
        const current = await ensureState()
        writeJson(res, 200, { ok: true, baseDir: await ensureBaseDir(), lastDir: current.lastDir })
      },
    },
    {
      kind: 'exact',
      path: ROUTES.baseDir,
      handler: async (req, res) => {
        if (!isLocalRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
        const body = await readJsonBody(req)
        const requested = typeof body?.path === 'string' ? body.path.trim() : ''
        if (!isAbsoluteDir(requested)) return writeJson(res, 400, { ok: false, error: 'not-absolute' })
        try {
          // 位置还不存在就先建出来：用户选的是「以后建在这里」，不该等到第一次创建才失败
          await mkdir(requested, { recursive: true })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger?.warn?.(`[workspace-create-dialog] 新建位置不可用 ${requested}：${message}`)
          return writeJson(res, 500, { ok: false, error: message })
        }
        const current = await ensureState()
        current.baseDir = requested
        baseDirResolved = Promise.resolve(requested)
        await persist()
        writeJson(res, 200, { ok: true, baseDir: requested })
      },
    },
    {
      kind: 'exact',
      path: ROUTES.createFolder,
      handler: async (req, res) => {
        if (!isLocalRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
        const body = await readJsonBody(req)
        const checked = validateName(body?.name)
        if (!checked.ok) return writeJson(res, 400, { ok: false, error: checked.reason })
        const baseDir = await ensureBaseDir()
        if (baseDir === '') return writeJson(res, 500, { ok: false, error: 'no-base-dir' })
        const target = joinName(baseDir, checked.name)
        try {
          // recursive：新建位置本身不存在时一并建出来
          await mkdir(target, { recursive: true })
        } catch (error) {
          // 同名文件占位是最常见的失败，直接把宿主的话原样带回去给用户看
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger?.warn?.(`[workspace-create-dialog] 建目录失败 ${target}：${message}`)
          return writeJson(res, 500, { ok: false, error: message })
        }
        writeJson(res, 200, { ok: true, path: target, name: checked.name })
      },
    },
    {
      kind: 'exact',
      path: ROUTES.pickFolder,
      handler: async (req, res) => {
        if (!isLocalRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
        if (picking) return writeJson(res, 409, { ok: false, error: 'picker-busy' })
        const body = await readJsonBody(req)
        picking = true
        try {
          const current = await ensureState()
          // 起始位置优先用上次所在的目录；没有记录时落在新建位置，用户一眼就能看到自己的工作区
          const initialDir = current.lastDir !== '' ? current.lastDir : await ensureBaseDir()
          const { path } = await pickFolder({ initialDir, title: sanitizeTitle(body?.title) })
          if (path === null) return writeJson(res, 200, { ok: true, path: null })
          // 记下用户这次停在哪儿（含他一路翻进去的子目录），下次从同一处开始
          await rememberDir(path)
          writeJson(res, 200, { ok: true, path })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger?.warn?.(`[workspace-create-dialog] 原生选择器失败：${message}`)
          writeJson(res, 500, { ok: false, error: message })
        } finally {
          picking = false
        }
      },
    },
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'workspace-create-dialog: routes')
}
