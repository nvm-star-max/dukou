import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export function pickerCommands(platform, kind) {
  if (!["file", "directory"].includes(kind))
    throw new Error("Invalid picker type");
  if (platform === "darwin") {
    const target = kind === "file" ? "file" : "folder";
    return [
      {
        command: "osascript",
        args: [
          "-e",
          `POSIX path of (choose ${target} with prompt "选择要公开的${kind === "file" ? "文件" : "文件夹"}")`,
        ],
      },
    ];
  }
  if (platform === "win32") {
    const dialog = kind === "file" ? "OpenFileDialog" : "FolderBrowserDialog";
    const selected = kind === "file" ? "FileName" : "SelectedPath";
    const script = `Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.${dialog}; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.${selected}) }`;
    return [
      {
        command: "powershell.exe",
        args: ["-NoProfile", "-STA", "-Command", script],
      },
    ];
  }
  if (platform === "linux") {
    return [
      {
        command: "zenity",
        args: [
          "--file-selection",
          ...(kind === "directory" ? ["--directory"] : []),
        ],
      },
      {
        command: "kdialog",
        args:
          kind === "directory"
            ? ["--getexistingdirectory"]
            : ["--getopenfilename"],
      },
    ];
  }
  throw new Error("此系统尚不支持原生文件选择器");
}

export async function pickLocalPath(
  kind,
  platform = process.platform,
  run = runFile,
) {
  for (const { command, args } of pickerCommands(platform, kind)) {
    try {
      const { stdout } = await run(command, args, { timeout: 5 * 60_000 });
      return stdout.replace(/\r?\n$/, "") || null;
    } catch (error) {
      if (error.code === "ENOENT") continue;
      if (error.code === 1 || /User canceled|(-128)/.test(error.message))
        return null;
      throw error;
    }
  }
  throw new Error("未找到系统文件选择器，请安装 Zenity/KDialog 或手动输入路径");
}
