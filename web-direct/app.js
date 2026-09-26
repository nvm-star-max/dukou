import { openLocalPicker } from "/local-picker.js";
import { installI18n, localize } from "/i18n.js";

installI18n([".auth-top", ".top-right"]);

const $ = (selector) => document.querySelector(selector);
const state = {
  status: null,
  roots: [],
  rootId: null,
  path: "",
  files: [],
  activity: [],
  admin: null,
  loginMode: "password",
  searchTimer: null,
  requestId: 0,
};
let toastTimer;

function icon(name) {
  const image = document.createElement("img");
  image.src = `/icons/${name}.svg`;
  image.alt = "";
  return image;
}
function node(tag, className = "", content) {
  const item = document.createElement(tag);
  item.className = className;
  if (content !== undefined) item.textContent = content;
  return item;
}
function toast(message, preserve = false) {
  const item = $("#toast");
  item.translate = !preserve;
  item.textContent = message;
  item.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => item.classList.remove("show"), 4500);
}
async function api(endpoint, options = {}) {
  const response = await fetch(endpoint, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
const post = (endpoint, value) =>
  api(endpoint, { method: "POST", body: JSON.stringify(value) });
function size(bytes) {
  if (bytes === null || bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024,
    index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}
function date(value) {
  return value
    ? new Date(value).toLocaleDateString(document.documentElement.lang, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
    : "";
}
function root() {
  return state.roots.find((item) => item.id === state.rootId);
}
function selectedUrl() {
  return state.status?.addresses?.[0] || location.origin;
}

function showAuth() {
  $("#app").classList.add("hidden");
  $("#auth").classList.remove("hidden");
  const setup = !state.status.configured;
  $("#auth-title").textContent = setup ? "设置这台主机" : "连接到文件";
  $("#auth-subtitle").textContent = setup
    ? state.status.local
      ? "创建主机账号，之后可邀请其他电脑访问"
      : "等待主机完成初次设置"
    : "使用账号密码或访问密钥登录";
  $("#login-switch").classList.toggle("hidden", setup);
  $("#auth-form").classList.toggle("hidden", setup && !state.status.local);
  $("#auth-submit").textContent = setup ? "建立主机" : "进入文件";
  $("#password").autocomplete = setup ? "new-password" : "current-password";
  if (setup) setLoginMode("password");
  $("#auth-fingerprint").textContent = state.status.fingerprint
    ? `证书 SHA-256  ${state.status.fingerprint}`
    : "";
}
function setLoginMode(mode) {
  state.loginMode = mode;
  $("#mode-password").classList.toggle("active", mode === "password");
  $("#mode-key").classList.toggle("active", mode === "key");
  $("#username-wrap").classList.toggle("hidden", mode === "key");
  $("#password-wrap").classList.toggle("hidden", mode === "key");
  $("#key-wrap").classList.toggle("hidden", mode !== "key");
  $("#username").required = mode === "password";
  $("#password").required = mode === "password";
  $("#access-key").required = mode === "key";
}
function showApp() {
  $("#auth").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#host-name").textContent = state.status.hostName;
  $("#admin-tab").classList.toggle("hidden", !state.status.admin);
  $("#scope-badge").textContent =
    state.status.mode === "whole" ? "整机只读" : "指定文件";
  $("#current-address").textContent = location.origin;
  $("#admin-address").textContent = selectedUrl();
  $("#cert-fingerprint").textContent =
    state.status.fingerprint || "本机 HTTP 测试";
  $("#upload-button").classList.toggle("hidden", !state.status.allowUpload);
}
function view(name) {
  $("#files-view").classList.toggle("hidden", name !== "files");
  $("#admin-view").classList.toggle("hidden", name !== "admin");
  $("#files-tab").classList.toggle("active", name === "files");
  $("#admin-tab").classList.toggle("active", name === "admin");
  if (name === "admin") loadAdmin();
}
function renderRoots() {
  const container = $("#roots");
  container.replaceChildren();
  if (!state.roots.length)
    container.append(node("div", "files-empty", "尚未公开文件"));
  for (const item of state.roots) {
    const button = node(
      "button",
      `root ${state.rootId === item.id ? "active" : ""}`,
    );
    button.type = "button";
    button.append(
      icon(item.type === "file" ? "file" : "folder"),
      node("span", "", item.label),
    );
    button.querySelector("span").translate = item.id === "system";
    button.onclick = () => {
      state.rootId = item.id;
      state.path = "";
      $("#search").value = "";
      renderRoots();
      loadFiles();
    };
    container.append(button);
  }
  $("#location-title").textContent = root()?.label || "选择位置";
  $("#location-title").translate = !root() || root().id === "system";
}
function renderBreadcrumbs() {
  const holder = $("#breadcrumbs");
  holder.replaceChildren();
  if (!root()) return;
  if ($("#search").value.trim()) {
    holder.append(node("span", "", "搜索结果"));
    return;
  }
  const parts = state.path ? state.path.split("/") : [];
  for (let index = 0; index <= parts.length; index++) {
    if (index) holder.append(icon("chevron-right"));
    const button = node("button", "", index ? parts[index - 1] : root().label);
    button.translate = index === 0 && root().id === "system";
    button.type = "button";
    button.onclick = () => {
      state.path = parts.slice(0, index).join("/");
      $("#search").value = "";
      loadFiles();
    };
    holder.append(button);
  }
}
function renderFiles() {
  renderBreadcrumbs();
  const list = $("#files");
  list.replaceChildren();
  const empty = $("#files-empty");
  empty.hidden = state.files.length > 0;
  empty.textContent = !root()
    ? "请选择左侧的共享位置"
    : $("#search").value
      ? "没有找到匹配文件"
      : "此处暂无文件";
  const files = [...state.files].sort(
    (a, b) =>
      Number(b.directory) - Number(a.directory) ||
      a.name.localeCompare(b.name, "zh-CN"),
  );
  for (const file of files) {
    const filePath =
      file.path !== undefined
        ? file.path
        : [state.path, file.name].filter(Boolean).join("/");
    const row = node("div", "file-row");
    const title = node("div", "file-title");
    const name = node("button", "", file.path || file.name);
    name.translate = false;
    name.type = "button";
    name.title = file.path || file.name;
    name.onclick = file.directory
      ? () => enterFolder(filePath)
      : () => download(filePath);
    title.append(icon(file.directory ? "folder" : "file"), name);
    const action = node(
      "button",
      "row-action",
      file.directory ? "打开" : "拉取",
    );
    action.type = "button";
    action.append(icon(file.directory ? "arrow-right" : "download"));
    action.onclick = file.directory
      ? () => enterFolder(filePath)
      : () => download(filePath);
    row.append(
      title,
      node("span", "file-muted", size(file.size)),
      node("span", "file-muted modified", date(file.modified)),
      action,
    );
    list.append(row);
  }
}
function enterFolder(folder) {
  state.path = folder;
  $("#search").value = "";
  loadFiles();
}
async function loadFiles() {
  const current = ++state.requestId;
  if (!root()) {
    state.files = [];
    renderFiles();
    return;
  }
  $("#files-empty").hidden = false;
  $("#files-empty").textContent = "正在读取";
  $("#files").replaceChildren();
  try {
    const result = await api(
      `/api/list?root=${encodeURIComponent(state.rootId)}&path=${encodeURIComponent(state.path)}`,
    );
    if (current === state.requestId) {
      state.files = result.files;
      renderFiles();
    }
  } catch (error) {
    if (current === state.requestId) {
      state.files = [];
      $("#files-empty").textContent = error.message;
      $("#files-empty").hidden = false;
    }
  }
}
async function searchFiles() {
  const query = $("#search").value.trim();
  if (!query) return loadFiles();
  if (!root()) return;
  const current = ++state.requestId;
  $("#files").replaceChildren();
  $("#files-empty").hidden = false;
  $("#files-empty").textContent = "正在搜索";
  try {
    const result = await api(
      `/api/search?root=${encodeURIComponent(state.rootId)}&q=${encodeURIComponent(query)}`,
    );
    if (current === state.requestId) {
      state.files = result.files;
      renderFiles();
      if (result.limited) toast("仅显示前 100 个结果");
    }
  } catch (error) {
    if (current === state.requestId) {
      state.files = [];
      $("#files-empty").textContent = error.message;
    }
  }
}
function download(filePath) {
  const link = document.createElement("a");
  link.href = `/api/download?root=${encodeURIComponent(state.rootId)}&path=${encodeURIComponent(filePath)}`;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
  toast("下载已开始。可从浏览器下载记录打开文件所在位置。");
  setTimeout(loadActivity, 700);
}
function renderActivity() {
  const list = $("#activity");
  list.replaceChildren();
  if (!state.activity.length)
    list.append(node("div", "files-empty", "暂无传输记录"));
  for (const item of state.activity.slice(0, 12)) {
    const row = node("div", "activity-item");
    row.append(
      icon(
        item.kind === "upload"
          ? "upload"
          : item.kind === "download"
            ? "download"
            : "shield-check",
      ),
      node("strong", "", item.name),
      node("span", "", date(item.at)),
    );
    row.querySelector("strong").translate = false;
    list.append(row);
  }
  renderInbox();
}
function renderInbox() {
  if (!state.status?.admin) return;
  const list = $("#inbox-list");
  list.replaceChildren();
  const uploads = state.activity.filter(
    (item) => item.kind === "upload" && item.stored,
  );
  if (!uploads.length)
    list.append(node("div", "files-empty", "收件箱暂无文件"));
  for (const item of uploads) {
    const row = node("div", "inbox-item");
    row.append(node("span", "", item.name), node("time", "", date(item.at)));
    row.querySelector("span").translate = false;
    const button = node("button", "", "打开所在位置");
    button.type = "button";
    button.onclick = async () => {
      try {
        await post("/api/admin/open-location", { name: item.stored });
      } catch (error) {
        toast(error.message);
      }
    };
    row.append(button);
    list.append(row);
  }
}
async function loadActivity() {
  try {
    state.activity = (await api("/api/activity")).activity;
    renderActivity();
  } catch (error) {
    toast(error.message);
  }
}
async function loadAdmin() {
  if (!state.status.admin) return;
  try {
    state.admin = await api("/api/admin");
    renderAdmin();
    await loadActivity();
  } catch (error) {
    toast(error.message);
  }
}
function renderAdmin() {
  const admin = state.admin;
  if (!admin) return;
  $("#mode-folders").classList.toggle("active", admin.mode === "folders");
  $("#mode-whole").classList.toggle("active", admin.mode === "whole");
  $("#whole-warning").classList.toggle("hidden", admin.mode !== "whole");
  $("#shared-roots").classList.toggle("hidden", admin.mode === "whole");
  $("#allow-upload").checked = admin.allowUpload;
  $("#upload-limit").value = admin.maxUploadMB;
  $("#inbox-path").textContent = admin.inbox;
  const container = $("#admin-roots");
  container.replaceChildren();
  if (!admin.roots.length)
    container.append(node("div", "files-empty", "尚未指定公开位置"));
  for (const item of admin.roots) {
    const row = node("div", "admin-root");
    const detail = node("div");
    detail.append(node("strong", "", item.label), node("code", "", item.path));
    detail.querySelector("strong").translate = false;
    const remove = node("button");
    remove.title = `移除 ${item.label}`;
    remove.setAttribute("aria-label", `移除 ${item.label}`);
    remove.append(icon("trash-2"));
    remove.onclick = async () => {
      try {
        await post("/api/admin/roots", { action: "remove", rootId: item.id });
        toast("公开位置已移除");
        await reloadScope();
      } catch (error) {
        toast(error.message);
      }
    };
    row.append(icon(item.type === "file" ? "file" : "folder"), detail, remove);
    container.append(row);
  }
  renderInbox();
}
async function reloadScope() {
  const results = await Promise.all([
    api("/api/status"),
    api("/api/roots"),
    api("/api/admin"),
  ]);
  state.status = results[0];
  state.roots = results[1].roots;
  state.admin = results[2];
  if (!state.roots.some((item) => item.id === state.rootId)) {
    state.rootId = state.roots[0]?.id || null;
    state.path = "";
  }
  showApp();
  renderRoots();
  renderAdmin();
  loadFiles();
}
function keyDialog(accessKey) {
  $("#key-value").textContent = accessKey;
  $("#key-dialog").showModal();
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
  } catch {
    toast("复制失败，请手动选择文本");
  }
}

$("#auth-form").onsubmit = async (event) => {
  event.preventDefault();
  $("#auth-error").textContent = "";
  const setup = !state.status.configured;
  const payload =
    state.loginMode === "key" && !setup
      ? { accessKey: $("#access-key").value }
      : {
          username: $("#username").value.trim(),
          password: $("#password").value,
        };
  try {
    const result = await post(setup ? "/api/setup" : "/api/login", payload);
    $("#password").value = "";
    $("#access-key").value = "";
    await boot();
    if (result.accessKey) keyDialog(result.accessKey);
  } catch (error) {
    $("#auth-error").textContent = error.message;
  }
};
$("#mode-password").onclick = () => setLoginMode("password");
$("#mode-key").onclick = () => setLoginMode("key");
$("#files-tab").onclick = () => view("files");
$("#admin-tab").onclick = () => view("admin");
$("#logout").onclick = async () => {
  try {
    await post("/api/logout", {});
    state.status = await api("/api/status");
    showAuth();
  } catch (error) {
    toast(error.message);
  }
};
$("#copy-address").onclick = () => copy(location.origin);
$("#copy-host-address").onclick = () => copy(selectedUrl());
$("#refresh-files").onclick = () =>
  $("#search").value.trim() ? searchFiles() : loadFiles();
$("#search").oninput = () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(searchFiles, 280);
};
$("#upload-button").onclick = () => $("#file-input").click();
$("#file-input").onchange = async (event) => {
  for (const file of event.target.files) {
    try {
      const response = await fetch(
        `/api/upload?name=${encodeURIComponent(file.name)}`,
        { method: "POST", credentials: "same-origin", body: file },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "上传失败");
      toast(`${file.name} · ${localize("已送达主机收件箱")}`, true);
    } catch (error) {
      toast(error.message);
    }
  }
  event.target.value = "";
  loadActivity();
};
$("#mode-folders").onclick = async () => {
  try {
    await post("/api/admin/mode", { mode: "folders" });
    await reloadScope();
    toast("已切换为指定文件");
  } catch (error) {
    toast(error.message);
  }
};
$("#mode-whole").onclick = () => {
  $("#whole-warning").classList.remove("hidden");
  $("#whole-confirm").focus();
};
$("#confirm-whole").onclick = async () => {
  if (!$("#whole-understand").checked) return toast("请先确认风险");
  try {
    await post("/api/admin/mode", {
      mode: "whole",
      confirmation: $("#whole-confirm").value,
    });
    await reloadScope();
    toast("整机只读已开启");
  } catch (error) {
    toast(error.message);
  }
};
$("#add-root-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await post("/api/admin/roots", {
      action: "add",
      directory: $("#new-root").value.trim(),
    });
    $("#new-root").value = "";
    await reloadScope();
    toast("公开位置已添加");
  } catch (error) {
    toast(error.message);
  }
};
function pickRoot(kind) {
  openLocalPicker({
    endpoint: "/api/admin/local-files",
    kind,
    onSelect: async (directory) => {
      await post("/api/admin/roots", { action: "add", directory });
      await reloadScope();
      toast("公开位置已添加");
    },
  });
}
$("#pick-folder").onclick = () => pickRoot("directory");
$("#pick-file").onclick = () => pickRoot("file");
$("#rotate-key").onclick = async () => {
  if (!window.confirm(localize("轮换后，旧访问密钥无法再登录。继续？"))) return;
  try {
    keyDialog((await post("/api/admin/key", {})).accessKey);
  } catch (error) {
    toast(error.message);
  }
};
$("#save-options").onclick = async () => {
  try {
    await post("/api/admin/options", {
      allowUpload: $("#allow-upload").checked,
      maxUploadMB: Number($("#upload-limit").value),
    });
    await reloadScope();
    toast("接收设置已保存");
  } catch (error) {
    toast(error.message);
  }
};
$("#copy-key").onclick = () => copy($("#key-value").textContent);
$("#close-key-dialog").onclick = () => $("#key-dialog").close();

async function boot() {
  state.status = await api("/api/status");
  if (!state.status.authorized) {
    showAuth();
    return;
  }
  state.roots = (await api("/api/roots")).roots;
  if (!state.roots.some((item) => item.id === state.rootId))
    state.rootId = state.roots[0]?.id || null;
  showApp();
  renderRoots();
  await Promise.all([loadFiles(), loadActivity()]);
  if (state.status.admin) await loadAdmin();
}
boot().catch((error) => {
  $("#auth-error").textContent = error.message;
  $("#auth").classList.remove("hidden");
});
