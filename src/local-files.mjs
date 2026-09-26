import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function localFiles(
  requested,
  { kind = "directory", excluded = [] } = {},
) {
  if (!["file", "directory"].includes(kind))
    throw new Error("Invalid picker type");
  if (
    requested &&
    (typeof requested !== "string" ||
      requested.length > 4096 ||
      !path.isAbsolute(requested))
  )
    throw new Error("请输入有效的绝对路径");
  const locations = [
    { label: "主目录", path: os.homedir() },
    { label: "当前目录", path: process.cwd() },
  ];
  if (process.platform === "win32") {
    for (let code = 65; code <= 90; code++) {
      const drive = `${String.fromCharCode(code)}:\\`;
      try {
        if ((await fs.stat(drive)).isDirectory())
          locations.push({ label: drive, path: drive });
      } catch {
        /* Drive unavailable. */
      }
    }
  } else {
    locations.push({ label: "文件系统", path: "/" });
  }
  const storage = path.join(os.homedir(), "storage", "shared");
  try {
    if ((await fs.stat(storage)).isDirectory())
      locations.unshift({ label: "共享存储", path: storage });
  } catch {
    /* Not running under Termux storage access. */
  }
  const current = await fs.realpath(requested || os.homedir());
  if (!(await fs.stat(current)).isDirectory()) throw new Error("不是文件夹");
  const blocked = await Promise.all(
    excluded.map((item) => fs.realpath(item).catch(() => path.resolve(item))),
  );
  const isBlocked = (target) =>
    blocked.some(
      (item) => target === item || target.startsWith(item + path.sep),
    );
  if (isBlocked(current)) throw new Error("应用私有数据不可浏览");
  const entries = [];
  for (const name of await fs.readdir(current)) {
    const full = path.join(current, name);
    try {
      const actual = await fs.realpath(full);
      if (isBlocked(actual)) continue;
      const stats = await fs.stat(full);
      if (stats.isDirectory() || (kind === "file" && stats.isFile()))
        entries.push({ name, path: full, directory: stats.isDirectory() });
    } catch {
      /* Skip unreadable and broken links. */
    }
  }
  entries.sort(
    (a, b) =>
      Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
  );
  return {
    path: current,
    parent: path.dirname(current) === current ? null : path.dirname(current),
    locations: locations.filter((item) => !isBlocked(path.resolve(item.path))),
    entries: entries.slice(0, 500),
    truncated: entries.length > 500,
  };
}
