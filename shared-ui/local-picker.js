import { localize } from "/i18n.js";

export async function openLocalPicker({
  endpoint,
  kind = "directory",
  onSelect,
}) {
  const icon = (name) => {
    const image = document.createElement("img");
    image.src = `/icons/${name}.svg`;
    image.alt = "";
    return image;
  };
  const dialog = document.createElement("dialog");
  dialog.className = "local-picker";
  dialog.innerHTML = `<div class="local-picker-head"><div><small>THIS DEVICE</small><h2>选择${kind === "file" ? "文件" : "文件夹"}</h2></div><button type="button" class="local-picker-close" aria-label="关闭"><img src="/icons/x.svg" alt="" /></button></div><div class="local-picker-locations"></div><div class="local-picker-path"></div><div class="local-picker-list" role="list"></div><div class="local-picker-foot"><span class="local-picker-hint"></span><button type="button" class="local-picker-hidden"><img src="/icons/eye.svg" alt="" />显示隐藏项</button><button type="button" class="local-picker-cancel">取消</button><button type="button" class="local-picker-select">选择当前文件夹</button></div>`;
  document.body.append(dialog);
  const find = (name) => dialog.querySelector(`.local-picker-${name}`);
  const close = () => dialog.close();
  find("close").onclick = close;
  find("cancel").onclick = close;
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  let current = null;
  let safeLocations = [];
  let showHidden = false;
  let request = 0;
  find("hidden").onclick = () => {
    showHidden = !showHidden;
    find("hidden").replaceChildren(
      icon(showHidden ? "eye-off" : "eye"),
      showHidden ? "隐藏隐藏项" : "显示隐藏项",
    );
    load(current);
  };
  const load = async (target) => {
    const thisRequest = ++request;
    find("list").textContent = "正在读取…";
    try {
      const query = new URLSearchParams({ kind });
      if (target) query.set("path", target);
      const response = await fetch(`${endpoint}?${query}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "无法读取此位置");
      if (thisRequest !== request) return;
      current = result.path;
      safeLocations = result.locations;
      find("path").textContent = result.path;
      find("path").translate = false;
      find("path").title = result.path;
      const locationButtons = find("locations");
      locationButtons.replaceChildren();
      for (const place of result.locations) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = place.label;
        button.onclick = () => load(place.path);
        locationButtons.append(button);
      }
      const list = find("list");
      list.replaceChildren();
      if (result.parent) {
        const back = document.createElement("button");
        back.type = "button";
        back.className = "local-picker-entry";
        back.append(icon("arrow-up"), "上一级");
        back.onclick = () => load(result.parent);
        list.append(back);
      }
      for (const item of result.entries) {
        if (!showHidden && item.name.startsWith(".")) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "local-picker-entry";
        const symbol = icon(item.directory ? "folder" : "file");
        const label = document.createElement("span");
        label.textContent = item.name;
        label.translate = false;
        button.append(symbol, label);
        button.onclick = item.directory
          ? () => load(item.path)
          : () => select(item.path);
        list.append(button);
      }
      if (!list.children.length) list.append("此位置没有可选择的项目");
      find("hint").textContent = result.truncated
        ? "仅显示前 500 项，可继续进入子目录"
        : `${result.entries.filter((item) => showHidden || !item.name.startsWith(".")).length} 项`;
      find("select").hidden = kind === "file";
    } catch (error) {
      if (thisRequest === request) find("list").textContent = error.message;
    }
  };
  const select = async (selected) => {
    if (
      kind === "directory" &&
      safeLocations.some(
        (item) =>
          ["主目录", "文件系统"].includes(item.label) && item.path === selected,
      ) &&
      !window.confirm(
        localize("此位置可能包含账号密钥及其他私人文件。确定公开整个目录吗？"),
      )
    )
      return;
    const button = find("select");
    button.disabled = true;
    try {
      await onSelect(selected);
      close();
    } catch (error) {
      find("hint").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  find("select").onclick = () => current && select(current);
  dialog.showModal();
  await load();
}
