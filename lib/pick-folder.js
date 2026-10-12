/**
 * 原生「选择文件夹」对话框。
 *
 * 为什么自己写一个：harness 桌面端的文件夹对话框由 Electron 主进程打开
 * （`lib/main.js` 里的 `dialog.showOpenDialog(win, { properties: ['openDirectory',
 * 'createDirectory'] })`），**没有传 defaultPath**，所以每次都是从系统默认位置
 * 开始，不会延续上次所在的目录。插件既够不到 Electron 主进程，也改不了那句调用，
 * 因此想让「延续上次目录」成立，只能自己开一个对话框。
 *
 * 实现方式：把一段最小的 C# COM 互操作（IFileDialog + IShellItem）交给 Windows
 * PowerShell 5.1 编译并执行。选它而不是打包 koffi 之类的原生依赖，是因为：
 * - Windows PowerShell 5.1 是系统自带，不需要任何额外安装；
 * - 编译在内存里完成（实测约 120 ms），因此不需要维护 DLL 缓存——没有缓存文件
 *   就也没有「缓存损坏」「文件被占用」这类只在少数机器上冒出来的故障；
 * - 对话框跑在子进程里，原生崩溃不会带走宿主进程。
 *
 * 关键的一步是 `IFileDialog::SetFolder`：把上次目录作为起始位置传进去，这正是
 * harness 自带对话框缺的那一步。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 最小 C# 互操作。方法声明顺序必须与 COM vtable 一致——CLR 按声明顺序算槽位，
 * 顺序错了就是调错函数（SetFolder 会打到 GetFolder 上）。
 *
 * 槽位对照（IUnknown 占 0-2）：Show=3、SetOptions=9、SetFolder=12、SetTitle=17、
 * GetResult=20；IShellItem 里 GetDisplayName=5。这份对照与 harness 自带的
 * `dsh-host-directory-picker-native` 用的是同一套（它用 koffi 直接按槽位调用）。
 */
const CSHARP_SOURCE = `using System;
using System.IO;
using System.Runtime.InteropServices;

[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDshFileDialog
{
    [PreserveSig]
    int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IDshShellItem psi);
    void SetFolder(IDshShellItem psi);
    void GetFolder(out IDshShellItem ppsi);
    void GetCurrentSelection(out IDshShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IDshShellItem ppsi);
}

[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDshShellItem
{
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IDshShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IDshShellItem psi, uint hint, out int piOrder);
}

/** CLSID_FileOpenDialog 的最小 coclass 声明，只用来 CoCreateInstance。 */
[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
internal class DshFileOpenDialog { }

public static class DshWorkspaceFolderPicker
{
    /** FOS_PICKFOLDERS：选目录而不是选文件。 */
    private const uint FOS_PICKFOLDERS = 0x20;
    /** FOS_FORCEFILESYSTEM：结果必须是文件系统路径。 */
    private const uint FOS_FORCEFILESYSTEM = 0x40;
    /** FOS_PATHMUSTEXIST：只允许已存在的目录。 */
    private const uint FOS_PATHMUSTEXIST = 0x800;
    /** SIGDN_FILESYSPATH：要真正的盘符路径，而不是显示名。 */
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    /** ERROR_CANCELLED：用户点了取消，不是错误。 */
    private const int HRESULT_CANCELLED = unchecked((int)0x800704C7);
    private const byte VK_MENU = 0x12;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IDshShellItem ppv);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    /**
     * 让后台宿主拉起的对话框能激活到前台：合成一次 Alt 按下+抬起。
     * 与 harness 自带原生选择器用的是同一手法（它在 Show 之前也这么做）。
     */
    private static void PressAltForForeground()
    {
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    /**
     * 打开选择窗口。
     * @param title 窗口标题。
     * @param initialPath 起始目录；不存在或不可用时退化为系统默认位置。
     * @param probe 只验证 COM 调用链，不弹窗（自测用）。
     * @returns 所选绝对路径；用户取消时为空；probe 模式返回 probe:ok。
     */
    public static string Pick(string title, string initialPath, bool probe)
    {
        IDshFileDialog dialog = (IDshFileDialog)new DshFileOpenDialog();
        try
        {
            dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
            if (!string.IsNullOrEmpty(title))
            {
                dialog.SetTitle(title);
            }
            if (!string.IsNullOrEmpty(initialPath) && Directory.Exists(initialPath))
            {
                Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
                try
                {
                    IDshShellItem folder;
                    SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref iid, out folder);
                    if (folder != null)
                    {
                        dialog.SetFolder(folder);
                        Marshal.ReleaseComObject(folder);
                    }
                }
                catch (Exception)
                {
                    // 起始目录无效（网络路径掉线、权限不足）不该让整次选择失败
                }
            }
            if (probe)
            {
                return "probe:ok";
            }
            PressAltForForeground();
            int hr = dialog.Show(IntPtr.Zero);
            if (hr != 0)
            {
                if (hr == HRESULT_CANCELLED)
                {
                    return null;
                }
                throw new COMException("IFileDialog.Show failed", hr);
            }
            IDshShellItem result = null;
            try
            {
                dialog.GetResult(out result);
                string path;
                result.GetDisplayName(SIGDN_FILESYSPATH, out path);
                return path;
            }
            finally
            {
                if (result != null)
                {
                    Marshal.ReleaseComObject(result);
                }
            }
        }
        finally
        {
            Marshal.ReleaseComObject(dialog);
        }
    }
}`

/**
 * 交给 Windows PowerShell 执行的完整脚本。
 *
 * 用单引号 here-string 包住 C#（内部不做任何变量展开），脚本本体只做三件事：
 * 在内存里编译这段 C#、调用 Pick、把结果写到 stdout。
 * 起始目录、标题、探针开关都经环境变量传入，避免命令行引号转义问题。
 */
const SCRIPT_SOURCE = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$source = @'
${CSHARP_SOURCE}
'@
Add-Type -TypeDefinition $source
$probe = ($env:DSH_WS_PROBE -eq '1')
$result = [DshWorkspaceFolderPicker]::Pick($env:DSH_WS_TITLE, $env:DSH_WS_INITIAL, $probe)
if (-not [string]::IsNullOrEmpty($result)) { [Console]::Out.Write($result) }
`

/** 对话框窗口标题。 */
export const DIALOG_TITLE = '选择工作区文件夹'

/**
 * 脚本全文（自测直接检查它，不必真的执行）。
 * @returns {string} PowerShell 脚本。
 */
export function buildScript() {
  return SCRIPT_SOURCE
}

/**
 * `-EncodedCommand` 需要 base64 编码的 UTF-16LE 文本：这样中文标题、路径和
 * 整段 C# 都不会经过命令行引号解析。
 * @returns {string} base64 文本。
 */
export function encodedCommand() {
  return Buffer.from(SCRIPT_SOURCE, 'utf16le').toString('base64')
}

/**
 * Windows PowerShell 5.1 的可执行文件。系统自带，因此不需要任何依赖安装。
 * @returns {string} 可执行文件路径（找不到时退回 PATH 上的名字）。
 */
export function powershellPath() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const full = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(full) ? full : 'powershell.exe'
}

/**
 * 打开原生文件夹对话框并等用户选完。
 *
 * 每次调用都会在子进程里重新编译那段 C#（实测约 120 ms，相对一次真人选目录
 * 可以忽略），换来的是完全没有缓存文件生命周期要维护。
 *
 * 没有超时：这是一次真人交互，用户可能翻很久目录；中止它的唯一方式是关掉窗口。
 * @param {object} [options] - 参数。
 * @param {string} [options.initialDir] - 起始目录（上次所在目录）。
 * @param {string} [options.title] - 窗口标题。
 * @param {boolean} [options.probe] - 只验证 COM 调用链，不弹窗。
 * @returns {Promise<{path: string | null}>} 所选路径；取消时 path 为 null。
 * @throws {Error} PowerShell 启动失败、编译失败或对话框自身报错时抛出（带 stderr 摘要）。
 */
export async function pickFolder(options = {}) {
  const { initialDir = '', title = DIALOG_TITLE, probe = false } = options
  const env = {
    ...process.env,
    DSH_WS_TITLE: title,
    DSH_WS_INITIAL: initialDir,
    DSH_WS_PROBE: probe ? '1' : '0',
  }
  const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand()]
  // windowsHide 只隐藏 powershell 自己的控制台窗口，原生对话框照常显示
  const child = spawn(powershellPath(), args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  return await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => reject(new Error(`原生文件夹对话框启动失败：${error.message}`)))
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/).slice(-4).join(' | ')
        reject(new Error(`原生文件夹对话框失败（退出码 ${String(code)}）：${detail}`))
        return
      }
      const path = stdout.trim()
      resolve({ path: path === '' ? null : path })
    })
  })
}
