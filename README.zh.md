# dsh-workspace-create-dialog

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**创建工作区对话框**：填个名字就能开，或者选文件夹——而那个选择窗口终于会记得你上次在哪。

```
  创建工作区
  ──────────────────────────────────────────────────────────
  工作区名称
  [ my-project                                             ]

  工作区文件夹
  [ 未选择（将自动新建） ]                      [ 选择文件夹… ]
    不选文件夹时，会按下面的「新建位置」新建一个同名文件夹。

  新建位置
  [ D:\Work\Workspaces                          ] [ 更改… ]
    只填名称时，工作区文件夹建在这里；以后一直用它，直到你再次更改。

                                    [ 取消 ]  [ 创建 ]
```

## 它能做什么

现在在 DSH 里点**添加工作区…**，会立刻弹出系统文件夹对话框。本插件把它换成一个小窗口，问两件互相独立的事：这个工作区叫什么、它放在哪。只回答第一个，文件夹由它替你建；回答了第二个，你选的那个文件夹就是工作区本身。

| 你的操作 | 得到的结果 |
| --- | --- |
| 填个名称，点**创建** | 在**新建位置**下建出同名文件夹，注册为工作区，并在里面打开一个会话 |
| 点**选择文件夹…** | 原生 Windows 文件夹对话框，**从你上次所在的位置**开始，而不是某个默认位置 |
| 选了文件夹、名称留空 | 名称自动填上所选文件夹的名字 |
| 选了文件夹、名称已填 | 以你填的为准——先注册，再改名成你填的 |
| 点**新建位置**那行的**更改…** | 换一个「只填名称」时的落点；这个选择会保存，重启后仍在 |
| 取消 / Esc / 点遮罩 | 什么都不做——不建目录、不注册 |

### 效果：前后对比

| | 以前 | 现在 |
| --- | --- | --- |
| 建一个 `my-project` | 先去资源管理器建目录，再在对话框里翻到它 | 输入 `my-project`，完成 |
| 文件夹对话框的起点 | 每次都是系统默认位置 | 上一次你所在的那个目录 |
| 新工作区落在哪 | 你导航到哪就是哪 | 一个你设置过一次、窗口里看得见、随时可改的位置 |
| 工作区按文件夹命名 | 得重新把名字打一遍 | 自动填好 |

## 安装

### 从插件市场（收录后推荐）

在 [dshmarket](https://github.com/dsh-market/dsh-market) 里搜 **dsh-workspace-create-dialog**，一键安装。上架还差一个 [PR](contrib/awesome-dsh-plugin/) 到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（他们的 CI 要求仓库至少存在一天），在那之前请用下面的手动方式。

### 从本仓库手动安装

```sh
git clone https://github.com/LanFeng97/dsh-workspace-create-dialog
cd dsh-workspace-create-dialog
node tools/install.mjs
```

它会把包拷进你 DSH profile 的 `node_modules`，并在 profile 的 `cordis.patch.yml` 末尾追加一条 loader 行。DSH home 的解析顺序与官方一致：显式配置、`$DSH_HOME`、`~/.dsh`。

**然后重启一次 DeepSeek Harness**（宿主半区是 Node 模块，只重载配置不会重新 import）。之后改 `lib/client.js` 只需刷新页面，改 `lib/index.js` 仍需重启。

`node tools/install.mjs --dry-run` 只打印会做什么，不写任何文件。

## 它是怎么做到的

### 用的是官方扩展点，不是打补丁

`@deepseek-ai/dsh-client-ui-workspace` 把「选目录」这一步做成了一个 `single` slot，交给填它的插件：

```text
sidebar.workspaces.directoryFlow              ← 侧边栏的「添加工作区…」
conversation.hero.workspace.directoryFlow     ← 空状态里的入口
```

属主把完整的交互约定交给占位者：

```ts
interface DirectoryFlowOwnerProps {
  open: boolean                     // 请求一次选取
  busy: boolean                     // 属主正在接纳所选路径
  onPicked: (path: string) => void  // 报告目录；属主自己注册工作区并打开新会话
  onCancel: () => void
  onError: (message: string) => void
}
```

本插件按同一协议把占位者注册进两个 slot，**priority 用 -100**。`single` slot 渲染 priority 最小的那个，官方 native 占位者是 `0`，所以这个窗口胜出（两个占位者同 priority 会直接抛错，那是官方防歧义的机制）。要完全恢复原样，把 profile patch 里那条 loader 行删掉即可。

### 为什么选择窗口是自己写的

桌面端打开文件夹对话框的那句调用在 Electron 主进程里，而且**没有起始目录**：

```js
// D:\App\DSH\resources\app.asar → lib/main.js
dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })
```

没有 `defaultPath`，这就是它每次都从同一个地方开始的原因。插件够不到那句调用：DSH 宿主只是 Electron 的**子进程**。所以 `lib/pick-folder.js` 自己开一个 `IFileDialog`——一段最小的 C# COM 互操作，交给**Windows 自带的 PowerShell 5.1** 编译并执行：

- **零依赖**：不用 koffi，不用 PowerShell 7，不用发布原生模块；
- 编译在**内存里**完成（每次约 120 ms），因此没有 DLL 缓存可损坏或可被占用；
- 关键的一行是 `IFileDialog::SetFolder`——把记得的目录作为起始位置；
- 对话框跑在子进程里，原生崩溃带不走宿主。

C# 方法声明的顺序必须与 COM vtable 一致（`Show=3`、`SetOptions=9`、`SetFolder=12`、`SetTitle=17`、`GetResult=20`）。顺序错了不会报错，只会静默做错事——所以自测里专门有一条断言守着它。

## 「新建位置」是怎么定的

**新建位置**按以下顺序解析（`lib/base-dir.js`，纯函数）：

1. **你在窗口里设置的**——优先级最高，改了就归你管；
2. profile patch 里的 **`config.baseDir`**——安装时用的那个值；
3. **默认工作区所在的根目录**——目录名固定为 `default-workspace` 的那个工作区（这个名字由 harness 固定，不随界面语言变化）的父目录。新工作区与它同级。全新安装时的默认答案就是这个；
4. **兜底**——`<Documents>/deepseek-harness`；没有 Documents 目录时退到 `<主目录>/deepseek-harness`。

解析结果会写进状态文件，所以「第一次是什么」只决定一次，之后只有你能改。`config.baseDir` 是种子，不是命令。

## HTTP 路由

四条都套同一套回环围栏（回环套接字 + 回环 `Host` + 同源标记；`x-forwarded-for` 一律不采信）——它们能在宿主机器上建目录、弹窗口，非本机来源必须一律拒绝。

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/api/dsh-workspace-create/config` | GET | 当前新建位置与上次所在的目录 |
| `/api/dsh-workspace-create/base-dir` | POST | `{"path":"…"}` → 校验为绝对路径、建出来、落盘 |
| `/api/dsh-workspace-create/create-folder` | POST | `{"name":"…"}` → 建出该文件夹，返回绝对路径 |
| `/api/dsh-workspace-create/pick-folder` | POST | `{"title":"…"}` → 打开原生选择窗口，返回路径（取消为 `null`） |

窗口标题由浏览器半区按当前界面语言传入（`<html lang>`，由官方 `client-locale` 服务维护）；宿主只做清洗与截断。

## 配置

可选，写在 profile 的 `cordis.patch.yml` 里：

```yaml
- insert:
    - id: ui-workspace-create-dialog
      name: 'dsh-workspace-create-dialog'
      config:
        baseDir: 'D:\Work\Workspaces'                 # 「新建位置」的初始值
        stateFile: '<可写路径>/state.json'             # 默认 $DSH_HOME/storages/dsh-workspace-create-dialog/state.json
```

状态文件只有两个字段：`baseDir`（新建位置）与 `lastDir`（选择窗口上次所在的目录）。

## 开发

```sh
node tools/selftest.mjs           # 37 条自测，不需要 DSH 运行时
node tools/pick-probe.mjs         # 原生选择器：编译 C#、走完 COM 链路，不弹窗
node tools/pick-probe.mjs --real  # 同上，但真的弹窗，用来看观感
node tools/install.mjs --dry-run  # 只打印安装脚本会做什么
```

`tools/selftest.mjs` 覆盖：名称校验规则、新建位置的优先顺序、COM vtable 顺序、slot 注册（用一个假的客户端上下文真的跑一遍 `apply`，断言优先级与两个座位）、路由行为（真实的 `mkdir` 往返、围栏拒绝），以及**对话框行为本身**——它用一个极简 React hook 替身真的渲染并驱动组件：只填名称创建、按文件夹名自动填充、「以填写的为准」、取消、以及改新建位置。

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半区：新建位置解析、建目录、原生选择器、四条路由 |
| `lib/base-dir.js` | 新建位置的优先顺序与绝对路径校验（纯函数） |
| `lib/name.js` | 工作区名称校验与路径拼接（纯函数） |
| `lib/state.js` | 状态原子落盘，坏文件按空状态降级 |
| `lib/guard.js` | 路由的回环信任围栏 |
| `lib/pick-folder.js` | 原生选择器：内嵌 C#、PowerShell 脚本、子进程 |
| `lib/client.js` | 浏览器半区：对话框，注册进两个流程座位 |

## 已知限制

- **原生选择器只在 Windows 上实现。** 其它平台点「选择文件夹…」会显示失败原因；「只填名称」这条路径与平台无关，照常可用。
- **它用 `powershell.exe` + 运行时 `Add-Type`。** 这个组合（`-EncodedCommand` + `Add-Type`）正是终端防护软件重点盯的行为，极少数机器会被拦。另一条路是打包原生依赖（koffi）；本插件选了零依赖。
- **已打开的原生窗口不能从浏览器里取消。** 这条链路上没有按请求中止的机制；关掉窗口才是取消。
- **「以填写的为准」依赖客户端工作区服务。** 名称与文件夹名不一致时会先注册再改名；万一改名失败，工作区照常存在，只是标题停在文件夹名上（控制台有警告）。
- **依赖 0.2.0-rc.2 的 `directoryFlow` 契约。** 将来 harness 改名或改契约时，插件会**静默失效**——`ctx.slots.inject` 等一个永远不来的声明，不报任何错。`dsh.engines.dsh` 只是把版本要求写明白，消除不了这个风险。

## 许可

[MIT](LICENSE) © 2026 LanFeng97
