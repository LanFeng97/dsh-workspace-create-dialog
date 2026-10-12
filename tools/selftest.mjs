/**
 * 自测：不依赖 DSH 运行时，用 Node 直接跑。
 *
 * 覆盖四类真正会出错的点：
 * 1. 名称校验规则（哪些名字不能当目录名）；
 * 2. 原生选择器脚本的 COM 槽位顺序与 here-string 结构——顺序错了对话框会调错
 *    COM 方法，而且不会有任何报错，只会「选了文件夹却没反应」；
 * 3. 浏览器半区的注册结构——优先级、两个 slot、注入面（用一个假 ctx 真的跑一遍
 *    apply，而不是只看源码里有没有字符串）；
 * 4. 宿主半区的三条路由与浏览器半区的字面量是否一致，以及建目录路由的真实行为。
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { joinName, lastSegment, validateName } from '../lib/name.js'
import { DEFAULT_WORKSPACE_DIRNAME, isAbsoluteDir, parentOf, resolveBaseDir } from '../lib/base-dir.js'
import { buildScript, encodedCommand, powershellPath } from '../lib/pick-folder.js'
import * as host from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** 断言通过的用例数。 */
let passed = 0
/**
 * 跑一个用例。
 * @param {string} label - 用例名。
 * @param {() => void | Promise<void>} body - 用例体。
 * @returns {Promise<void>} 用例结束后 resolve。
 */
async function test(label, body) {
  await body()
  passed += 1
  console.log(`  ok  ${label}`)
}

/**
 * 造一个假的 HTTP 请求（async iterable，供 `for await` 读体）。
 * @param {object} [options] - 参数。
 * @param {string} [options.method] - HTTP 方法。
 * @param {object} [options.body] - JSON 请求体。
 * @param {object} [options.headers] - 额外的请求头。
 * @param {string} [options.remoteAddress] - 套接字远端地址。
 * @returns {object} 假请求。
 */
function fakeRequest({ method = 'GET', body, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  return Object.assign(stream, {
    method,
    headers: { host: '127.0.0.1:19387', ...headers },
    socket: { remoteAddress },
  })
}

/**
 * 造一个假的 HTTP 响应。
 * @returns {object} 假响应，带 `status` 与 `payload`。
 */
function fakeResponse() {
  return {
    status: 0,
    payload: null,
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.payload = text === undefined ? null : JSON.parse(text)
    },
  }
}

console.log('name.js：名称与路径规则')
await test('接受普通名称', () => {
  for (const raw of ['my-project', '插件开发', 'a', '  spaced  ', 'v1.2']) {
    const checked = validateName(raw)
    assert.equal(checked.ok, true, `${raw} 应被接受`)
  }
  assert.equal(validateName('  spaced  ').name, 'spaced', '首尾空格应被去掉')
  assert.equal(validateName('name ').name, 'name', '结尾空格被 trim 掉后仍然是合法名称')
})
await test('拒绝空、超长、点、禁用字符、保留名、结尾点空格', () => {
  const cases = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['x'.repeat(65), 'too-long'],
    ['.', 'dot'],
    ['..', 'dot'],
    ['a/b', 'invalid-char'],
    ['a\\b', 'invalid-char'],
    ['a:b', 'invalid-char'],
    ['a?b', 'invalid-char'],
    ['a*b', 'invalid-char'],
    ['a"b', 'invalid-char'],
    ['a<b', 'invalid-char'],
    ['a|b', 'invalid-char'],
    ['NUL', 'reserved'],
    ['com3', 'reserved'],
    ['name.', 'trailing-dot'],
    [42, 'empty'],
    [undefined, 'empty'],
  ]
  for (const [raw, reason] of cases) {
    const checked = validateName(raw)
    assert.equal(checked.ok, false, `${String(raw)} 应被拒绝`)
    assert.equal(checked.reason, reason, `${String(raw)} 的拒绝原因`)
  }
})
await test('拼接与取末段', () => {
  assert.equal(joinName('D:\\a\\b', 'c'), 'D:\\a\\b\\c')
  assert.equal(joinName('D:\\a\\b\\', 'c'), 'D:\\a\\b\\c', '结尾分隔符不该留下双斜杠')
  assert.equal(lastSegment('D:\\a\\b'), 'b')
  assert.equal(lastSegment('D:\\a\\b\\'), 'b')
  assert.equal(lastSegment('D:\\'), 'D:', '盘符根只剩下盘符本身')
  assert.equal(lastSegment('D:/a/b'), 'b', '正斜杠也要认')
})

console.log('base-dir.js：「新建位置」的解析与校验')
await test('绝对路径判定', () => {
  for (const value of ['D:\\Work', 'D:/Work', '\\\\server\\share', '/home/me']) {
    assert.equal(isAbsoluteDir(value), true, `${value} 应判为绝对`)
  }
  for (const value of ['relative\\path', 'C:Work', '', '   ', 42, undefined, '..\\up']) {
    assert.equal(isAbsoluteDir(value), false, `${String(value)} 应判为非绝对`)
  }
})
await test('父目录（含盘符根）', () => {
  assert.equal(parentOf('C:\\Users\\me\\Documents\\deepseek-harness\\default-workspace'), 'C:\\Users\\me\\Documents\\deepseek-harness')
  assert.equal(parentOf('C:\\Users\\me\\x\\'), 'C:\\Users\\me')
  assert.equal(parentOf('C:\\default-workspace'), 'C:\\', '盘符根不能退化成 C:')
  assert.equal(parentOf('D:\\a\\b'), 'D:\\a')
})
await test('四层优先顺序：界面设置 > 配置 > 默认工作区根目录 > 兜底', () => {
  const workspaces = [{ path: 'C:\\Users\\me\\Documents\\deepseek-harness\\default-workspace' }, { path: 'D:\\proj' }]
  const fallback = 'C:\\Users\\me\\Documents\\deepseek-harness'
  assert.equal(
    resolveBaseDir({ saved: 'E:\\saved', configured: 'E:\\config', workspaces, fallback }),
    'E:\\saved',
    '界面设置过就归用户管，压过配置',
  )
  assert.equal(
    resolveBaseDir({ configured: 'E:\\config', workspaces, fallback }),
    'E:\\config',
    '没设置过时用配置（安装时的初始值）',
  )
  assert.equal(
    resolveBaseDir({ workspaces, fallback }),
    'C:\\Users\\me\\Documents\\deepseek-harness',
    '都没有时取默认工作区所在的根目录',
  )
  assert.equal(resolveBaseDir({ workspaces: [{ path: 'D:\\proj' }], fallback }), fallback, '认不出默认工作区就用兜底')
  assert.equal(resolveBaseDir({}), '', '什么都没有时返回空串，由调用方拒绝建目录')
  assert.equal(DEFAULT_WORKSPACE_DIRNAME, 'default-workspace', '默认工作区的目录名由 Host 固定')
})

console.log('pick-folder.js：原生选择器脚本')
await test('编码命令能还原脚本', () => {
  const decoded = Buffer.from(encodedCommand(), 'base64').toString('utf16le')
  assert.equal(decoded, buildScript())
})
await test('C# 的 COM 方法与 vtable 槽位顺序一致', () => {
  const script = buildScript()
  // 声明顺序决定槽位：Show=3、SetOptions=9、SetFolder=12、SetTitle=17、GetResult=20
  const declarations = [
    ['Show', 'int Show(IntPtr parent);'],
    ['SetOptions', 'void SetOptions(uint fos);'],
    ['SetFolder', 'void SetFolder(IDshShellItem psi);'],
    ['SetTitle', 'void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);'],
    ['GetResult', 'void GetResult(out IDshShellItem ppsi);'],
  ]
  let cursor = -1
  for (const [name, text] of declarations) {
    const index = script.indexOf(text)
    assert.ok(index > 0, `缺少 ${name} 声明`)
    assert.ok(index > cursor, `${name} 的顺序必须在 vtable 里递增`)
    cursor = index
  }
  assert.ok(script.includes('void GetDisplayName(uint sigdnName'), 'IShellItem 的 GetDisplayName 位置必须与槽位 5 对齐')
  assert.ok(script.includes('SIGDN_FILESYSPATH = 0x80058000'), '取盘符路径的 SIGDN 必须是 FILESYSPATH')
  assert.ok(script.includes('FOS_PICKFOLDERS = 0x20'), '必须只选目录')
  assert.ok(script.includes('0x800704C7'), '取消必须按 HRESULT 识别，而不是当成错误')
})
await test('PowerShell here-string 结构正确', () => {
  const script = buildScript()
  assert.equal(script.split("$source = @'").length, 2, 'C# 必须包在单引号 here-string 里，且只有一个开标记')
  assert.equal(script.split("\n'@").length, 2, 'here-string 的闭合标记必须独立成行且只有一个')
  assert.ok(script.indexOf("$source = @'") < script.indexOf("\n'@"), '开标记必须在闭标记之前')
  assert.ok(script.includes('Add-Type -TypeDefinition $source'), '必须在内存里编译这段 C#')
  assert.ok(!script.includes('-OutputAssembly'), '不该落盘 DLL：省掉缓存文件的一整套故障模式')
  assert.ok(script.includes('[Console]::Out.Write($result)'), '结果经 stdout 回给宿主')
})
await test('PowerShell 路径', () => {
  assert.match(powershellPath(), /powershell\.exe$/i)
})

/**
 * 极简 React 替身：只实现函数组件跑得起来所需的部分，并让 `useState` 的状态
 * 跨 render 保留。够用来把「交互规则」当成真行为来验证，而不是只看源码文本。
 * @returns {object} 假 React 模块。
 */
function createReactStub() {
  let cursor = 0
  const states = []
  return {
    /** 每次 render 前重置 hook 游标，模拟 React 的调用顺序约定。 */
    __reset: () => {
      cursor = 0
    },
    /** 清空状态，等价于「换个组件实例重新挂载」，让每个用例互不串味。 */
    __remount: () => {
      cursor = 0
      states.length = 0
    },
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }),
    useState: (initial) => {
      const index = cursor
      cursor += 1
      if (states.length <= index) states[index] = initial
      const set = (value) => {
        states[index] = typeof value === 'function' ? value(states[index]) : value
      }
      return [states[index], set]
    },
    useEffect: () => {
      cursor += 1
    },
    useRef: (value) => ({ current: value }),
  }
}

/**
 * 深度遍历元素树。
 * @param {unknown} node - 元素、数组或普通属性值。
 * @param {(node: object) => void} visit - 命中元素时回调。
 * @returns {void}
 */
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (node === null || typeof node !== 'object') return
  if ('type' in node) visit(node)
  for (const value of Object.values(node.props ?? {})) walk(value, visit)
  walk(node.children, visit)
}

/**
 * 在元素树里找第一个满足条件的元素。
 * @param {unknown} tree - 元素树。
 * @param {(node: object) => boolean} predicate - 判据。
 * @returns {object | undefined} 找到的元素。
 */
function findOne(tree, predicate) {
  let found
  walk(tree, (node) => {
    if (found === undefined && predicate(node)) found = node
  })
  return found
}

/** 让所有挂起的 promise 回调跑完。 */
async function flush() {
  await new Promise((resolve) => {
    setImmediate(resolve)
  })
}

const reactStub = createReactStub()

console.log('client.js：注册结构（用假 ctx 真跑一遍 apply）')
/** 记录 apply 期间发生的一切。 */
const recorded = { injections: [], registrations: [], effects: [] }
const fakeCtx = {
  get: (name) => (name === 'workspaces' ? { create: () => {}, rename: () => {} } : undefined),
  effect: (body, label) => {
    recorded.effects.push(label)
    const dispose = body()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject: (name, callback) => {
      recorded.injections.push(name)
      const result = callback()
      // 生成器：把 yield 出来的 disposer 收起来（原生 native 占位者也是这个用法）
      if (result !== null && typeof result === 'object' && typeof result[Symbol.iterator] === 'function') {
        for (const dispose of result) void dispose
      }
      return () => {}
    },
    register: (options, component) => {
      recorded.registrations.push({ options, component })
      return () => {}
    },
  },
}
const loaderCalls = []
globalThis.window = { __ModuleLoader__: { load: (spec) => loaderCalls.push(spec) } }
const clientUrl = pathToFileURL(join(ROOT, 'lib', 'client.js')).href
await import(clientUrl)
const spec = loaderCalls[0]
const clientExports = spec.factory((id) => {
  if (id === 'react') return reactStub
  if (id === '@deepseek-ai/dsh-client-ui-primitives') {
    return { Modal: 'Modal', Button: 'Button', Input: 'Input', IconFolderOpenRegular: 'Icon' }
  }
  throw new Error(`未声明的客户端依赖：${id}`)
})

await test('loader 的 id 与包名一致', () => {
  assert.equal(loaderCalls.length, 1)
  assert.equal(spec.id, 'dsh-workspace-create-dialog')
})
await test('apply 只注册两个目录流程 slot，且优先级遮蔽官方占位者', () => {
  assert.deepEqual(clientExports.inject, ['slots'])
  clientExports.apply(fakeCtx)
  assert.deepEqual(recorded.injections, ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'])
  assert.equal(recorded.registrations.length, 2)
  const names = recorded.registrations.map((entry) => entry.options.name)
  assert.deepEqual(names, ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'])
  for (const entry of recorded.registrations) {
    assert.equal(entry.options.priority, -100, 'single slot 取 priority 最小者，官方是 0，必须为负')
    assert.equal(entry.options.id, undefined, 'single slot 不接受 id，传了反而会被拒')
    assert.equal(typeof entry.component, 'function')
    assert.equal(typeof entry.options.inject, 'function')
  }
  assert.equal(new Set(recorded.registrations.map((entry) => entry.component)).size, 1, '两个座位共用同一个组件')
})
await test('注入面提供创建目录、选择目录与工作区服务', () => {
  const face = recorded.registrations[0].options.inject()
  assert.equal(typeof face.createFolder, 'function')
  assert.equal(typeof face.pickFolder, 'function')
  assert.notEqual(face.workspaces, undefined)
})
await test('客户端只 require 允许的运行时依赖', async () => {
  const source = await readFile(join(ROOT, 'lib', 'client.js'), 'utf8')
  const allowed = new Set(['react', '@deepseek-ai/dsh-client-ui-primitives'])
  const found = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
  for (const id of found) assert.ok(allowed.has(id), `未预期的依赖：${id}`)
  assert.ok(found.includes('react'))
})
await test('文案两种语言的键完全一致', async () => {
  const source = await readFile(join(ROOT, 'lib', 'client.js'), 'utf8')
  const start = source.indexOf('const TEXT = {')
  assert.ok(start > 0)
  const zhStart = source.indexOf('zh: {', start)
  const enStart = source.indexOf('en: {', zhStart)
  const end = source.indexOf('\n    }', enStart)
  const keysOf = (text) => [...text.matchAll(/^ {8}([A-Za-z_][\w]*):/gm)].map((match) => match[1]).sort()
  const zhKeys = keysOf(source.slice(zhStart, enStart))
  const enKeys = keysOf(source.slice(enStart, end))
  assert.ok(zhKeys.length >= 10, `中文文案键太少：${zhKeys.join(',')}`)
  assert.deepEqual(zhKeys, enKeys, '两种语言的文案键必须一一对应')
})

console.log('client.js：交互规则（用极简 React 替身渲染并驱动）')
const CreateDialog = recorded.registrations[0].component

// 渲染期需要一个最小的 document。真实浏览器里 <html lang> 由官方 client-locale
// 服务写入（它会跟随设置里的语言切换），这里手动指向中文。
globalThis.document = { documentElement: { lang: 'zh-CN' } }

/**
 * 全新挂载并渲染一次对话框。
 * @param {object} props - 组件 props。
 * @returns {object | null} 元素树。
 */
function mountDialog(props) {
  reactStub.__remount()
  reactStub.__reset()
  return CreateDialog(props)
}

/**
 * 用当前状态重新渲染（模拟 React 的 re-render）。
 * @param {object} props - 组件 props。
 * @returns {object | null} 元素树。
 */
function rerenderDialog(props) {
  reactStub.__reset()
  return CreateDialog(props)
}

/**
 * 造一份组件 props 与其调用记录。
 * @param {object} [overrides] - 覆盖项。
 * @returns {{props: object, calls: object}} props 与记录。
 */
function dialogProps(overrides = {}) {
  const calls = { created: [], picked: [], cancelled: 0, baseSet: [] }
  const props = {
    open: true,
    busy: false,
    onPicked: (path) => calls.picked.push(path),
    onCancel: () => {
      calls.cancelled += 1
    },
    createFolder: async (folderName) => {
      calls.created.push(folderName)
      return { ok: true, path: `D:\\base\\${folderName}` }
    },
    pickFolder: async () => ({ ok: true, path: null }),
    setBaseDir: async (path) => {
      calls.baseSet.push(path)
      return { ok: true, baseDir: path }
    },
    workspaces: undefined,
    ...overrides,
  }
  return { props, calls }
}

/** 取元素树里的姓名输入框。 */
const nameInput = (tree) => findOne(tree, (node) => node.type === 'Input')
/** 取「选择文件夹…」按钮。 */
const chooseButton = (tree) => findOne(tree, (node) => node.type === 'Button' && node.props.variant === 'outline')
/** 取「创建」按钮。 */
const createButton = (tree) => findOne(tree, (node) => node.type === 'Button' && node.props.variant === 'primary')
/** 取「取消」按钮。 */
const cancelButton = (tree) => findOne(tree, (node) => node.type === 'Button' && node.props.variant === 'ghost')
/** 按可见文案取按钮（两个「选择…」按钮靠文案区分，不靠顺序）。 */
const buttonLabelled = (tree, label) => findOne(tree, (node) => node.type === 'Button' && node.children[0] === label)
/** 取某一行显示路径的 span。 */
const pathSpan = (tree, role) => findOne(tree, (node) => node.type === 'span' && node.props['data-role'] === role)

await test('未打开时不渲染任何东西', () => {
  const { props } = dialogProps({ open: false })
  assert.equal(mountDialog(props), null)
})
await test('只填名称：请宿主建目录，把路径交给属主', async () => {
  const { props, calls } = dialogProps()
  nameInput(mountDialog(props)).props.onChange({ target: { value: '演示项目' } })
  createButton(rerenderDialog(props)).props.onClick()
  await flush()
  assert.deepEqual(calls.created, ['演示项目'], '应把名称交给宿主去建目录')
  assert.deepEqual(calls.picked, ['D:\\base\\演示项目'], '属主应收到新建目录的绝对路径')
})
await test('什么都没填：只提示，不建目录也不注册', async () => {
  const { props, calls } = dialogProps()
  createButton(mountDialog(props)).props.onClick()
  await flush()
  assert.equal(calls.created.length, 0)
  assert.equal(calls.picked.length, 0)
  const note = findOne(rerenderDialog(props), (node) => node.type === 'p' && node.props.className === 'wcd-error')
  assert.ok(note !== undefined, '应显示提示')
  assert.ok(String(note.children[0]).length > 0, '提示文案不能为空')
})
await test('宿主拒绝建目录时，把原因码翻成提示', async () => {
  const { props, calls } = dialogProps({ createFolder: async () => ({ ok: false, error: 'invalid-char' }) })
  nameInput(mountDialog(props)).props.onChange({ target: { value: 'a/b' } })
  createButton(rerenderDialog(props)).props.onClick()
  await flush()
  assert.equal(calls.picked.length, 0)
  const note = findOne(rerenderDialog(props), (node) => node.type === 'p' && node.props.className === 'wcd-error')
  assert.ok(String(note.children[0]).includes('不能包含'), `应显示禁用字符的说明，实际：${String(note.children[0])}`)
})
await test('选文件夹且名称未填：自动填成文件夹名', async () => {
  const titles = []
  const { props } = dialogProps({
    pickFolder: async (title) => {
      titles.push(title)
      return { ok: true, path: 'D:\\work\\proj-x' }
    },
  })
  chooseButton(mountDialog(props)).props.onClick()
  await flush()
  const tree = rerenderDialog(props)
  assert.equal(nameInput(tree).props.value, 'proj-x')
  assert.equal(pathSpan(tree, 'workspace-folder').children[0], 'D:\\work\\proj-x', '选中的路径要显示出来')
  assert.deepEqual(titles, ['选择工作区文件夹'], '窗口标题由界面按语言给出，不写死在宿主里')
})
await test('选文件夹时名称已填：以填写的为准', async () => {
  const { props } = dialogProps({ pickFolder: async () => ({ ok: true, path: 'D:\\work\\proj-x' }) })
  nameInput(mountDialog(props)).props.onChange({ target: { value: '我的名字' } })
  chooseButton(rerenderDialog(props)).props.onClick()
  await flush()
  assert.equal(nameInput(rerenderDialog(props)).props.value, '我的名字')
})
await test('名称与文件夹名不同：先注册再改名，再交给属主', async () => {
  const registered = []
  const renamed = []
  const { props, calls } = dialogProps({
    pickFolder: async () => ({ ok: true, path: 'D:\\work\\proj-x' }),
    workspaces: {
      create: async ({ path }) => {
        registered.push(path)
        return { workspaceId: 'w1' }
      },
      rename: async (id, title) => {
        renamed.push([id, title])
      },
    },
  })
  nameInput(mountDialog(props)).props.onChange({ target: { value: '我的名字' } })
  chooseButton(rerenderDialog(props)).props.onClick()
  await flush()
  createButton(rerenderDialog(props)).props.onClick()
  await flush()
  assert.deepEqual(registered, ['D:\\work\\proj-x'])
  assert.deepEqual(renamed, [['w1', '我的名字']], '标题必须取自填写的名称，而不是目录名')
  assert.deepEqual(calls.picked, ['D:\\work\\proj-x'])
})
await test('选文件夹被取消：界面保持原样', async () => {
  const { props, calls } = dialogProps({ pickFolder: async () => ({ ok: true, path: null }) })
  chooseButton(mountDialog(props)).props.onClick()
  await flush()
  const tree = rerenderDialog(props)
  assert.equal(nameInput(tree).props.value, '')
  assert.equal(calls.picked.length, 0)
  assert.equal(calls.cancelled, 0, '取消原生窗口不该关掉本对话框')
})
await test('取消按钮把控制权还给属主，且不产生副作用', () => {
  const { props, calls } = dialogProps()
  cancelButton(mountDialog(props)).props.onClick()
  assert.equal(calls.cancelled, 1)
  assert.equal(calls.created.length, 0)
  assert.equal(calls.picked.length, 0)
})
await test('属主接纳中（busy）时按钮全部禁用', () => {
  const { props } = dialogProps({ busy: true })
  const tree = mountDialog(props)
  assert.equal(createButton(tree).props.disabled, true)
  assert.equal(cancelButton(tree).props.disabled, true)
  assert.equal(chooseButton(tree).props.disabled, true)
})
await test('界面语言跟随 <html lang>', () => {
  const { props } = dialogProps()
  globalThis.document.documentElement.lang = 'en'
  assert.equal(findOne(mountDialog(props), (node) => node.type === 'Modal').props.title, 'Create Workspace')
  globalThis.document.documentElement.lang = 'zh-CN'
  assert.equal(findOne(mountDialog(props), (node) => node.type === 'Modal').props.title, '创建工作区')
})
await test('「新建位置」行：改一次就落盘，界面随之更新', async () => {
  const titles = []
  const { props, calls } = dialogProps({
    pickFolder: async (title) => {
      titles.push(title)
      return { ok: true, path: 'E:\\新的位置' }
    },
  })
  let tree = mountDialog(props)
  assert.equal(pathSpan(tree, 'base-dir').children[0], '未选择（将自动新建）', '还没取回设置时显示占位')
  tree = rerenderDialog(props)
  buttonLabelled(tree, '更改…').props.onClick()
  await flush()
  assert.deepEqual(titles, ['选择新工作区的所在目录'], '改位置用的标题与「选择工作区文件夹」不同')
  assert.deepEqual(calls.baseSet, ['E:\\新的位置'], '必须交给宿主落盘，而不是只改界面')
  assert.equal(pathSpan(rerenderDialog(props), 'base-dir').children[0], 'E:\\新的位置')
  assert.equal(calls.picked.length, 0, '改位置本身不该创建或注册任何工作区')
})
await test('「更改…」被取消时界面不变', async () => {
  const { props, calls } = dialogProps({ pickFolder: async () => ({ ok: true, path: null }) })
  const tree = mountDialog(props)
  buttonLabelled(tree, '更改…').props.onClick()
  await flush()
  assert.equal(calls.baseSet.length, 0)
  assert.equal(pathSpan(rerenderDialog(props), 'base-dir').children[0], '未选择（将自动新建）')
})
await test('宿主拒绝新位置时，把原因码翻成提示', async () => {
  const { props } = dialogProps({
    pickFolder: async () => ({ ok: true, path: 'relative\\dir' }),
    setBaseDir: async () => ({ ok: false, error: 'not-absolute' }),
  })
  const tree = mountDialog(props)
  buttonLabelled(tree, '更改…').props.onClick()
  await flush()
  const note = findOne(rerenderDialog(props), (node) => node.type === 'p' && node.props.className === 'wcd-error')
  assert.ok(note !== undefined && String(note.children[0]).includes('绝对路径'), `应显示绝对路径的说明，实际：${String(note?.children[0])}`)
})

console.log('index.js：宿主路由')
await test('路由字面量与浏览器半区一致', async () => {
  const client = await readFile(join(ROOT, 'lib', 'client.js'), 'utf8')
  for (const path of Object.values(host.ROUTES)) {
    assert.ok(path.startsWith('/api/dsh-workspace-create/'), `路由前缀不对：${path}`)
    // 浏览器侧无前导斜杠（GUI 用 <base href="./"> 提供）
    assert.ok(client.includes(`'${path.slice(1)}'`), `浏览器半区缺少路由：${path.slice(1)}`)
  }
})
await test('四条路由的 kind 与路径', () => {
  const routes = []
  const ctx = {
    logger: { warn: () => {} },
    effect: (body) => {
      body()
    },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
  }
  host.apply(ctx, { baseDir: join(tmpdir(), 'dsh-wcd-selftest'), stateFile: join(tmpdir(), 'dsh-wcd-selftest-state.json') })
  assert.deepEqual(routes.map((route) => route.path), [
    host.ROUTES.config,
    host.ROUTES.baseDir,
    host.ROUTES.createFolder,
    host.ROUTES.pickFolder,
  ])
  for (const route of routes) {
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.handler, 'function')
  }
})
await test('非本机来源一律拒绝', async () => {
  const routes = new Map()
  const ctx = {
    logger: { warn: () => {} },
    effect: (body) => { body() },
    webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
  }
  host.apply(ctx, { baseDir: join(tmpdir(), 'dsh-wcd-selftest'), stateFile: join(tmpdir(), 'dsh-wcd-selftest-state.json') })
  const res = fakeResponse()
  await routes.get(host.ROUTES.createFolder).handler(
    fakeRequest({ method: 'POST', body: { name: 'x' }, remoteAddress: '10.0.0.5' }),
    res,
  )
  assert.equal(res.status, 403)
  assert.equal(res.payload.ok, false)
})
await test('建目录路由真的建出目录，并拒绝非法名称', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-wcd-'))
  const routes = new Map()
  const ctx = {
    logger: { warn: () => {} },
    effect: (body) => { body() },
    webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
  }
  host.apply(ctx, { baseDir: sandbox, stateFile: join(sandbox, 'state.json') })
  const handler = routes.get(host.ROUTES.createFolder).handler
  try {
    const ok = fakeResponse()
    await handler(fakeRequest({ method: 'POST', body: { name: '我的工作区' } }), ok)
    assert.equal(ok.status, 200)
    assert.equal(ok.payload.ok, true)
    assert.equal(ok.payload.path, join(sandbox, '我的工作区'))
    assert.equal((await stat(ok.payload.path)).isDirectory(), true)

    const bad = fakeResponse()
    await handler(fakeRequest({ method: 'POST', body: { name: 'a/b' } }), bad)
    assert.equal(bad.status, 400)
    assert.equal(bad.payload.error, 'invalid-char')

    const missing = fakeResponse()
    await handler(fakeRequest({ method: 'POST', body: {} }), missing)
    assert.equal(missing.payload.error, 'empty')

    const wrongMethod = fakeResponse()
    await handler(fakeRequest({}), wrongMethod)
    assert.equal(wrongMethod.status, 405)
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})
await test('配置路由回的是解析后的新建位置', async () => {
  const routes = new Map()
  const ctx = {
    logger: { warn: () => {} },
    effect: (body) => { body() },
    webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
  }
  // 显式给一个配置值，等价于「profile patch 里的初始值」
  host.apply(ctx, { baseDir: 'D:\\配置的初始位置' })
  const res = fakeResponse()
  await routes.get(host.ROUTES.config).handler(fakeRequest({ method: 'GET' }), res)
  assert.equal(res.payload.baseDir, 'D:\\配置的初始位置')
  assert.equal(typeof res.payload.lastDir, 'string')
})
await test('未配置时新建位置会落到一个绝对路径（默认工作区根目录或兜底）', async () => {
  const routes = new Map()
  const ctx = {
    logger: { warn: () => {} },
    effect: (body) => { body() },
    webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
    get: () => undefined,
  }
  host.apply(ctx, {})
  const res = fakeResponse()
  await routes.get(host.ROUTES.config).handler(fakeRequest({ method: 'GET' }), res)
  assert.equal(isAbsoluteDir(res.payload.baseDir), true, `应是绝对路径，实际：${res.payload.baseDir}`)
})
await test('改新建位置：拒绝相对路径，接受绝对路径并落盘', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-wcd-base-'))
  const stateFile = join(sandbox, 'state.json')
  const routes = new Map()
  const ctx = {
    logger: { warn: () => {} },
    effect: (body) => { body() },
    webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
  }
  host.apply(ctx, { stateFile })
  const handler = routes.get(host.ROUTES.baseDir).handler
  try {
    const bad = fakeResponse()
    await handler(fakeRequest({ method: 'POST', body: { path: 'relative\\dir' } }), bad)
    assert.equal(bad.status, 400)
    assert.equal(bad.payload.error, 'not-absolute')

    const target = join(sandbox, '新位置')
    const ok = fakeResponse()
    await handler(fakeRequest({ method: 'POST', body: { path: target } }), ok)
    assert.equal(ok.status, 200)
    assert.equal(ok.payload.baseDir, target)
    assert.equal((await stat(target)).isDirectory(), true, '选择的位置应被建出来')

    const persisted = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(persisted.baseDir, target, '设置必须跨重启保留')

    // 改完位置之后，只填名称创建应落在新位置
    const created = fakeResponse()
    await routes.get(host.ROUTES.createFolder).handler(fakeRequest({ method: 'POST', body: { name: 'proj' } }), created)
    assert.equal(created.payload.path, join(target, 'proj'))
    assert.equal((await stat(created.payload.path)).isDirectory(), true)
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

console.log('包声明一致性')
await test('包名在三处声明里一致', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.equal(pkg.name, 'dsh-workspace-create-dialog')
  assert.equal(host.name, 'workspace-create-dialog')
  assert.ok(patch.includes(`name: 'dsh-workspace-create-dialog'`), 'cordis.patch.yml 里的包名')
  assert.ok(patch.includes('id: ui-workspace-create-dialog'))
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.ok(existsSync(join(ROOT, pkg.main)))
})

console.log(`\n全部通过：${passed} 个用例`)
