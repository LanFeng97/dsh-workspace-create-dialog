/**
 * 安装 / 卸载本插件到当前 DSH profile。
 *
 * 装法：把包按 `files` 清单拷进 `$DSH_HOME/profiles/<profile>/node_modules/<包名>`，
 * 再在 profile 的 `cordis.patch.yml` 末尾补一条 insert loader 行（幂等，已有就跳过）。
 * 为什么不 `pnpm add file:`：那会动 profile 的 package.json 与 lockfile，一次 install
 * 就可能把整个 profile 的依赖重排。拷贝 + patch 只影响两个位置，出问题也好回退。
 *
 * 这里**不写死任何路径**：不传 `baseDir`，「新建位置」就由插件自己解析（默认工作区
 * 所在的根目录，兜底 `<Documents>/deepseek-harness`）；想固定成某个目录，编辑 profile
 * patch 里那条 loader 行的 `config.baseDir` 即可。
 *
 * 反过来也有 `--uninstall`：DSH 自带的「插件 → 添加插件」同样能装本插件（填仓库地址
 * 即可），两种方式各留一条 loader 行会在 profile 里造成同一个 id 出现两次——那是市场
 * 诊断页明确会报的「重复的 loader 条目」。换用界面安装前，先用这里卸掉手工那份。
 *
 * 用法：
 *   node tools/install.mjs             # 安装/更新
 *   node tools/install.mjs --dry-run   # 只打印会做什么
 *   node tools/install.mjs --uninstall # 删掉包与那条 loader 行
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))

/**
 * 从 profile patch 里摘掉本插件那条 loader 行。
 *
 * 只按行删我们自己写下的那段（标记注释 + 紧随其后的 insert 条目），不解析、不重排整个
 * 文件——那是用户手写的配置，注释与格式都得原样留着。**紧跟在后面的别的条目不会被碰到**：
 * 扫描在遇到下一个顶层条目（第二个 `- insert:`）时停止，所以「我们后面还有别人」这个
 * 真实场景（本机 patch 里就有一条 dsh-session-cost）是被覆盖的。
 * @param {string} text - profile patch 全文。
 * @param {string} name - 包名，用于定位我们写下的标记注释。
 * @returns {{text: string, removed: boolean}} 处理后的全文与是否删掉了东西。
 */
export function stripOurLoaderRow(text, name) {
  const lines = text.split('\n')
  const marker = lines.findIndex((line) => new RegExp(`^#\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:：]`).test(line.trim()))
  if (marker === -1) return { text, removed: false }
  let end = marker
  let seenEntry = false
  for (let index = marker + 1; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      end = index
      continue
    }
    // 我们那段的第一行是 `- insert:`；再出现顶层条目就说明已经越过它了
    if (line.startsWith('- ') && !seenEntry) {
      seenEntry = true
      end = index
      continue
    }
    if (seenEntry && /^\s/.test(line)) {
      end = index
      continue
    }
    break
  }
  // 连同标记前我们加的那个空行一起删
  const start = marker > 0 && lines[marker - 1].trim() === '' ? marker - 1 : marker
  lines.splice(start, end - start + 1)
  return { text: `${lines.join('\n').replace(/\s*$/, '')}\n`, removed: true }
}

/**
 * 本插件追加到 profile patch 末尾的那段。
 * @returns {string} YAML 片段（含前导空行）。
 */
function loaderBlock() {
  return [
    '',
    `# ${pkg.name}: 创建工作区对话框（名称 + 文件夹，原生选择器可延续上次所在的目录）`,
    '- insert:',
    `    - id: ${pkg.name.replace(/^dsh-/, 'ui-')}`,
    `      name: '${pkg.name}'`,
    '      # 想固定「新建位置」就取消下一行的注释（不写则由插件自动决定，界面里也能改）',
    '      # config:',
    "      #   baseDir: 'D:\\Work\\Workspaces'",
    '',
  ].join('\n')
}

/**
 * 跑一次安装或卸载。
 * @returns {Promise<void>} 结束后 resolve。
 */
async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const uninstall = process.argv.includes('--uninstall')
  const env = (key) => {
    const value = process.env[key]?.trim()
    return value === undefined || value === '' ? undefined : value
  }
  // DSH home 的解析顺序与官方一致：显式配置 > $DSH_HOME > ~/.dsh
  // （见桌面端 lib/main.js 的 resolveDshHome）。空白值视为未设置。
  const dshHome = env('DSH_HOME') ?? join(homedir(), '.dsh')
  const profileDir = env('DSH_PROFILE_DIR') ?? join(dshHome, 'profiles', env('DSH_PROFILE') ?? 'desktop')
  const target = join(profileDir, 'node_modules', pkg.name)
  const patchFile = join(profileDir, 'cordis.patch.yml')

  if (!existsSync(profileDir)) {
    console.error(`找不到 profile 目录：${profileDir}`)
    console.error('请确认 DSH 装好并至少启动过一次，或设置 DSH_HOME / DSH_PROFILE。')
    process.exit(1)
  }

  console.log(`插件：${pkg.name}`)
  console.log(`DSH home：${dshHome}`)
  console.log(`profile：${profileDir}`)

  if (uninstall) {
    console.log(dryRun ? '模式：dry-run（不写任何文件）' : '模式：卸载')
    const { text, removed } = stripOurLoaderRow(await readFile(patchFile, 'utf8'), pkg.name)
    if (!dryRun && removed) {
      await writeFile(patchFile, text, 'utf8')
      await rm(target, { recursive: true, force: true })
    }
    console.log(removed
      ? `${dryRun ? '将删除' : '已删除'}：cordis.patch.yml 里的 loader 行，以及 ${target}`
      : 'cordis.patch.yml 里没有本插件的 loader 行，未做任何改动。')
    console.log('重启一次 DeepSeek Harness 后生效。')
    return
  }

  const files = pkg.files ?? ['lib', 'cordis.patch.yml']
  const entries = ['package.json', ...files]
  console.log(`目标：${target}`)
  console.log(dryRun ? '模式：dry-run（不写任何文件）' : '模式：写入')

  // 1) 拷包。先删目标再拷，保证被删掉的文件不会留在旧版本里。
  //
  // package.json 必须一起拷：`files` 字段只描述「哪些文件属于这个包」，而 loader
  // 正是靠 package.json 的 main / exports / dsh.client 才能解析到宿主半区与浏览器
  // 半区。少了它，插件在 node_modules 里存在但加载不起来。
  if (!dryRun) {
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    for (const entry of entries) {
      await cp(join(ROOT, entry), join(target, entry), { recursive: true })
    }
  }
  console.log(`${dryRun ? '将拷贝' : '已拷贝'}：${entries.join('、')}`)

  // 2) 补 profile patch。以包名出现作为「已经装过」的判据。
  const patch = await readFile(patchFile, 'utf8')
  if (patch.includes(`'${pkg.name}'`)) {
    console.log('cordis.patch.yml 里已有本插件的 loader 行，保持不变。')
  } else {
    if (!dryRun) await writeFile(patchFile, `${patch.replace(/\s*$/, '')}\n${loaderBlock()}`, 'utf8')
    console.log(`${dryRun ? '将追加' : '已追加'}：cordis.patch.yml 末尾的 loader 行。`)
  }

  if (!dryRun) {
    for (const entry of entries) {
      if (!existsSync(join(target, entry))) {
        console.error(`拷贝结果不完整，缺少 ${entry}`)
        process.exit(1)
      }
    }
  }

  console.log('')
  console.log('完成。宿主半区是 Node 模块，需要重启 DeepSeek Harness 才会加载；')
  console.log('重启后浏览器半区随页面加载，之后改 lib/client.js 只需刷新页面（改 lib/index.js 仍需重启）。')
}

// 作为脚本运行时才执行；被自测 import 时只拿到上面那些纯函数。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
