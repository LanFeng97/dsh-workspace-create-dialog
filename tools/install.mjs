/**
 * 安装/更新本插件到当前 DSH profile。
 *
 * 做法与工作区里既有的 dsh-skill-panel 一致，也是这台机器上已经验证可用的做法：
 * 1. 把包按 `files` 清单拷进 `$DSH_HOME/profiles/<profile>/node_modules/<包名>`；
 * 2. 在 profile 的 `cordis.patch.yml` 末尾补一条 insert loader 行（幂等：已有就跳过）。
 *
 * 为什么不 `pnpm add file:`：那会动 profile 的 package.json 与 lockfile，
 * 一次 install 就可能把整个 profile 的依赖重排。拷贝 + patch 只影响两个位置，
 * 出问题也好手工回退。
 *
 * 这里**不写死任何路径**：不传 `baseDir`，「新建位置」就由插件自己解析（默认工作区
 * 所在的根目录，兜底 `<Documents>/deepseek-harness`）；想固定成某个目录，编辑
 * profile patch 里那条 loader 行的 `config.baseDir` 即可。
 *
 * 用法：
 *   node tools/install.mjs            # 安装/更新（已安装则覆盖文件）
 *   node tools/install.mjs --dry-run  # 只打印会做什么
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const dryRun = process.argv.includes('--dry-run')

// DSH home 的解析顺序与官方一致：显式配置 > $DSH_HOME > ~/.dsh
// （见桌面端 lib/main.js 的 resolveDshHome）。空白值视为未设置。
const dshHome = process.env.DSH_HOME?.trim() !== undefined && process.env.DSH_HOME?.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : join(homedir(), '.dsh')
const profile = process.env.DSH_PROFILE?.trim() !== undefined && process.env.DSH_PROFILE?.trim() !== ''
  ? process.env.DSH_PROFILE.trim()
  : 'desktop'
const profileDir = process.env.DSH_PROFILE_DIR?.trim() !== undefined && process.env.DSH_PROFILE_DIR?.trim() !== ''
  ? process.env.DSH_PROFILE_DIR.trim()
  : join(dshHome, 'profiles', profile)
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
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
console.log(`目标：${target}`)
console.log(dryRun ? '模式：dry-run（不写任何文件）' : '模式：写入')

// 1) 拷包。先删目标再拷，保证被删掉的文件不会留在旧版本里。
//
// package.json 必须一起拷：`files` 字段只描述「哪些文件属于这个包」，而 loader
// 正是靠 package.json 的 main / exports / dsh.client 才能解析到宿主半区与
// 浏览器半区。少了它，插件在 node_modules 里存在但加载不起来。
const files = pkg.files ?? ['lib', 'cordis.patch.yml']
const entries = ['package.json', ...files]
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
  // 刻意不写 config.baseDir：那会把某一台机器的路径固化给别人。
  // 「新建位置」由插件自己解析（默认工作区所在根目录 → 兜底 <Documents>/deepseek-harness），
  // 用户在创建窗口里改一次即可，改动落在状态文件里。
  const block = [
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
  if (!dryRun) await writeFile(patchFile, `${patch.replace(/\s*$/, '')}\n${block}`, 'utf8')
  console.log(`${dryRun ? '将追加' : '已追加'}：cordis.patch.yml 末尾的 loader 行。`)
}

if (!dryRun) {
  for (const entry of entries) {
    const copied = join(target, entry)
    if (!existsSync(copied)) {
      console.error(`拷贝结果不完整，缺少 ${entry}`)
      process.exit(1)
    }
  }
}

console.log('')
console.log('完成。宿主半区是 Node 模块，需要重启 DeepSeek Harness 才会加载；')
console.log('重启后浏览器半区随页面加载，之后改 lib/client.js 只需刷新页面（改 lib/index.js 仍需重启）。')