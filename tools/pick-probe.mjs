/**
 * 原生选择器的冒烟测试。
 *
 * 默认（probe）只走完除「弹窗」以外的全部链路：编译 C#、CoCreateInstance、
 * SetOptions、SetTitle、SHCreateItemFromParsingName + SetFolder——这正是最
 * 容易出错、而且出错时不会有任何提示的部分（COM 槽位错位只会表现为「选了
 * 文件夹但没反应」）。因此它可以在不打扰用户的前提下验证。
 *
 * 加 `--real` 会真的弹出选择窗口，用来看观感与「延续上次目录」是否生效；
 * 这需要有人坐在屏幕前点一下。
 *
 * 用法：
 *   node tools/pick-probe.mjs               # 不弹窗
 *   node tools/pick-probe.mjs --real [目录]  # 真弹窗，可指定起始目录
 */
import { pickFolder, buildScript } from '../lib/pick-folder.js'

const args = process.argv.slice(2)
const real = args.includes('--real')
// 默认拿当前目录当起始位置：可移植，且刚好能看出「填了起始目录」与「没填」的差别
const initialDir = args.find((arg) => !arg.startsWith('--')) ?? process.cwd()

if (process.platform !== 'win32') {
  console.error(`本插件的原生选择器只在 Windows 上实现，当前平台是 ${process.platform}`)
  process.exit(1)
}

console.log(`脚本长度：${buildScript().length} 字符`)
console.log(real ? `实时模式：将弹出选择窗口，起始目录 ${initialDir}` : '探针模式：不弹窗')

// 注意：在 DSH 自己的沙箱里跑这个脚本会因「禁止管道捕获子进程输出」而 spawn EPERM，
// 那是沙箱边界而不是插件问题；插件运行在宿主进程里，不受该限制。
const started = Date.now()
const { path } = await pickFolder({ initialDir, probe: !real })
console.log(`耗时：${Date.now() - started} ms（含内存编译，约 120 ms 量级）`)

if (real) {
  console.log(path === null ? '结果：用户取消' : `结果：${path}`)
} else if (path === 'probe:ok') {
  console.log('结果：COM 链路可用（编译 + 创建对话框 + SetOptions + SetFolder 全部成功）')
} else {
  console.error(`结果异常：${String(path)}`)
  process.exit(1)
}
