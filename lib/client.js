/**
 * dsh-workspace-create-dialog 的浏览器半区。
 *
 * 它占用官方 ui-workspace 声明的两个「目录流程」slot（侧边栏的「添加工作区…」
 * 与空状态 hero 里的入口），用自己的创建对话框替换掉官方那个无渲染的
 * 「立刻弹系统选择器」占位者。
 *
 * 为什么要靠 slot：这是官方给出的唯一扩展点。属主（ui-workspace）在这里把
 * 完整的交互约定交给占位者——`open` / `busy` / `onPicked(path)` / `onCancel` /
 * `onError`——然后自己接纳所选路径（注册工作区并打开新会话）。因此本插件只需
 * 决定「拿哪个路径」，不需要碰工作区注册的细节。
 *
 * 遮蔽方式：single slot 按 priority 升序取第一个，官方 -native 占位者是 0，
 * 所以这里用负数稳稳排在它前面（同 priority 会直接抛错，这也是官方刻意的保护）。
 *
 * 不依赖任何内部组件库的私有接口：只用 `@deepseek-ai/dsh-client-ui-primitives`
 * 的 Modal / Button / Input 与主题 CSS 变量，官方 UI 升级不会让对话框跟着坏。
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-create-dialog',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** 四条路由与宿主半区保持一致；无前导斜杠，因为 GUI 用 <base href="./"> 提供。 */
    const API = {
      config: 'api/dsh-workspace-create/config',
      createFolder: 'api/dsh-workspace-create/create-folder',
      pickFolder: 'api/dsh-workspace-create/pick-folder',
      baseDir: 'api/dsh-workspace-create/base-dir',
    }

    /**
     * 遮蔽官方 native 占位者的优先级。single slot 取 priority 最小者，
     * 官方是 0，因此任何负数都能取胜；留出余量便于将来插入其他插件。
     */
    const SHADOW_PRIORITY = -100

    /** 对话框内唯一的输入框 id，label 用它关联。 */
    const NAME_INPUT_ID = 'dsh-workspace-create-name'

    /** 一次性注入的样式：主题 token 让对话框跟随明暗与换肤。 */
    const STYLE_ID = 'dsh-workspace-create-dialog-style'
    const CSS = `
.wcd-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.wcd-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.wcd-input { width: 100%; }
.wcd-folder { display: flex; align-items: center; gap: 8px; }
.wcd-folder-path { flex: 1 1 auto; min-width: 0; font-size: 13px; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 10px; height: 28px; display: flex; align-items: center; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.wcd-folder-path[data-empty="true"] { color: var(--dsw-alias-label-tertiary); }
.wcd-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.wcd-error { margin: 4px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary)); overflow-wrap: anywhere; }
/* 官方 Modal 卡片默认 380px，这里放宽到 460px 以容下路径行 */
.wcd-dialog { width: min(460px, 100%); }
`

    /**
     * 读当前界面语言。对话框每次打开都会重新渲染，因此在这里实时读就够了，
     * 不需要订阅语言变化。
     * @returns {'zh' | 'en'} 语言代码。
     */
    function currentLang() {
      const tag = typeof document === 'undefined' ? '' : String(document.documentElement.lang ?? '')
      return tag.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    /** 界面文案。路径保持原样，只有说明文字分语言。 */
    const TEXT = {
      zh: {
        title: '创建工作区',
        nameLabel: '工作区名称',
        namePlaceholder: '例如 my-project',
        folderLabel: '工作区文件夹',
        folderEmpty: '未选择（将自动新建）',
        choose: '选择文件夹…',
        picking: '选择中…',
        create: '创建',
        creating: '创建中…',
        cancel: '取消',
        pickedHint: '已选择的文件夹会直接作为工作区目录。',
        folderHint: '不选文件夹时，会按下面的「新建位置」新建一个同名文件夹。',
        baseLabel: '新建位置',
        baseHint: '只填名称时，工作区文件夹建在这里；以后一直用它，直到你再次更改。',
        changeBase: '更改…',
        basePickTitle: '选择新工作区的所在目录',
        folderPickTitle: '选择工作区文件夹',
        needInput: '请填写工作区名称，或先选择一个文件夹。',
        pickFailed: '无法打开文件夹选择窗口。',
        reason: {
          'empty': '请填写工作区名称。',
          'too-long': '名称太长了，请控制在 64 个字符以内。',
          'dot': '名称不能是“.”或“..”。',
          'invalid-char': '名称不能包含 \\ / : * ? " < > | 这些字符。',
          'reserved': '这是 Windows 保留设备名（如 CON、NUL、COM1），换一个名字吧。',
          'trailing-dot': '名称不能以点结尾。',
          'picker-busy': '已经有一个选择窗口开着，先把它关掉再试。',
          'not-absolute': '新建位置要填一个完整的绝对路径（例如 D:\\Work）。',
          'no-base-dir': '还没确定新建位置，请先在下面设置一个目录。',
        },
      },
      en: {
        title: 'Create Workspace',
        nameLabel: 'Workspace name',
        namePlaceholder: 'e.g. my-project',
        folderLabel: 'Workspace folder',
        folderEmpty: 'Not selected (a new folder will be created)',
        choose: 'Choose folder…',
        picking: 'Choosing…',
        create: 'Create',
        creating: 'Creating…',
        cancel: 'Cancel',
        pickedHint: 'The chosen folder becomes the workspace directory.',
        folderHint: 'With no folder chosen, a folder named after the workspace is created at the location below.',
        baseLabel: 'New workspace location',
        baseHint: 'Name-only creations put their folder here; it stays until you change it again.',
        changeBase: 'Change…',
        basePickTitle: 'Select the parent location for new workspaces',
        folderPickTitle: 'Select workspace folder',
        needInput: 'Enter a workspace name, or choose a folder first.',
        pickFailed: 'Could not open the folder chooser.',
        reason: {
          'empty': 'Enter a workspace name.',
          'too-long': 'That name is too long; keep it under 64 characters.',
          'dot': 'The name cannot be "." or "..".',
          'invalid-char': 'The name cannot contain \\ / : * ? " < > |.',
          'reserved': 'That is a reserved Windows device name (CON, NUL, COM1, …); pick another.',
          'trailing-dot': 'The name cannot end with a dot.',
          'picker-busy': 'A folder chooser is already open; close it before trying again.',
          'not-absolute': 'The location must be a full absolute path (for example D:\\Work).',
          'no-base-dir': 'No location is set yet; choose one below first.',
        },
      },
    }

    /**
     * 取路径最后一段：`D:\a\b\` → `b`，盘符根 `D:\` → `D:`。
     *
     * 与宿主半区 lib/name.js 的 lastSegment 同义。这里必须自带一份，因为
     * client bundle 不能 import 插件自己的模块。
     * @param {string} path - 任意路径。
     * @returns {string} 最后一段。
     */
    function lastSegment(path) {
      if (typeof path !== 'string') return ''
      const trimmed = path.replace(/[\\/]+$/, '')
      const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
      return index === -1 ? trimmed : trimmed.slice(index + 1)
    }

    /**
     * POST 一个 JSON 请求。
     * @param {string} url - 相对路由。
     * @param {object} body - 请求体。
     * @returns {Promise<object>} 宿主返回的 JSON 对象。
     * @throws {Error} 响应不是 JSON（路由没注册、被围栏拒绝）时抛出。
     */
    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null || typeof payload !== 'object') throw new Error(`HTTP ${response.status}`)
      return payload
    }

    /**
     * 注入一次样式表。
     * @returns {void}
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = CSS
      ;(document.head ?? document.documentElement).append(tag)
    }

    /**
     * 创建对话框本体：上面填名称，下面选文件夹。
     *
     * 交互规则（与需求一一对应）：
     * - 只填名称 → 宿主在基底目录下新建同名文件夹，该文件夹即工作区；
     * - 选了文件夹 → 该文件夹即工作区；名称没填时自动取文件夹名，填了则以填写的为准
     *   （名称与文件夹名不一致时，注册后改名，因为注册表只接受路径、标题取自路径）；
     * - 在任何一步失败都留在对话框里显示原因，不静默关闭。
     *
     * @param {object} props - 属主交互约定 + 本插件注入的宿主调用。
     * @returns {object | null} 对话框元素；未打开时为 null。
     */
    function WorkspaceCreateDialog(props) {
      const { open, busy, onPicked, onCancel, createFolder, pickFolder, setBaseDir, workspaces } = props
      const tx = TEXT[currentLang()]
      const [name, setName] = React.useState('')
      const [folder, setFolder] = React.useState('')
      const [note, setNote] = React.useState('')
      /** '' | 'picking' | 'creating'：本插件自己发起的异步步骤。 */
      const [pending, setPending] = React.useState('')
      // 与注入面里的 setBaseDir（写宿主）区分开：这个只是界面上的显示值
      const [baseDir, setBaseDirValue] = React.useState('')

      // 每次打开都是一次全新的创建：清掉上一次留下的输入与报错
      React.useEffect(() => {
        if (!open) return
        setName('')
        setFolder('')
        setNote('')
        setPending('')
      }, [open])

      // 新建位置只问一次（之后的显示值由用户「更改…」时更新）
      React.useEffect(() => {
        if (!open || baseDir !== '') return undefined
        let alive = true
        fetch(API.config, { cache: 'no-store' })
          .then((response) => response.json())
          .then((payload) => {
            if (alive && payload !== null && payload.ok === true) setBaseDirValue(String(payload.baseDir ?? ''))
          })
          .catch(() => {
            // 问不到就留空，界面提示仍可见，不影响「选文件夹」这条路径
          })
        return () => {
          alive = false
        }
      }, [open, baseDir])

      /** 属主仍在接纳所选路径，或本插件自己有步骤在跑：此时一切提交动作关闭。 */
      const locked = pending !== '' || busy === true

      /**
       * 选文件夹：驱动宿主半区的原生 IFileDialog（起始位置是上次所在的目录）。
       * @returns {Promise<void>} 交互结束后 resolve。
       */
      const chooseFolder = async () => {
        if (locked) return
        setNote('')
        setPending('picking')
        try {
          const payload = await pickFolder(tx.folderPickTitle)
          if (payload.ok !== true) {
            const code = typeof payload.error === 'string' ? payload.error : ''
            setNote(tx.reason[code] ?? (code !== '' ? code : tx.pickFailed))
            return
          }
          if (payload.path === null || payload.path === undefined) return // 用户取消，保持原样
          const picked = String(payload.path)
          setFolder(picked)
          // 名称没填过才自动补上文件夹名；填过就以填写的为准
          setName((current) => (current.trim() === '' ? lastSegment(picked) : current))
        } catch (failure) {
          setNote(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setPending('')
        }
      }

      /**
       * 改「新建位置」：用同一个原生窗口挑一个目录，交给宿主落盘。
       *
       * 这是这个窗口里唯一会持久化的设置：用户改过之后归他管，配置只作为安装时的初始值。
       * @returns {Promise<void>} 交互结束后 resolve。
       */
      const changeBase = async () => {
        if (locked) return
        setNote('')
        setPending('picking')
        try {
          const picked = await pickFolder(tx.basePickTitle)
          if (picked.ok !== true) {
            const code = typeof picked.error === 'string' ? picked.error : ''
            setNote(tx.reason[code] ?? (code !== '' ? code : tx.pickFailed))
            return
          }
          if (picked.path === null || picked.path === undefined) return // 用户取消，保持原样
          const saved = await setBaseDir(String(picked.path))
          if (saved.ok !== true) {
            const code = typeof saved.error === 'string' ? saved.error : ''
            setNote(tx.reason[code] ?? (code !== '' ? code : tx.pickFailed))
            return
          }
          setBaseDirValue(String(saved.baseDir ?? picked.path))
        } catch (failure) {
          setNote(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setPending('')
        }
      }

      /**
       * 提交：决定最终的工作区目录，必要时先把标题改成用户填写的名称。
       * @returns {Promise<void>} 提交结束后 resolve。
       */
      const submit = async () => {
        if (locked) return
        setNote('')
        const title = name.trim()
        let target = folder
        setPending('creating')
        try {
          if (target === '') {
            if (title === '') {
              setNote(tx.needInput)
              return
            }
            const created = await createFolder(title)
            if (created.ok !== true) {
              const reason = typeof created.error === 'string' ? created.error : ''
              // 宿主回的是稳定的原因码；不认识的码（例如磁盘报错）就原样显示
              setNote(tx.reason[reason] ?? (reason !== '' ? reason : tx.needInput))
              return
            }
            target = String(created.path)
          }
          // 注册表只接受路径、标题取自路径最后一段：名称与目录名不同就先注册再改名
          if (title !== '' && title !== lastSegment(target) && workspaces !== undefined && workspaces !== null) {
            const workspace = await workspaces.create({ path: target })
            try {
              await workspaces.rename(workspace.workspaceId, title)
            } catch (failure) {
              // 改名失败不影响工作区已经建好这件事，保留目录名作标题即可
              console.warn('[workspace-create-dialog] 重命名工作区失败：', failure)
            }
          }
          onPicked(target)
        } catch (failure) {
          setNote(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setPending('')
        }
      }

      if (!open) return null

      const body = [
        h('div', { key: 'name', className: 'wcd-field' },
          h('label', { className: 'wcd-label', htmlFor: NAME_INPUT_ID }, tx.nameLabel),
          h(primitives.Input, {
            id: NAME_INPUT_ID,
            className: 'wcd-input',
            value: name,
            placeholder: tx.namePlaceholder,
            disabled: locked,
            spellCheck: false,
            // 官方 Modal 用这个标记决定初始焦点，替代 autoFocus 以保留焦点归还
            'data-modal-autofocus': '',
            onChange: (event) => setName(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            },
          })),
        h('div', { key: 'folder', className: 'wcd-field' },
          h('span', { className: 'wcd-label' }, tx.folderLabel),
          h('div', { className: 'wcd-folder' },
            h('span', {
              className: 'wcd-folder-path',
              'data-role': 'workspace-folder',
              'data-empty': folder === '' ? 'true' : 'false',
              title: folder,
            }, folder === '' ? tx.folderEmpty : folder),
            h(primitives.Button, {
              variant: 'outline',
              size: 'sm',
              disabled: locked,
              icon: h(primitives.IconFolderOpenRegular, { size: 16 }),
              onClick: () => {
                void chooseFolder()
              },
            }, pending === 'picking' ? tx.picking : tx.choose)),
          h('p', { className: 'wcd-hint' }, folder === '' ? tx.folderHint : tx.pickedHint)),
        h('div', { key: 'base', className: 'wcd-field' },
          h('span', { className: 'wcd-label' }, tx.baseLabel),
          h('div', { className: 'wcd-folder' },
            h('span', {
              className: 'wcd-folder-path',
              'data-role': 'base-dir',
              'data-empty': baseDir === '' ? 'true' : 'false',
              title: baseDir,
            }, baseDir === '' ? tx.folderEmpty : baseDir),
            h(primitives.Button, {
              variant: 'outline',
              size: 'sm',
              disabled: locked,
              icon: h(primitives.IconFolderOpenRegular, { size: 16 }),
              onClick: () => {
                void changeBase()
              },
            }, tx.changeBase)),
          h('p', { className: 'wcd-hint' }, tx.baseHint)),
      ]
      if (note !== '') body.push(h('p', { key: 'note', className: 'wcd-error', role: 'alert' }, note))

      return h(primitives.Modal, {
        open,
        // 属主还在接纳、或本插件有步骤在跑时不接受关闭，避免留下一个半途的流程
        onClose: () => {
          if (!locked) onCancel()
        },
        title: tx.title,
        closeLabel: tx.cancel,
        className: 'wcd-dialog',
        footer: [
          h(primitives.Button, {
            key: 'cancel',
            variant: 'ghost',
            disabled: locked,
            onClick: () => {
              if (!locked) onCancel()
            },
          }, tx.cancel),
          h(primitives.Button, {
            key: 'create',
            variant: 'primary',
            disabled: locked,
            onClick: () => {
              void submit()
            },
          }, pending === 'creating' || busy === true ? tx.creating : tx.create),
        ],
      }, body)
    }

    /** 需要的客户端服务：slot 注册表。工作区服务按需 ctx.get，不作为硬依赖。 */
    const inject = ['slots']

    /**
     * 注册对话框。
     *
     * 两个 slot 由 ui-workspace 的入口声明，可能晚于本插件激活、也可能被替换，
     * 因此必须走 `ctx.slots.inject()`：它等待声明、在声明折叠时撤下贡献、在声明
     * 恢复后重新注册（直接 register 会在 slot 尚未声明时抛错）。
     * @param {object} ctx - 客户端插件上下文。
     * @returns {void}
     */
    function apply(ctx) {
      ensureStyles()

      /**
       * 注入面：组件只拿到投影后的能力，自己不认识路由与服务名。
       * @returns {object} 组件可见的宿主调用。
       */
      const injected = () => ({
        // 工作区服务可能尚未注册（启动早期），取不到就退化为「不改标题」
        workspaces: ctx.get('workspaces'),
        createFolder: (folderName) => postJson(API.createFolder, { name: folderName }),
        // 标题由界面按当前语言给出；宿主只做清洗与长度上限
        pickFolder: (title) => postJson(API.pickFolder, { title }),
        setBaseDir: (path) => postJson(API.baseDir, { path }),
      })

      const disposers = []
      try {
        disposers.push(ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
          yield ctx.slots.register({
            name: 'conversation.hero.workspace.directoryFlow',
            priority: SHADOW_PRIORITY,
            inject: injected,
          }, WorkspaceCreateDialog)
          yield ctx.slots.register({
            name: 'sidebar.workspaces.directoryFlow',
            priority: SHADOW_PRIORITY,
            inject: injected,
          }, WorkspaceCreateDialog)
        })))
      } catch (error) {
        for (const dispose of disposers.splice(0)) dispose()
        throw error
      }
      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) dispose()
      }, 'workspace-create-dialog: ui mounts')
    }

    return { apply, inject }
  },
})
