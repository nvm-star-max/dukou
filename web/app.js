import { openLocalPicker } from "/local-picker.js";
import { installI18n, localize } from "/i18n.js";

installI18n([".setup-form", ".top-actions"]);

const $ = (selector) => document.querySelector(selector);
const state = {
  status: null,
  devices: [],
  selected: null,
  path: "",
  files: [],
  transfers: [],
};
let toastTimer;
let searchTimer;
let fileRequest = 0;

function toast(message, preserve = false) {
  const el = $("#toast");
  el.translate = !preserve;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4200);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof Blob)
        ? { "content-type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}
const post = (path, value) =>
  api(path, { method: "POST", body: JSON.stringify(value) });
function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (["file-name", "device-name", "transfer-name"].includes(className))
    node.translate = false;
  if (text !== undefined) node.textContent = text;
  return node;
}
function showApp() {
  $("#setup").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#own-name").textContent = state.status.name;
  $("#own-fingerprint").textContent = state.status.fingerprint;
  if (!$("#settings-dialog").open)
    $("#share-directory").value = state.status.share || "";
  $("#downloads-directory").value = state.status.downloads || "";
  const connection = $("#connection");
  connection.textContent = state.status.connected ? "已连接" : "连接中";
  connection.classList.toggle("online", state.status.connected);
}
function renderDevices() {
  const list = $("#devices");
  list.replaceChildren();
  if (!state.devices.length)
    list.append(element("div", "empty", "暂无其他设备"));
  for (const device of state.devices) {
    const button = element(
      "button",
      `device ${state.selected === device.id ? "active" : ""}`,
    );
    const avatar = element(
      "span",
      "avatar",
      device.name.slice(0, 1).toUpperCase(),
    );
    const main = element("span", "device-main");
    main.append(
      element("span", "device-name", device.name),
      element(
        "span",
        `device-status ${device.online ? "online" : ""}`,
        device.online ? "在线" : "离线",
      ),
    );
    button.append(avatar, main);
    button.onclick = () => {
      state.selected = device.id;
      state.path = "";
      state.files = [];
      $("#file-search").value = "";
      renderDevices();
      renderFiles();
      loadFiles();
    };
    list.append(button);
  }
  const selected = state.devices.find((device) => device.id === state.selected);
  $("#device-title").textContent = selected ? selected.name : "选择设备";
  $("#device-title").translate = !selected;
  $("#send-button").disabled = !selected?.online;
  if (!$("#settings-dialog").open) renderPermissions();
}
function renderPermissions() {
  const list = $("#permission-list");
  list.replaceChildren();
  if (!state.devices.length)
    list.append(element("p", "muted", "还没有已连接的设备"));
  for (const device of state.devices) {
    const row = element("div", "permission");
    const head = element("div", "permission-head");
    head.append(
      element("strong", "device-name", device.name),
      element("code", "", device.fingerprint),
    );
    row.append(head);
    const flags = element("div", "permission-flags");
    for (const [key, label] of [
      ["browse", "浏览"],
      ["download", "下载"],
      ["upload", "推送给我"],
    ]) {
      const wrapper = element("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!device.permission[key];
      input.onchange = async () => {
        device.permission[key] = input.checked;
        try {
          await post("/api/permission", {
            deviceId: device.id,
            ...device.permission,
          });
          toast("权限已保存");
        } catch (error) {
          input.checked = !input.checked;
          device.permission[key] = input.checked;
          toast(error.message);
        }
      };
      wrapper.append(input, document.createTextNode(label));
      flags.append(wrapper);
    }
    row.append(flags);
    list.append(row);
    const remove = element(
      "button",
      "",
      device.sameAccount ? "撤销设备" : "解除配对",
    );
    remove.onclick = async () => {
      if (
        !window.confirm(
          `${localize(device.sameAccount ? "撤销这台设备？" : "解除这台设备的配对？")}\n${device.name}`,
        )
      )
        return;
      try {
        await post(device.sameAccount ? "/api/revoke" : "/api/unpair", {
          deviceId: device.id,
        });
        if (state.selected === device.id) {
          state.selected = null;
          state.files = [];
          renderFiles();
        }
        toast("设备已移除");
        $("#settings-dialog").close();
        await refresh();
      } catch (error) {
        toast(error.message);
      }
    };
    row.append(remove);
  }
}
function renderBreadcrumbs() {
  const parent = $("#breadcrumbs");
  parent.replaceChildren();
  if (!state.selected) return;
  if ($("#file-search").value.trim()) {
    parent.append(element("span", "", "搜索结果"));
    return;
  }
  const parts = state.path ? state.path.split("/") : [];
  for (let i = 0; i <= parts.length; i++) {
    if (i) parent.append(element("span", "", "/"));
    const button = element("button", "", i ? parts[i - 1] : "共享目录");
    button.translate = i === 0;
    button.onclick = () => {
      state.path = parts.slice(0, i).join("/");
      $("#file-search").value = "";
      loadFiles();
    };
    parent.append(button);
  }
}
function renderFiles() {
  renderBreadcrumbs();
  const list = $("#files");
  list.replaceChildren();
  const device = state.devices.find((item) => item.id === state.selected);
  const message = $("#file-message");
  if (!device) {
    message.textContent = "从左侧选择一台在线设备";
    message.hidden = false;
    return;
  }
  if (!device.online) {
    message.textContent = "设备当前离线";
    message.hidden = false;
    return;
  }
  const files = [...state.files].sort(
    (a, b) =>
      Number(b.directory) - Number(a.directory) ||
      a.name.localeCompare(b.name, "zh-CN"),
  );
  message.hidden = files.length > 0;
  if (!files.length)
    message.textContent = $("#file-search").value
      ? "没有匹配的文件"
      : "目录为空";
  for (const file of files) {
    const row = element("div", "file-row");
    row.append(
      element(
        "span",
        `file-icon ${file.directory ? "" : "file"}`,
        file.directory ? "▰" : "▤",
      ),
    );
    const name = element("button", "file-name", file.path || file.name);
    const remotePath =
      file.path || [state.path, file.name].filter(Boolean).join("/");
    if (file.directory)
      name.onclick = () => {
        state.path = remotePath;
        $("#file-search").value = "";
        loadFiles();
      };
    else name.onclick = () => pull(remotePath);
    row.append(
      name,
      element("span", "file-size", file.directory ? "" : formatSize(file.size)),
    );
    const action = element(
      "button",
      "file-action",
      file.directory ? "打开" : "拉取",
    );
    action.onclick = file.directory
      ? () => {
          state.path = remotePath;
          $("#file-search").value = "";
          loadFiles();
        }
      : () => pull(remotePath);
    row.append(action);
    list.append(row);
  }
}
async function loadFiles() {
  const requestNumber = ++fileRequest;
  renderBreadcrumbs();
  if (!state.selected) return;
  $("#file-message").textContent = "正在读取远程目录";
  $("#file-message").hidden = false;
  $("#files").replaceChildren();
  try {
    const result = await api(
      `/api/files?device=${encodeURIComponent(state.selected)}&path=${encodeURIComponent(state.path)}`,
    );
    if (requestNumber === fileRequest) {
      state.files = result.files;
      renderFiles();
    }
  } catch (error) {
    if (requestNumber === fileRequest) {
      state.files = [];
      $("#file-message").textContent = error.message;
      $("#file-message").hidden = false;
    }
  }
}
async function searchFiles() {
  const query = $("#file-search").value.trim();
  if (!query) return loadFiles();
  const requestNumber = ++fileRequest;
  $("#file-message").textContent = "正在搜索";
  $("#file-message").hidden = false;
  $("#files").replaceChildren();
  try {
    const result = await api(
      `/api/search?device=${encodeURIComponent(state.selected)}&q=${encodeURIComponent(query)}`,
    );
    if (requestNumber === fileRequest) {
      state.files = result.files;
      renderFiles();
      if (result.limited) toast("仅显示前 100 个结果");
    }
  } catch (error) {
    if (requestNumber === fileRequest) {
      state.files = [];
      $("#file-message").textContent = error.message;
      $("#file-message").hidden = false;
    }
  }
}
async function pull(remotePath) {
  try {
    await post("/api/pull", { deviceId: state.selected, remotePath });
    toast("已开始拉取文件");
    refreshTransfers();
  } catch (error) {
    toast(error.message);
  }
}
const statusLabels = {
  pending: "等待接收确认",
  offered: "等待对方响应",
  receiving: "接收中",
  sending: "发送中",
  verifying: "校验中",
  complete: "已完成",
  rejected: "已拒绝",
  error: "失败",
  requesting: "请求中",
};
function renderTransfers() {
  const list = $("#transfers");
  list.replaceChildren();
  $("#transfer-count").textContent = state.transfers.length;
  if (!state.transfers.length) {
    list.append(element("div", "empty", "暂无传输任务"));
    return;
  }
  for (const transfer of state.transfers.slice(0, 30)) {
    const row = element("div", "transfer");
    const top = element("div", "transfer-top");
    top.append(
      element(
        "span",
        "transfer-direction",
        transfer.direction === "in" ? "↓" : "↑",
      ),
      element("span", "transfer-name", transfer.name),
    );
    row.append(top);
    const person =
      state.devices.find((device) => device.id === transfer.peerId)?.name ||
      "其他设备";
    row.append(
      element(
        "div",
        "transfer-meta",
        `${person} · ${statusLabels[transfer.status] || transfer.status} · ${formatSize(transfer.transferred)} / ${formatSize(transfer.size)}`,
      ),
    );
    const progress = element("div", "transfer-progress");
    const fill = element("span");
    fill.style.width = `${transfer.size ? Math.min(100, (transfer.transferred / transfer.size) * 100) : transfer.status === "complete" ? 100 : 0}%`;
    progress.append(fill);
    row.append(progress);
    if (transfer.error) row.append(element("div", "error", transfer.error));
    const actions = element("div", "transfer-actions");
    if (transfer.status === "pending") {
      for (const [label, accept] of [
        ["接收", true],
        ["拒绝", false],
      ]) {
        const button = element("button", accept ? "primary" : "", label);
        button.onclick = async () => {
          try {
            await post("/api/decide", { transferId: transfer.id, accept });
            refreshTransfers();
          } catch (error) {
            toast(error.message);
          }
        };
        actions.append(button);
      }
    }
    if (["error", "rejected"].includes(transfer.status)) {
      const retry = element("button", "", "重试");
      retry.onclick = async () => {
        try {
          await post("/api/retry", { transferId: transfer.id });
          refreshTransfers();
        } catch (error) {
          toast(error.message);
        }
      };
      actions.append(retry);
    }
    if (transfer.status === "complete" && transfer.direction === "in") {
      const open = element("button", "", "打开所在位置");
      open.onclick = async () => {
        try {
          await post("/api/open-location", { transferId: transfer.id });
        } catch (error) {
          toast(error.message);
        }
      };
      actions.append(open);
    }
    row.append(actions);
    list.append(row);
  }
}
async function refreshTransfers() {
  try {
    const next = (await api("/api/transfers")).transfers;
    if (JSON.stringify(next) !== JSON.stringify(state.transfers)) {
      state.transfers = next;
      renderTransfers();
    }
  } catch (error) {
    toast(error.message);
  }
}
async function refresh() {
  try {
    state.status = await api("/api/status");
    if (!state.status.configured) {
      $("#app").classList.add("hidden");
      $("#setup").classList.remove("hidden");
      return;
    }
    showApp();
    const next = (await api("/api/devices")).devices;
    if (JSON.stringify(next) !== JSON.stringify(state.devices)) {
      state.devices = next;
      renderDevices();
    }
    await refreshTransfers();
  } catch (error) {
    toast(error.message);
  }
}

$("#setup-form").onsubmit = async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const payload = Object.fromEntries(form);
  payload.createAccount = form.has("createAccount");
  $("#setup-error").textContent = "";
  try {
    await post("/api/setup", payload);
    formElement.elements.password.value = "";
    formElement.elements.enrollmentKey.value = "";
    await refresh();
  } catch (error) {
    $("#setup-error").textContent = error.message;
  }
};
function setupMode(mode) {
  const key = mode === "key";
  $("#setup-account").classList.toggle("active", !key);
  $("#setup-key").classList.toggle("active", key);
  document
    .querySelectorAll(".account-field")
    .forEach((item) => item.classList.toggle("hidden", key));
  $("#enrollment-wrap").classList.toggle("hidden", !key);
  const form = $("#setup-form");
  form.elements.username.required = !key;
  form.elements.password.required = !key;
  form.elements.enrollmentKey.required = key;
}
$("#setup-account").onclick = () => setupMode("account");
$("#setup-key").onclick = () => setupMode("key");
$("#settings-button").onclick = () => $("#settings-dialog").showModal();
$("#enroll-button").onclick = async () => {
  try {
    const { enrollmentKey } = await post("/api/enrollment-key", {});
    $("#pair-title").textContent = "新设备加入密钥";
    $("#pair-copy").textContent =
      "仅使用一次，10 分钟内有效。请通过可信渠道交给新设备。";
    $("#pair-controls").replaceChildren(
      element("code", "enrollment-key", enrollmentKey),
    );
    $("#settings-dialog").close();
    $("#pair-dialog").showModal();
  } catch (error) {
    toast(error.message);
  }
};
$("#pick-share").onclick = () =>
  openLocalPicker({
    endpoint: "/api/local-files",
    onSelect: async (directory) => {
      const result = await post("/api/share", { directory });
      $("#share-directory").value = result.share;
      toast("共享文件夹已设置");
    },
  });
$("#save-share").onclick = async () => {
  try {
    const data = await post("/api/share", {
      directory: $("#share-directory").value.trim(),
    });
    $("#share-directory").value = data.share;
    toast("共享目录已保存");
  } catch (error) {
    toast(error.message);
  }
};
$("#refresh-devices").onclick = refresh;
$("#reload-files").onclick = () =>
  $("#file-search").value.trim() ? searchFiles() : loadFiles();
$("#file-search").oninput = () => {
  clearTimeout(searchTimer);
  if (state.selected) searchTimer = setTimeout(searchFiles, 300);
};
$("#send-button").onclick = () => $("#file-input").click();
$("#file-input").onchange = async (event) => {
  for (const file of event.target.files) {
    try {
      const response = await fetch(
        `/api/send?device=${encodeURIComponent(state.selected)}`,
        {
          method: "POST",
          headers: { "x-file-name": encodeURIComponent(file.name) },
          body: file,
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "发送失败");
      toast(
        `${localize("已发起发送")} · ${$("#device-title").textContent}`,
        true,
      );
    } catch (error) {
      toast(error.message);
    }
  }
  event.target.value = "";
  refreshTransfers();
};
$("#invite-button").onclick = async () => {
  try {
    const { code } = await post("/api/invite", {});
    $("#pair-title").textContent = "配对码";
    $("#pair-copy").textContent = "在另一台设备输入此代码，10 分钟内有效。";
    $("#pair-controls").replaceChildren(element("div", "pair-code", code));
    $("#pair-dialog").showModal();
  } catch (error) {
    toast(error.message);
  }
};
$("#join-button").onclick = () => {
  $("#pair-title").textContent = "输入配对码";
  $("#pair-copy").textContent = "输入另一台设备显示的代码。";
  const form = element("form", "pair-entry");
  const input = document.createElement("input");
  input.required = true;
  input.placeholder = "配对码";
  input.autocomplete = "off";
  const button = element("button", "primary", "配对");
  button.type = "submit";
  form.append(input, button);
  form.onsubmit = async (event) => {
    event.preventDefault();
    try {
      await post("/api/join", { code: input.value.trim().toUpperCase() });
      $("#pair-dialog").close();
      toast("设备配对成功");
      refresh();
    } catch (error) {
      toast(error.message);
    }
  };
  $("#pair-controls").replaceChildren(form);
  $("#pair-dialog").showModal();
};
refresh();
setInterval(refresh, 4000);
