// Side panels: connection forms (serial + telnet); discover/tftp/cmds later.
import { invoke, channel } from "./ipc.js";
import * as autoLogin from "./autologin.js";
import {
  createSessionTab,
  sessionWrite,
  sessionState,
  closeSession,
  onSessionData,
  onSessionClose,
  sessionKind,
  applyAppearance,
} from "./terminals.js";

const main = document.getElementById("main");
let panel = null;

function ensurePanel(title) {
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "panel";
    main.appendChild(panel);
  }
  panel.innerHTML = `<h3></h3>`;
  panel.querySelector("h3").textContent = title;
  panel.classList.add("open");
  return panel;
}

/* ---------- session event wiring shared by transports ---------- */

function handleSessionEvent(sid, ev) {
  if (ev.event === "data") {
    const bytes = Uint8Array.from(atob(ev.bytes), (c) => c.charCodeAt(0));
    autoLogin.feed(sid, bytes);
    sessionWrite(sid, bytes);
  } else if (ev.event === "state") {
    sessionState(sid, ev.state, ev.reason);
  }
}

function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

/// Send text into a session regardless of its transport (auto-login uses this).
function sendToSessionAny(sid, text) {
  const kind = sessionKind(sid);
  const cmd = kind === "telnet" ? "telnet_write" : "serial_write";
  invoke(cmd, { id: sid, dataBase64: toB64(text) }).catch(() => {});
}

/* ---------- connect panel (serial + telnet tabs) ---------- */

/// Record a successful connection into device history (dedup happens on the
/// Rust side; failures are silent - history is a convenience, not a flow).
async function recordDevice(record) {
  try {
    await invoke("history_add", { record });
  } catch (_) {}
}

/* ---------- connecting overlay: blocks the whole UI until connect settles ---------- */

let connectLockEl = null;
function uiLockOn(text) {
  if (connectLockEl) return;
  connectLockEl = document.createElement("div");
  connectLockEl.className = "connect-lock";
  connectLockEl.innerHTML = `<div class="connect-lock-box"></div>`;
  connectLockEl.querySelector(".connect-lock-box").textContent = text;
  document.body.appendChild(connectLockEl);
}
function uiLockOff() {
  connectLockEl?.remove();
  connectLockEl = null;
}

/// Open a serial session and create its tab. Used by both the connect form
/// and the device-history quick reconnect.
async function openSerial(port, baud, label) {
  uiLockOn(`正在连接 ${label}…`);
  try {
    const creds = autoLogin.credentialsFor(port);
    const sid = await invoke("serial_open", {
      args: { port, baud_rate: baud, label },
      onEvent: channel((msg) => handleSessionEvent(sid, msg)),
    });
    createSessionTab(sid, label, "serial", { port });
    autoLogin.begin(sid, sendToSessionAny, creds?.user, creds?.pass);
    recordDevice({ kind: "serial", port, baud_rate: baud, label });
    return sid;
  } finally {
    uiLockOff();
  }
}

/// Open a telnet session and create its tab (form + history + discover share).
async function openTelnet(host, port) {
  uiLockOn(`正在连接 ${host}:${port}…`);
  try {
    const label = port === 23 ? `telnet ${host}` : `telnet ${host}:${port}`;
    const creds = autoLogin.credentialsFor(`${host}:${port}`);
    const sid = await invoke("telnet_open", {
      args: { host, port, label },
      onEvent: channel((msg) => handleSessionEvent(sid, msg)),
    });
    createSessionTab(sid, label, "telnet", { ip: host, port });
    autoLogin.begin(sid, sendToSessionAny, creds?.user, creds?.pass);
    recordDevice({ kind: "telnet", host, port, label });
    return sid;
  } finally {
    uiLockOff();
  }
}

/// One connection action for a DeviceRecord (serial or telnet), shared by the
/// history and saved-lists. Shows the connecting overlay via open*().
async function connectRecord(r, status) {
  try {
    if (status) status.textContent = "";
    if (r.kind === "serial") {
      await openSerial(r.port, r.baud_rate, r.label);
    } else {
      await openTelnet(r.host, r.port);
    }
  } catch (e) {
    if (status) status.textContent = String(e);
    else alert(String(e));
  }
}

/// Persist `patch` merged into latest settings (read-latest-then-write so
/// concurrent panel saves are not clobbered).
async function patchSettings(patch) {
  const s = await invoke("settings_get").catch(() => ({}));
  Object.assign(s, patch);
  await invoke("settings_set", { settings: s }).catch(() => {});
}

/// Render the "recent devices" block (from settings.device_history) into
/// `mount`, with click-to-reconnect, save-to-pinned and a clear button.
/// Replaces any previous render in place (one box at all times).
/// Both lists sit in settings-card frames (like the settings panel) so the
/// panel reads as: form on top, saved/history cards below.
async function renderDeviceHistory(mount) {
  if (!mount) return;
  mount.querySelector("#ct-history")?.remove();
  const settings = await invoke("settings_get").catch(() => ({}));
  const history = settings.device_history ?? [];
  const saved = settings.saved_devices ?? [];
  const savedKeys = new Set(saved.map(devKey));
  const box = document.createElement("div");
  box.id = "ct-history";
  box.innerHTML = `
    <div class="settings-card">
      <div class="sc-head"><span class="sc-title">已保存的连接</span></div>
      ${saved.length
        ? saved
            .map(
              (r, i) =>
                `<div class="list-item ct-hist-item" data-kind="saved" data-idx="${i}">${r.label} <span class="ct-unsave muted" title="从已保存移除" style="float:right">✕</span></div>`
            )
            .join("")
        : `<p class="muted" style="margin:0">(空,可在下方最近连接中点击保存图标)</p>`}
    </div>
    <div class="settings-card">
      <div class="sc-head">
        <span class="sc-title">最近连接</span>
        <span id="ct-hclear" class="muted" style="cursor:pointer;text-decoration:underline">清除</span>
      </div>
      ${history.length
        ? history
            .map(
              (r, i) =>
                `<div class="list-item ct-hist-item" data-kind="history" data-idx="${i}">${r.label}${
                  savedKeys.has(devKey(r))
                    ? ` <span class="muted" style="float:right">已保存</span>`
                    : ` <button class="rb-dl ct-save" title="保存到已保存列表" style="float:right"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M2.5 2.5h9L14 5v8.5a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z M5 2.5v3.5h5V2.5 M4.5 14.5v-5h7v5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
                }</div>`
            )
            .join("")
        : `<p class="muted" style="margin:0">暂无</p>`}
    </div>
  `;
  mount.appendChild(box);
  box.querySelector("#ct-hclear").addEventListener("click", async (ev) => {
    ev.stopPropagation();
    await patchSettings({ device_history: [] });
    renderDeviceHistory(mount);
  });
  // Save from history: copy the record into saved_devices (dedup by key).
  // The save button contains an SVG; a click on it targets the path, so
  // resolve the owning button via closest().
  box.querySelectorAll(".ct-save").forEach((el) => {
    el.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const item = ev.target.closest(".ct-hist-item");
      const r = history[parseInt(item.dataset.idx, 10)];
      const s = await invoke("settings_get").catch(() => ({}));
      const list = s.saved_devices ?? [];
      if (!list.some((x) => devKey(x) === devKey(r))) {
        list.unshift(r);
        s.saved_devices = list;
        await invoke("settings_set", { settings: s }).catch(() => {});
      }
      renderDeviceHistory(mount);
    });
  });
  // Remove from saved list (the record stays in history). The ✕ is plain
  // text so ev.target is the span itself; closest() guards anyway.
  box.querySelectorAll(".ct-unsave").forEach((el) => {
    el.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const item = ev.target.closest(".ct-hist-item");
      const r = (await invoke("settings_get").catch(() => ({}))).saved_devices?.[
        parseInt(item.dataset.idx, 10)
      ];
      if (!r) return;
      const s = await invoke("settings_get").catch(() => ({}));
      s.saved_devices = (s.saved_devices ?? []).filter((x) => devKey(x) !== devKey(r));
      await invoke("settings_set", { settings: s }).catch(() => {});
      renderDeviceHistory(mount);
    });
  });
  box.querySelectorAll(".ct-hist-item").forEach((el) => {
    el.addEventListener("click", async () => {
      const r =
        el.dataset.kind === "saved"
          ? (await invoke("settings_get").catch(() => ({}))).saved_devices?.[parseInt(el.dataset.idx, 10)]
          : history[parseInt(el.dataset.idx, 10)];
      if (!r) return;
      connectRecord(r, document.getElementById("ct-status"));
    });
  });
}

/// Identity key for a device record (transport + address; label may drift).
function devKey(r) {
  return r.kind === "serial" ? `serial:${r.port}` : `telnet:${r.host}:${r.port}`;
}

export async function showConnectPanel(mode = "serial") {
  const p = ensurePanel("开始连接");
  p.innerHTML = `
    <h3>开始连接</h3>
    <div class="seg-tabs">
      <button id="ct-serial" class="${mode === "serial" ? "sel" : ""}">串口</button>
      <button id="ct-telnet" class="${mode === "telnet" ? "sel" : ""}">Telnet</button>
    </div>
    <div id="ct-body"></div>
    <p class="muted" id="ct-status"></p>
    <div id="ct-lists"></div>
  `;
  p.querySelector("#ct-serial").addEventListener("click", () => showConnectPanel("serial"));
  p.querySelector("#ct-telnet").addEventListener("click", () => showConnectPanel("telnet"));
  const body = p.querySelector("#ct-body");
  const status = p.querySelector("#ct-status");

  if (mode === "serial") {
    body.innerHTML = `
      <div class="row">
        <select id="sp-port"><option value="">扫描中…</option></select>
        <button id="sp-refresh" class="rb-dl" title="重新扫描串口" style="padding:6px 4px"><svg viewBox="0 0 16 16" width="15" height="15"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
      <div class="row">
        <select id="sp-baud">
          ${[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map(
            (b) => `<option ${b === 115200 ? "selected" : ""}>${b}</option>`
          ).join("")}
        </select>
        <button id="sp-open">连接</button>
      </div>
    `;
    const sel = body.querySelector("#sp-port");
    async function refresh() {
      sel.innerHTML = `<option value="">扫描中…</option>`;
      const ports = await invoke("serial_list");
      sel.innerHTML = ports.length
        ? ports
            .map((pt) => {
              const label = pt.desc ? `${pt.desc} (${pt.name})` : pt.name;
              return `<option value="${pt.name}">${label}</option>`;
            })
            .join("")
        : `<option value="">未发现串口</option>`;
    }
    body.querySelector("#sp-refresh").addEventListener("click", refresh);
    body.querySelector("#sp-open").addEventListener("click", async () => {
      const port = sel.value;
      if (!port) return;
      status.textContent = "打开中…";
      try {
        const baud = parseInt(body.querySelector("#sp-baud").value, 10);
        await openSerial(port, baud, `${port} @ ${baud}`);
        status.textContent = "";
      } catch (e) {
        status.textContent = String(e);
      }
    });
    await refresh();
    // saved/history cards render below the status line (form -> status -> lists)
    renderDeviceHistory(p.querySelector("#ct-lists"));
  } else {
    body.innerHTML = `
      <div class="row"><input id="tn-host" placeholder="IP 地址,如 192.168.1.1" /></div>
      <div class="row">
        <input id="tn-port" value="23" placeholder="端口" />
        <button id="tn-open">连接</button>
      </div>
    `;
    body.querySelector("#tn-open").addEventListener("click", async () => {
      const host = body.querySelector("#tn-host").value.trim();
      if (!host) return;
      const port = parseInt(body.querySelector("#tn-port").value, 10) || 23;
      status.textContent = "连接中…";
      try {
        await openTelnet(host, port);
        status.textContent = "";
      } catch (e) {
        status.textContent = String(e);
      }
    });
    body.querySelector("#tn-host").focus();
    // same position as the serial tab: below the status line
    renderDeviceHistory(p.querySelector("#ct-lists"));
  }
}

/* ---------- discover panel ---------- */

export async function showDiscoverPanel() {
  const p = ensurePanel("发现设备");
  const settings = await invoke("settings_get").catch(() => ({}));
  const ips = await invoke("list_local_ips").catch(() => []);
  p.innerHTML = `
    <div class="row">
      <select id="dv-ip">
        ${ips.map((ip) => `<option ${ip === settings.scan_local_ip ? "selected" : ""}>${ip}</option>`).join("") ||
        '<option value="">无网卡</option>'}
      </select>
    </div>
    <div class="row">
      <input id="dv-port" value="${settings.scan_port ?? 23}" placeholder="端口" />
      <button id="dv-scan" title="">扫描当前网段</button>
      <button id="dv-gw" title="探测所有网卡的 x.x.x.1 网关">扫描所有.1</button>
    </div>
    <p class="muted" id="dv-status">端口会自动保存。</p>
    <div id="dv-list"></div>
  `;
  const list = p.querySelector("#dv-list");
  const status = p.querySelector("#dv-status");
  const portInput = p.querySelector("#dv-port");
  const ipSel = p.querySelector("#dv-ip");
  const scanBtn = p.querySelector("#dv-scan");

  // hover tooltip on the scan button: 扫描 <ip>.* 的 1~254 的 <port> 端口
  function updateHint() {
    const ip = ipSel.value || "x.x.x";
    const port = parseInt(portInput.value, 10) || 23;
    scanBtn.title = `扫描 ${ip}.* 的 1~254 的 ${port} 端口`;
  }
  updateHint();
  portInput.addEventListener("input", updateHint);
  ipSel.addEventListener("change", updateHint);

  // persist port + nic selection whenever either changes
  async function saveSettings() {
    const s = await invoke("settings_get").catch(() => ({}));
    s.scan_port = parseInt(portInput.value, 10) || 23;
    s.scan_local_ip = ipSel.value || "";
    await invoke("settings_set", { settings: s }).catch(() => {});
  }
  portInput.addEventListener("change", saveSettings);
  ipSel.addEventListener("change", saveSettings);

  function addHost(host, hport) {
    const el = document.createElement("div");
    el.className = "list-item discover-item";
    el.innerHTML = `${host}:${hport} <span class="muted">telnet</span> <button class="rb-dl dv-save" title="保存到已保存列表" style="float:right"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M2.5 2.5h9L14 5v8.5a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z M5 2.5v3.5h5V2.5 M4.5 14.5v-5h7v5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    el.addEventListener("click", async () => {
      status.textContent = `连接 ${host}…`;
      try {
        await openTelnet(host, hport);
        status.textContent = "";
      } catch (e) {
        status.textContent = String(e);
      }
    });
    // Save the discovered device straight into saved_devices (same store the
    // connect panel renders; dedup by transport+address there and here).
    el.querySelector(".dv-save").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const record = { kind: "telnet", host, port: hport, label: `telnet ${host}:${hport}` };
      const s = await invoke("settings_get").catch(() => ({}));
      const l = s.saved_devices ?? [];
      if (!l.some((x) => devKey(x) === devKey(record))) {
        l.unshift(record);
        s.saved_devices = l;
        await invoke("settings_set", { settings: s }).catch(() => {});
      }
      el.querySelector(".dv-save")?.remove();
      const mark = document.createElement("span");
      mark.className = "muted";
      mark.style.cssText = "float:right";
      mark.textContent = "已保存";
      el.appendChild(mark);
    });
    list.appendChild(el);
  }

  function beginScan() {
    list.innerHTML = "";
    status.textContent = "扫描中…";
    p.querySelector("#dv-scan").disabled = true;
    p.querySelector("#dv-gw").disabled = true;
    saveSettings();
  }
  function endScan() {
    status.textContent = list.children.length
      ? `发现 ${list.children.length} 台设备:`
      : "未发现开放该端口的主机";
    p.querySelector("#dv-scan").disabled = false;
    p.querySelector("#dv-gw").disabled = false;
  }

  p.querySelector("#dv-scan").addEventListener("click", async () => {
    const port = parseInt(portInput.value, 10) || 23;
    const localIp = ipSel.value || null;
    beginScan();

    const prog = channel((msg) => {
      const ev = typeof msg === "string" ? JSON.parse(msg) : msg;
      if (ev.event === "found") {
        addHost(ev.ip, ev.port); // show immediately, keep scanning
      } else if (ev.event === "progress") {
        status.textContent = `扫描中… ${ev.scanned}/${ev.total}`;
      } else if (ev.event === "done") {
        endScan();
      }
    });
    try {
      await invoke("scan_subnet", { localIp, port, onProgress: prog });
    } catch (e) {
      status.textContent = String(e);
      endScan();
    }
  });

  p.querySelector("#dv-gw").addEventListener("click", async () => {
    const port = parseInt(portInput.value, 10) || 23;
    beginScan();
    const prog = channel((msg) => {
      const ev = typeof msg === "string" ? JSON.parse(msg) : msg;
      if (ev.event === "found") {
        addHost(ev.ip, ev.port);
      } else if (ev.event === "done") {
        endScan();
      }
    });
    try {
      await invoke("scan_gateways", { port, onProgress: prog });
    } catch (e) {
      status.textContent = String(e);
      endScan();
    }
  });
}

/* ---------- TFTP panel ---------- */

/// Make a list block height-draggable via a thin grip below it; heights are
/// persisted per key in settings (ui_heights JSON) and restored on open.
/// The block uses a FIXED height (not max-height) so it doesn't shrink with
/// content - one file still occupies the full pane.
function makeResizable(el, key, settings, defaults) {
  // restore
  let heights = {};
  try {
    heights = typeof settings.ui_heights === "string" ? JSON.parse(settings.ui_heights) : settings.ui_heights || {};
  } catch (_) {}
  el.style.height = (heights[key] ?? defaults[key] ?? 220) + "px";

  // grip element attached below the list.
  const grip = document.createElement("div");
  grip.className = "resize-grip";
  grip.title = "拖动调整高度";
  el.insertAdjacentElement("afterend", grip);
  let startY = 0;
  let startH = 0;
  let onMove;
  grip.addEventListener("mousedown", (e) => {
    startY = e.clientY;
    startH = parseInt(getComputedStyle(el).height, 10) || 220;
    onMove = (ev) => {
      const h = Math.max(60, Math.min(800, startH + (ev.clientY - startY)));
      el.style.height = h + "px";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const h = parseInt(getComputedStyle(el).height, 10);
      heights[key] = h;
      const s = { ui_heights: JSON.stringify(heights) };
      invoke("settings_get").then((cur) => {
        Object.assign(cur, s);
        invoke("settings_set", { settings: cur }).catch(() => {});
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  });
}

export async function showTftpPanel() {
  const p = ensurePanel("TFTP");
  const settings = await invoke("settings_get").catch(() => ({}));
  const ips = await invoke("list_local_ips").catch(() => []);
  const running = await invoke("tftp_server_status").catch(() => false);

  // collect telnet session IPs for the browser selector
  const telnetIps = window.__devtermTelnetIps?.() ?? [];
  const active = window.__devtermActiveSession?.() ?? { kind: null, ip: null, port: null };
  // Follow the active window: telnet -> prefill+autoconnect; serial -> assistant only.
  const followIp = active.kind === "telnet" ? active.ip : "";
  const followPort = active.kind === "telnet" ? active.port ?? 23 : 23;

  p.innerHTML = `
    <h3>TFTP文件管理</h3>
    <p class="muted" id="rb-follow">${active.kind === "telnet" ? `跟随当前窗口: ${followIp}:${followPort}` : active.kind === "serial" ? "当前是串口会话:仅命令助手可用;浏览需 Telnet" : "当前无活动会话"}</p>
    <div class="row">
      <input id="rb-host" list="rb-hosts" value="${followIp || telnetIps[0] || ""}" placeholder="路由器 IP(可手输)" style="flex:2" />
      <input id="rb-port" value="${followPort}" placeholder="端口" style="flex:1" />
      <button id="rb-connect">连接</button>
    </div>
    <datalist id="rb-hosts">${telnetIps.map((ip) => `<option value="${ip}">`).join("")}</datalist>
    <div class="row" id="rb-user-row">
      <input id="rb-user" value="${settings.telnet_user ?? "root"}" placeholder="用户名" style="flex:1" />
      <input id="rb-pass" type="password" value="${settings.telnet_password ?? ""}" placeholder="密码(手动填写)" style="flex:1" />
    </div>
    <p class="muted" id="rb-status">连接后显示目录(初始为登录目录)</p>
    <div class="row" id="rb-path-row" style="display:none">
      <button id="rb-up" title="上一级" style="padding:6px 8px;line-height:0"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <span id="rb-path" class="muted" style="flex:1;word-break:break-all"></span>
      <button id="rb-refresh" title="刷新" style="padding:6px 8px;line-height:0"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </div>
    <div id="rb-list" class="scroll-list"></div>
    <div class="row" id="rb-upload-row" style="display:none;align-items:stretch;margin-top:6px">
      <button id="rb-upload" class="rb-upload" title="选择 PC 文件上传到当前目录" style="flex:1;margin-top:0">上传</button>
      <button id="rb-adv" title="TFTP 服务端 / 客户端工具" style="padding:6px 8px;line-height:0"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M9.7 2.9a3.6 3.6 0 0 0-4.9 4.3L1.5 10.5a1.3 1.3 0 0 0 0 1.8l2.2 2.2a1.3 1.3 0 0 0 1.8 0l3.3-3.3a3.6 3.6 0 0 0 4.3-4.9L10.5 9 7 5.5l2.7-2.6z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </div>

    <div id="tftp-adv" style="display:none">
    <h3 style="margin-top:14px">TFTP 服务端</h3>
    <div class="row"><input id="tf-dir" value="${settings.tftp_dir ?? ""}" placeholder="服务目录,如 C:\\tftp" /></div>
    <div class="row">
      <input id="tf-port" value="${settings.tftp_port ?? 69}" placeholder="端口" />
      <button id="tf-toggle" class="${running ? "stop" : ""}">${running ? "停止" : "启动"}</button>
    </div>
    <p class="muted" id="tf-srv-status">${running ? "运行中" : "未运行"}</p>

    <h3 style="margin-top:14px">服务目录文件</h3>
    <div class="row"><button id="tf-refresh" style="flex:1">刷新列表</button></div>
    <div id="tf-files" class="scroll-list"></div>

    <h3 style="margin-top:14px">客户端测试</h3>
    <div class="row"><input id="tc-server" placeholder="服务器 IP" value="127.0.0.1" /></div>
    <div class="row"><input id="tc-remote" placeholder="远端文件名" /></div>
    <div class="row"><input id="tc-local" placeholder="本地路径" /></div>
    <div class="row">
      <button id="tc-get" style="flex:1">Get</button>
      <button id="tc-put" style="flex:1">Put</button>
    </div>
    <p class="muted" id="tc-status"></p>
    </div>

    <h3 style="margin-top:14px">串口命令助手</h3>
    <div class="row">
      <button id="cf-up" style="flex:1">上传(设备拉取)</button>
      <button id="cf-down" style="flex:1">下载(设备推送)</button>
    </div>
    <div id="cf-body"></div>

    <h3 style="margin-top:14px">传输记录</h3>
    <div id="tf-transfers" class="scroll-list muted">暂无传输</div>
  `;

  /* --- router browser (hidden session) --- */
  const rbStatus = p.querySelector("#rb-status");
  const rbList = p.querySelector("#rb-list");
  const rbPathEl = p.querySelector("#rb-path");
  const rbPathRow = p.querySelector("#rb-path-row");
  let cwd = "/";

  function rshArgs() {
    return {
      host: p.querySelector("#rb-host").value.trim(),
      port: parseInt(p.querySelector("#rb-port").value, 10) || 23,
      user: p.querySelector("#rb-user").value.trim() || "root",
      password: p.querySelector("#rb-pass").value,
    };
  }

  async function saveRshSettings() {
    const s = await invoke("settings_get").catch(() => ({}));
    s.telnet_user = p.querySelector("#rb-user").value.trim();
    s.telnet_password = p.querySelector("#rb-pass").value;
    await invoke("settings_set", { settings: s }).catch(() => {});
  }

  async function browse(path) {
    rbStatus.textContent = `读取 ${path} …`;
    try {
      const entries = await invoke("rsh_ls", { args: rshArgs(), path });
      cwd = path;
      rbPathEl.textContent = cwd;
      rbPathRow.style.display = "";
      p.querySelector("#rb-upload-row").style.display = "flex";
      rbList.innerHTML = entries.length
        ? entries
            .map(
              (e) =>
                `<div class="list-item rb-entry" data-name="${e.name}" data-dir="${e.is_dir}">${e.is_dir ? "📁" : "📄"} <span class="rb-name">${e.name}${e.is_dir ? "/" : ""}</span>${e.is_dir ? "" : `<button class="rb-dl" title="下载到 PC"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 1v8M4.5 5.5 8 9l3.5-3.5M2 11.5V13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`}</div>`
            )
            .join("")
        : `<p class="muted">(空目录)</p>`;
      rbStatus.textContent = "";
      rbList.querySelectorAll(".rb-entry").forEach((el) => {
        el.addEventListener("click", async (ev) => {
          if (ev.target.classList.contains("rb-dl")) return; // download btn handles itself
          if (el.dataset.dir === "true") {
            const name = el.dataset.name;
            const next = cwd === "/" ? `/${name}` : `${cwd}/${name}`;
            browse(next);
          }
        });
      });
      rbList.querySelectorAll(".rb-dl").forEach((btn) => {
        btn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          const name = btn.closest(".rb-entry").dataset.name;
          await downloadFile(name);
        });
      });
    } catch (e) {
      rbStatus.textContent = String(e);
    }
  }

  p.querySelector("#rb-connect").addEventListener("click", () => doConnect());

  async function doConnect() {
    saveRshSettings();
    rbStatus.textContent = "登录中…";
    try {
      const dir = await invoke("rsh_pwd", { args: rshArgs() });
      browse(dir || "/");
    } catch (e) {
      rbStatus.textContent = String(e);
    }
  }

  // Auto-connect when following an active telnet window (password empty = user
  // must fill it first; then they press 连接).
  if (followIp && (p.querySelector("#rb-pass").value || settings.telnet_password)) {
    doConnect();
  }
  p.querySelector("#rb-up").addEventListener("click", () => {
    if (cwd !== "/") browse(cwd.replace(/\/[^/]*$/, "") || "/");
  });
  p.querySelector("#rb-refresh").addEventListener("click", () => browse(cwd));

  /* --- download: device pushes file to PC server dir, then save-as --- */
  async function downloadFile(name) {
    const host = p.querySelector("#rb-host").value.trim();
    if (!host) { rbStatus.textContent = "未填写路由器 IP"; return; }
    const srvDir = dirInput ? dirInput.value.trim() : "";
    if (!srvDir) { rbStatus.textContent = "请先填写 TFTP 服务目录(传输中转用)"; return; }

    // choose where to save
    let savePath;
    try {
      savePath = await invoke("pick_save_path", { defaultName: name });
    } catch (e) {
      rbStatus.textContent = String(e);
      return;
    }
    if (!savePath) return;

    // ensure server running (device pushes into it)
    let srvPort = parseInt(portInput?.value ?? "69", 10) || 69;
    const running = await invoke("tftp_server_status").catch(() => false);
    if (!running) {
      rbStatus.textContent = "自动启动 TFTP 服务端…";
      try {
        const evCh = channel((msg) => {
          const ev = typeof msg === "string" ? JSON.parse(msg) : msg;
          if (ev.kind === "start") {
            setTransferRow(ev.dir, ev.file, "0%", ev.total != null ? `${ev.total}B ← ${ev.peer ?? ""}` : `← ${ev.peer ?? ""}`);
          } else if (ev.kind === "progress") {
            const pct = ev.total ? Math.min(99, Math.floor((ev.bytes / ev.total) * 100)) : 99;
            setTransferRow(ev.dir, ev.file, `${pct}%`, `${ev.bytes}B`);
          } else if (ev.kind === "done") {
            setTransferRow(ev.dir, ev.file, "成功", `${ev.bytes}B ${ev.speed ?? ""}B/s`, "ok");
          } else if (ev.kind === "error") {
            setTransferRow(ev.dir, ev.file, "失败", ev.message, "fail");
          }
        });
        const r = await invoke("tftp_server_start", { args: { dir: srvDir, port: srvPort }, onEvent: evCh });
        srvStatus.textContent = "运行中";
        toggleBtn.textContent = "停止";
        toggleBtn.classList.add("stop");
        const m = /随机端口 (\d+)/.exec(r);
        if (m) srvPort = parseInt(m[1], 10);
        portInput.value = srvPort;
      } catch (e) {
        rbStatus.textContent = `服务端启动失败: ${e}`;
        return;
      }
    }

    const pcIp = await invoke("local_ip_toward", { dst: host }).catch((e) => { rbStatus.textContent = String(e); return null; });
    if (!pcIp) return;

    const remote = cwd === "/" ? `/${name}` : `${cwd}/${name}`;
    setTransferRow("put", name, "0%", `← ${remote}`);
    rbStatus.textContent = `下载 ${name}…`;
    try {
      const out = await invoke("rsh_exec", {
        args: rshArgs(),
        cmd: `tftp -p -l '${remote}' -r '${name}' ${pcIp}${srvPort === 69 ? "" : " " + srvPort}`,
      });
      const errText = (out || "").trim();
      if (errText) {
        setTransferRow("put", name, "失败", errText, "fail");
        rbStatus.textContent = `下载失败: ${errText}`;
        return;
      }
      // file landed in the server dir; move it to the chosen save path
      await invoke("tftp_export", { srvDir, name, savePath });
      setTransferRow("put", name, "成功", `→ ${savePath}`, "ok");
      rbStatus.textContent = `下载完成: ${savePath}`;
      refreshFiles();
    } catch (e) {
      setTransferRow("put", name, "失败", String(e), "fail");
      rbStatus.textContent = `下载失败: ${e}`;
    }
  }

  /* --- upload: pick PC files -> server dir -> hidden-session tftp -g --- */
  p.querySelector("#rb-upload").addEventListener("click", async () => {
    const host = p.querySelector("#rb-host").value.trim();
    if (!host) { rbStatus.textContent = "未填写路由器 IP"; return; }
    // File picker FIRST; server dir is derived from the first picked file.
    rbStatus.textContent = "选择文件…";
    let paths;
    try {
      paths = await invoke("pick_files");
    } catch (e) {
      rbStatus.textContent = String(e);
      return;
    }
    if (!paths || paths.length === 0) { rbStatus.textContent = ""; return; }

    let srvDir = dirInput ? dirInput.value.trim() : "";
    if (!srvDir) {
      // default the server dir to the first picked file's folder
      srvDir = paths[0].replace(/[\\/][^\\/]+$/, "");
      dirInput.value = srvDir;
    }

    // ensure TFTP server is running for the device to pull from
    let srvPort = parseInt(portInput?.value ?? "69", 10) || 69;
    const running = await invoke("tftp_server_status").catch(() => false);
    if (!running) {
      rbStatus.textContent = "自动启动 TFTP 服务端…";
      try {
        const evCh = channel((msg) => {
          const ev = typeof msg === "string" ? JSON.parse(msg) : msg;
          if (ev.kind === "start") {
            setTransferRow(ev.dir, ev.file, "0%", ev.total != null ? `${ev.total}B ← ${ev.peer ?? ""}` : `← ${ev.peer ?? ""}`);
          } else if (ev.kind === "progress") {
            const pct = ev.total ? Math.min(99, Math.floor((ev.bytes / ev.total) * 100)) : 99;
            setTransferRow(ev.dir, ev.file, `${pct}%`, `${ev.bytes}B`);
          } else if (ev.kind === "done") {
            setTransferRow(ev.dir, ev.file, "成功", `${ev.bytes}B ${ev.speed ?? ""}B/s`, "ok");
            refreshFiles();
          } else if (ev.kind === "error") {
            setTransferRow(ev.dir, ev.file, "失败", ev.message, "fail");
          }
        });
        const r = await invoke("tftp_server_start", { args: { dir: srvDir, port: srvPort }, onEvent: evCh });
        srvStatus.textContent = "运行中";
        toggleBtn.textContent = "停止";
        toggleBtn.classList.add("stop");
        // port might have been auto-fallback (random) if 69 was taken
        const m = /随机端口 (\d+)/.exec(r);
        if (m) srvPort = parseInt(m[1], 10);
        portInput.value = srvPort;
        if (m) addTransfer(`[提示] 端口 69 被占用,服务端改用 ${srvPort}(命令已带端口)`);
      } catch (e) {
        rbStatus.textContent = `服务端启动失败: ${e}`;
        return;
      }
    }

    const pcIp = await invoke("local_ip_toward", { dst: host }).catch((e) => { rbStatus.textContent = String(e); return null; });
    if (!pcIp) return;

    rbStatus.textContent = `上传 0/${paths.length} …`;
    let ok = 0;
    for (const src of paths) {
      const name = src.split(/[\\/]/).pop();
      try {
        await invoke("tftp_copy_in", { dir: srvDir, src, name });
        // device pulls from PC; -l is the router-side target path
        const target = cwd === "/" ? `/${name}` : `${cwd}/${name}`;
        // busybox tftp takes an optional trailing PORT
        const portArg = srvPort === 69 ? "" : ` ${srvPort}`;
        // The server's own events own the progress row ("get:<file>"); here we
        // only send the command and then verify the result.
        const out = await invoke("rsh_exec", {
          args: rshArgs(),
          cmd: `tftp -g -l '${target}' -r '${name}' ${pcIp}${portArg}`,
        });
        // busybox tftp prints errors ("tftp: ...") on failure; empty = success
        const errText = (out || "").trim();
        if (errText) {
          setTransferRow("get", name, "失败", errText, "fail");
        } else {
          // verify the file really landed
          const entries = await invoke("rsh_ls", { args: rshArgs(), path: cwd });
          const found = entries.find((e) => e.name === name);
          if (found) {
            ok += 1;
            setTransferRow("get", name, "成功", `→ ${cwd}`, "ok");
          } else {
            setTransferRow("get", name, "失败", "设备上未找到文件", "fail");
          }
        }
      } catch (e) {
        setTransferRow("get", name, "失败", String(e), "fail");
      }
      rbStatus.textContent = `上传 ${ok}/${paths.length} …`;
    }
    rbStatus.textContent = `上传完成: ${ok}/${paths.length} → ${cwd}`;
    browse(cwd);
  });

  const srvStatus = p.querySelector("#tf-srv-status");
  const toggleBtn = p.querySelector("#tf-toggle");
  const dirInput = p.querySelector("#tf-dir");
  const portInput = p.querySelector("#tf-port");
  const filesEl = p.querySelector("#tf-files");
  const transfersEl = p.querySelector("#tf-transfers");
  const cfBody = p.querySelector("#cf-body");

  async function saveTftpSettings(patch) {
    const s = await invoke("settings_get").catch(() => ({}));
    Object.assign(s, patch);
    await invoke("settings_set", { settings: s }).catch(() => {});
  }

  // Transfer log: ONE row per file transfer, keyed by dir+file. Server events
  // own the row during transfer ([0%]→[99%] updated in place), finalized as
  // [成功]/[失败]. Cap 100 rows.
  const transferRows = new Map(); // dir+file -> element

  function transferRow(dir, file) {
    const key = `${dir}:${file}`;
    let el = transferRows.get(key);
    if (!el) {
      if (transfersEl.classList.contains("muted")) {
        transfersEl.textContent = "";
        transfersEl.classList.remove("muted");
      }
      el = document.createElement("div");
      el.className = "list-item";
      transfersEl.prepend(el);
      transferRows.set(key, el);
      while (transfersEl.children.length > 100) {
        const last = transfersEl.lastChild;
        const lk = last.dataset.key;
        if (lk) transferRows.delete(lk);
        last.remove();
      }
    }
    return el;
  }

  function setTransferRow(dir, file, tag, detail = "", cls = "") {
    const el = transferRow(dir, file);
    el.dataset.key = `${dir}:${file}`;
    el.textContent = `[${tag}] ${file}${detail ? " " + detail : ""}`;
    el.style.color = cls === "fail" ? "#e06c75" : cls === "ok" ? "#98c379" : "";
  }

  function addTransfer(text) {
    if (transfersEl.classList.contains("muted")) {
      transfersEl.textContent = "";
      transfersEl.classList.remove("muted");
    }
    const div = document.createElement("div");
    div.className = "list-item";
    div.textContent = text;
    transfersEl.prepend(div);
    while (transfersEl.children.length > 100) transfersEl.lastChild.remove();
  }

  toggleBtn.addEventListener("click", async () => {
    const dir = dirInput.value.trim();
    if (!dir) { srvStatus.textContent = "请先填写服务目录"; return; }
    const port = parseInt(portInput.value, 10) || 69;
    if (toggleBtn.textContent === "启动") {
      try {
        const evCh = channel((msg) => {
          const ev = typeof msg === "string" ? JSON.parse(msg) : msg;
          if (ev.kind === "state") {
            srvStatus.textContent = ev.state === "running" ? "运行中" : "已停止";
            if (ev.state === "running") { toggleBtn.textContent = "停止"; }
          } else if (ev.kind === "start") {
            setTransferRow(ev.dir, ev.file, "0%", ev.total != null ? `${ev.total}B ← ${ev.peer ?? ""}` : `← ${ev.peer ?? ""}`);
          } else if (ev.kind === "progress") {
            const pct = ev.total ? Math.min(99, Math.floor((ev.bytes / ev.total) * 100)) : 99;
            setTransferRow(ev.dir, ev.file, `${pct}%`, `${ev.bytes}B`);
          } else if (ev.kind === "done") {
            setTransferRow(ev.dir, ev.file, "成功", `${ev.bytes}B ${ev.speed ?? ""}B/s`, "ok");
            refreshFiles();
          } else if (ev.kind === "error") {
            setTransferRow(ev.dir, ev.file, "失败", ev.message, "fail");
          }
        });
        const r = await invoke("tftp_server_start", { args: { dir, port }, onEvent: evCh });
        srvStatus.textContent = "运行中";
        toggleBtn.textContent = "停止";
        toggleBtn.classList.add("stop");
        saveTftpSettings({ tftp_dir: dir, tftp_port: port });
        status5(p, r);
      } catch (e) {
        srvStatus.textContent = String(e);
      }
    } else {
      const r = await invoke("tftp_server_stop");
      srvStatus.textContent = r;
      toggleBtn.textContent = "启动";
      toggleBtn.classList.remove("stop");
    }
  });

  async function refreshFiles() {
    const dir = dirInput.value.trim();
    if (!dir) { filesEl.innerHTML = `<p class="muted">填写目录后刷新</p>`; return; }
    try {
      const files = await invoke("tftp_list_dir", { dir });
      filesEl.innerHTML = files.length
        ? files.map((f) =>
            `<div class="list-item file-item" data-name="${f.name}">${f.name} <span class="muted">${f.size}B</span></div>`
          ).join("")
        : `<p class="muted">目录为空</p>`;
      filesEl.querySelectorAll(".file-item").forEach((el) => {
        el.addEventListener("click", () => {
          cfBody.innerHTML = `<p class="muted">已选文件: ${el.dataset.name}</p>`;
        });
      });
    } catch (e) {
      filesEl.innerHTML = `<p class="muted">${String(e)}</p>`;
    }
  }
  p.querySelector("#tf-refresh").addEventListener("click", refreshFiles);
  if (dirInput.value) refreshFiles();

  // Wrench toggle for the advanced TFTP blocks (server / dir files / client
  // test). Session-only: default hidden, never persisted.
  p.querySelector("#rb-adv").addEventListener("click", () => {
    const adv = p.querySelector("#tftp-adv");
    adv.style.display = adv.style.display === "none" ? "" : "none";
  });

  // draggable list heights (persisted in settings.ui_heights)
  const defaults = { rb_list: 260, tf_files: 220, tf_transfers: 160 };
  makeResizable(p.querySelector("#rb-list"), "rb_list", settings, defaults);
  makeResizable(p.querySelector("#tf-files"), "tf_files", settings, defaults);
  makeResizable(p.querySelector("#tf-transfers"), "tf_transfers", settings, defaults);
  // Upload button goes ABOVE the rb-list grip: [list][button][grip]
  const rbListEl = p.querySelector("#rb-list");
  const upRow = p.querySelector("#rb-upload-row"); // [upload][wrench] row
  const rbGrip = rbListEl.nextElementSibling; // grip inserted right after list
  if (rbGrip && rbGrip.classList.contains("resize-grip")) {
    rbGrip.insertAdjacentElement("beforebegin", upRow);
  }

  /* --- command assistant cards --- */
  p.querySelector("#cf-up").addEventListener("click", async () => {
    cfBody.innerHTML = `
      <p class="muted">选择要上传的文件(设备将用 tftp -g 拉取)</p>
      <div class="row"><input id="cf-upfile" placeholder="文件完整路径,如 C:\\tftp\\fw.bin" /></div>
      <div class="row">
        <select id="cf-upip">${ips.map((ip) => `<option ${ip === settings.cmd_upload_ip ? "selected" : ""}>${ip}</option>`).join("")}</select>
      </div>
      <div class="row">
        <button id="cf-upcopy" style="flex:1">复制命令</button>
        <button id="cf-upsend" style="flex:1">发送到串口</button>
      </div>
      <p class="muted" id="cf-upstatus"></p>
    `;
    const st = cfBody.querySelector("#cf-upstatus");
    function genCmd() {
      const path = cfBody.querySelector("#cf-upfile").value.trim();
      const name = path.split(/[\\/]/).pop();
      const ip = cfBody.querySelector("#cf-upip").value;
      return { cmd: `tftp -g -l ${name} ${ip}`, name, ip, path };
    }
    cfBody.querySelector("#cf-upcopy").addEventListener("click", async () => {
      const { cmd, name, ip, path } = genCmd();
      if (!path) { st.textContent = "先填文件路径"; return; }
      await navigator.clipboard.writeText(cmd).catch(() => {});
      st.textContent = `已复制: ${cmd}`;
      // copy file into server dir so the device can pull it
      const s = await invoke("settings_get").catch(() => ({}));
      if (s.tftp_dir) {
        try { await invoke("tftp_copy_in", { src: path, name }); refreshFiles(); } catch (_) {}
      }
      saveTftpSettings({ cmd_upload_ip: ip });
    });
    cfBody.querySelector("#cf-upsend").addEventListener("click", () => {
      const { cmd, path, ip } = genCmd();
      if (!path) { st.textContent = "先填文件路径"; return; }
      saveTftpSettings({ cmd_upload_ip: ip });
      sendToSerial(p, cmd, st, "串口可见执行");
    });
  });

  p.querySelector("#cf-down").addEventListener("click", () => {
    cfBody.innerHTML = `
      <p class="muted">设备将用 tftp -p 把文件推到 PC 服务目录</p>
      <div class="row"><input id="cf-dnname" value="${settings.cmd_download_name ?? ""}" placeholder="远端文件名" /></div>
      <div class="row">
        <select id="cf-dnip">${ips.map((ip) => `<option ${ip === settings.cmd_download_ip ? "selected" : ""}>${ip}</option>`).join("")}</select>
      </div>
      <div class="row">
        <button id="cf-dncopy" style="flex:1">复制命令</button>
        <button id="cf-dnsend" style="flex:1">发送到串口</button>
      </div>
      <p class="muted" id="cf-dnstatus"></p>
    `;
    const st = cfBody.querySelector("#cf-dnstatus");
    function genCmd() {
      const name = cfBody.querySelector("#cf-dnname").value.trim();
      const ip = cfBody.querySelector("#cf-dnip").value;
      return { cmd: `tftp -p -l ${name} ${ip}`, name, ip };
    }
    cfBody.querySelector("#cf-dncopy").addEventListener("click", async () => {
      const { cmd, name, ip } = genCmd();
      if (!name) { st.textContent = "先填文件名"; return; }
      await navigator.clipboard.writeText(cmd).catch(() => {});
      st.textContent = `已复制: ${cmd}`;
      saveTftpSettings({ cmd_download_ip: ip, cmd_download_name: name });
    });
    cfBody.querySelector("#cf-dnsend").addEventListener("click", () => {
      const { cmd, name, ip } = genCmd();
      if (!name) { st.textContent = "先填文件名"; return; }
      saveTftpSettings({ cmd_download_ip: ip, cmd_download_name: name });
      sendToSerial(p, cmd, st, "串口可见执行");
    });
  });

  /* --- client test area --- */
  const tcStatus = p.querySelector("#tc-status");
  const prog = channel((msg) => {
    const ev = typeof msg === "string" ? JSON.parse(msg) : msg;
    if (ev.kind === "progress") tcStatus.textContent = `${ev.file}: ${ev.bytes}B`;
    else if (ev.kind === "done") { tcStatus.textContent = `完成: ${ev.file} ${ev.bytes}B (${ev.speed ?? "?"}B/s)`; refreshFiles(); }
    else if (ev.kind === "error") tcStatus.textContent = `错误: ${ev.message ?? ev}`;
  });
  p.querySelector("#tc-get").addEventListener("click", async () => {
    const server = p.querySelector("#tc-server").value.trim();
    const remote = p.querySelector("#tc-remote").value.trim();
    const local = p.querySelector("#tc-local").value.trim();
    tcStatus.textContent = "Get 中…";
    try {
      await invoke("tftp_get", { args: { server, remote, local, port: 69 }, onProgress: prog });
    } catch (e) { tcStatus.textContent = String(e); }
  });
  p.querySelector("#tc-put").addEventListener("click", async () => {
    const server = p.querySelector("#tc-server").value.trim();
    const remote = p.querySelector("#tc-remote").value.trim();
    const local = p.querySelector("#tc-local").value.trim();
    tcStatus.textContent = "Put 中…";
    try {
      await invoke("tftp_put", { args: { server, local, remote, port: 69 }, onProgress: prog });
    } catch (e) { tcStatus.textContent = String(e); }
  });
}

function status5(p, text) {
  const el = p.querySelector("#tf-srv-status");
  if (el) el.textContent = text;
}

/// Ask user which serial session to type the command into, then write it.
function sendToSerial(panelEl, cmd, statusEl, note) {
  const serialSessions = window.__devtermSerialSessions?.() ?? [];
  if (!serialSessions.length) {
    statusEl.textContent = "没有活动的串口会话。命令已复制,请手动粘贴。";
    navigator.clipboard.writeText(cmd).catch(() => {});
    return;
  }
  statusEl.innerHTML = `将在串口可见执行,选择会话: <select id="ses-sel">${serialSessions.map((s) => `<option value="${s.id}">${s.label}</option>`).join("")}</select> <button id="ses-go">发送</button>`;
  statusEl.querySelector("#ses-go").addEventListener("click", async () => {
    const id = parseInt(statusEl.querySelector("#ses-sel").value, 10);
    statusEl.textContent = note;
    window.__devtermSendToSession?.(id, cmd + "\r");
  });
}

/* ---------- wiring ---------- */

export function initPanels() {
  onSessionData(async (id, data) => {
    try {
      // dispatch by session kind: look up which transport owns this id
      const kind = sessionKind(id);
      if (kind === "telnet") {
        await invoke("telnet_write", { id, dataBase64: toB64(data) });
      } else {
        await invoke("serial_write", { id, dataBase64: toB64(data) });
      }
    } catch (e) {
      sessionState(id, "error", String(e));
      throw e;
    }
  });

  onSessionClose(async (id) => {
    autoLogin.drop(id);
    try {
      const kind = sessionKind(id);
      if (kind === "telnet") await invoke("telnet_close", { id });
      else await invoke("serial_close", { id });
      await invoke("session_close", { id });
    } catch (_) {}
  });

  document.getElementById("btn-new").addEventListener("click", () => showConnectPanel("serial"));
  document.getElementById("btn-discover").addEventListener("click", showDiscoverPanel);
  document.getElementById("btn-tftp").addEventListener("click", showTftpPanel);
  document.getElementById("btn-cmds").addEventListener("click", showCmdsPanel);
  document.getElementById("btn-settings").addEventListener("click", showSettingsPanel);
}

/* ---------- quick commands panel ---------- */

export async function showCmdsPanel() {
  const p = ensurePanel("快捷命令");
  const cmds = await invoke("cmds_list").catch(() => []);
  const pathStr = await invoke("cmds_path_str").catch(() => "cmds.json");

  p.innerHTML = `
    <h3>快捷命令</h3>
    <p class="muted">点击命令 → 选择会话发送。存储: <span style="word-break:break-all">${pathStr}</span></p>
    <div class="row">
      <button id="qc-add" style="flex:1">+ 添加命令</button>
      <button id="qc-edit" style="flex:1">编辑全部</button>
    </div>
    <div id="qc-list"></div>
  `;
  const list = p.querySelector("#qc-list");
  const sessions = window.__devtermAllSessions?.() ?? [];

  function render() {
    const groups = new Map();
    for (const c of cmds) {
      const g = c.group || "未分组";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    list.innerHTML = [...groups.entries()]
      .map(
        ([g, items]) => `
        <p class="muted" style="margin:8px 0 4px">${g}</p>
        ${items
          .map(
            (c) =>
              `<div class="list-item qc-item" data-name="${encodeURIComponent(c.name)}"><div style="flex:1;overflow:hidden;text-overflow:ellipsis"><b>${c.name}</b><br><span class="muted" style="font-size:11px">${c.cmd.replace(/</g, "&lt;")}</span></div></div>`
          )
          .join("")}`
      )
      .join("");
    list.querySelectorAll(".qc-item").forEach((el) => {
      el.addEventListener("click", () => {
        const name = decodeURIComponent(el.dataset.name);
        const c = cmds.find((x) => x.name === name);
        if (!c) return;
        // Send straight to the ACTIVE window (whatever tab the user is on).
        const active = window.__devtermActiveSession?.();
        if (active?.id != null) {
          const sessLabel = sessions.find((s) => s.id === active.id)?.label ?? active.kind;
          window.__devtermSendToSession?.(active.id, c.cmd + "\r");
          el.insertAdjacentHTML(
            "afterend",
            `<p class="muted qc-flash">已发送到 ${sessLabel} → ${c.cmd.replace(/</g, "&lt;")}</p>`
          );
          const note = el.nextElementSibling;
          setTimeout(() => note?.remove(), 2500);
          return;
        }
        // No active window: copy as fallback.
        navigator.clipboard.writeText(c.cmd).catch(() => {});
        el.insertAdjacentHTML("afterend", `<p class="muted">没有活动窗口,命令已复制到剪贴板</p>`);
        const note = el.nextElementSibling;
        setTimeout(() => note?.remove(), 2500);
      });
    });
  }

  p.querySelector("#qc-add").addEventListener("click", () => {
    const name = prompt("命令名称:");
    if (!name) return;
    const cmd = prompt("命令内容:");
    if (!cmd) return;
    const group = prompt("分组(留空=未分组):") || "";
    cmds.push({ name, cmd, group });
    invoke("cmds_save", { cmds }).then(render);
  });

  p.querySelector("#qc-edit").addEventListener("click", () => {
    cfEditDialog(p, cmds, () => render());
  });

  function cfEditDialog(p, cmds, onDone) {
    // simple textarea JSON editor
    p.querySelector("#qc-list").insertAdjacentHTML(
      "beforebegin",
      `<div id="qc-json" style="margin-bottom:8px">
        <textarea id="qc-json-text" style="width:100%;height:200px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;font-family:Consolas,monospace;font-size:11px"></textarea>
        <div class="row" style="margin-top:4px">
          <button id="qc-json-save" style="flex:1">保存 JSON</button>
          <button id="qc-json-cancel" style="flex:1">取消</button>
        </div>
      </div>`
    );
    const ta = p.querySelector("#qc-json-text");
    ta.value = JSON.stringify(cmds, null, 2);
    const box = p.querySelector("#qc-json");
    box.querySelector("#qc-json-cancel").addEventListener("click", () => box.remove());
    box.querySelector("#qc-json-save").addEventListener("click", async () => {
      try {
        const parsed = JSON.parse(ta.value);
        if (!Array.isArray(parsed)) throw new Error("必须是数组");
        for (const c of parsed) {
          if (!c.name || !c.cmd) throw new Error("每项需要 name 和 cmd");
        }
        await invoke("cmds_save", { cmds: parsed });
        cmds.length = 0;
        parsed.forEach((c) =>
          cmds.push({ name: c.name, cmd: c.cmd, group: c.group || "" })
        );
        box.remove();
        onDone();
      } catch (e) {
        alert("JSON 错误: " + e);
      }
    });
  }

  render();
}

/* ---------- settings panel (auto-login + appearance) ---------- */

export async function showSettingsPanel() {
  const p = ensurePanel("设置");
  const s = await invoke("settings_get").catch(() => ({}));
  const history = s.device_history ?? [];

  // candidate targets for the per-device rules: serial -> port name,
  // telnet -> host:port (from the device history)
  const candidates = history.map((r) =>
    r.kind === "serial" ? r.port : `${r.host}:${r.port}`
  );

  const enabled = !!s.auto_login_enabled;
  const mode = s.auto_login_mode === "per_device" ? "per_device" : "global";
  const zoom = s.ui_zoom ?? 100;
  p.innerHTML = `
    <h3>设置</h3>

    <div class="settings-card">
      <div class="sc-head">
        <span class="sc-title">界面</span>
      </div>
      <div class="row">
        <span class="sc-label">缩放</span>
        <input id="st-ui-zoom" type="range" min="50" max="200" step="25" value="${zoom < 50 ? 50 : zoom}" />
        <span id="st-ui-zoom-val" class="sc-label" style="min-width:36px;text-align:right">${zoom}%</span>
      </div>
      <div class="row"><span class="sc-label">软件字体(px)</span><input id="st-ui-font" type="number" min="10" max="24" value="${s.ui_font_size || 13}" /></div>
      <div class="row"><span class="sc-label">软件文字颜色</span><input id="st-ui-fg" type="color" value="${normColor(s.ui_fg, "#d4d4d4")}" /></div>
      <div class="row"><span class="sc-label">终端字体(px)</span><input id="st-term-font" type="number" min="9" max="32" value="${s.term_font_size || 13}" /></div>
      <div class="row"><span class="sc-label">终端文字颜色</span><input id="st-term-fg" type="color" value="${normColor(s.term_fg, "#d4d4d4")}" /></div>
      <div class="row"><span class="sc-label">终端背景色</span><input id="st-term-bg" type="color" value="${normColor(s.term_bg, "#1e1e1e")}" /></div>
      <div class="row">
        <button id="st-ui-reset" style="flex:1">恢复默认</button>
        <button id="st-devtools" style="flex:1">开发者模式</button>
      </div>
    </div>

    <div class="settings-card">
      <div class="sc-head">
        <span class="sc-title">自动登录</span>
        <label class="toggle-switch" title="启用/停用自动登录">
          <input type="checkbox" id="st-al-enabled" ${enabled ? "checked" : ""} />
          <span class="tg-slider"></span>
        </label>
      </div>
      <p class="muted">监视设备输出,出现 login:/Password: 提示符时自动输入账号密码(串口与 Telnet 通用)。</p>

      <div class="seg-tabs">
        <button id="st-al-global" class="${mode === "global" ? "sel" : ""}">全局默认</button>
        <button id="st-al-perdev" class="${mode === "per_device" ? "sel" : ""}">按设备指定</button>
      </div>
      <p class="muted" id="st-al-mode-hint">${mode === "global" ? "所有连接使用同一组账号密码" : "按设备标识匹配规则,无匹配时回退全局默认"}</p>

      <div id="st-al-global-body" style="${mode === "global" ? "" : "display:none"}">
        <div class="row"><input id="st-al-user" value="${escHtml(s.auto_login_user ?? "")}" placeholder="用户名,如 root" /></div>
        <div class="row"><input id="st-al-pass" type="password" value="${escHtml(s.auto_login_pass ?? "")}" placeholder="密码" /></div>
      </div>

      <div id="st-al-perdev-body" style="${mode === "per_device" ? "" : "display:none"}">
        <datalist id="st-al-targets">${candidates.map((c) => `<option value="${escHtml(c)}">`).join("")}</datalist>
        <p class="muted">设备标识:串口填 COM 名(如 COM4),Telnet 填 IP:端口(如 192.168.10.123:2356)</p>
        <div id="st-al-rules"></div>
        <div class="row"><button id="st-al-addrule" style="flex:1">+ 添加规则</button></div>
      </div>
    </div>

    <p class="muted" id="st-status">改动即自动保存。</p>
  `;

  const rulesEl = p.querySelector("#st-al-rules");
  const globalBody = p.querySelector("#st-al-global-body");
  const perdevBody = p.querySelector("#st-al-perdev-body");
  const hint = p.querySelector("#st-al-mode-hint");
  const enabledChk = p.querySelector("#st-al-enabled");
  let isEnabled = enabled;
  let modeSel = mode;

  function escHtml(t) {
    return String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  /// Color picker inputs need a valid #rrggbb value; fall back for old/empty.
  function normColor(v, def) {
    const t = String(v ?? "").trim();
    return /^#[0-9a-fA-F]{6}$/.test(t) ? t : def;
  }

  function addRuleRow(rule = { target: "", user: "", pass: "" }) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <input class="rl-target" list="st-al-targets" value="${escHtml(rule.target)}" placeholder="设备标识" style="flex:1.4" />
      <input class="rl-user" value="${escHtml(rule.user)}" placeholder="用户名" style="flex:1" />
      <input class="rl-pass" type="password" value="${escHtml(rule.pass)}" placeholder="密码" style="flex:1" />
      <button class="rl-del" title="删除" style="padding:6px 8px">✕</button>
    `;
    row.querySelector(".rl-del").addEventListener("click", () => row.remove());
    rulesEl.appendChild(row);
  }

  (s.auto_login_rules ?? []).forEach((r) => addRuleRow(r));
  p.querySelector("#st-al-addrule").addEventListener("click", () => addRuleRow());

  const status = p.querySelector("#st-status");
  let saveTimer = null;

  /// Persist the whole settings block (read-latest-then-patch so fields
  /// other panels saved meanwhile are not clobbered), debounced: every
  /// change saves on its own - no separate 保存 button, matching the other
  /// panels' save-on-change behavior (切走面板也不丢).
  async function saveNow() {
    try {
      const cur = await invoke("settings_get");
      // appearance card (color pickers always hold a valid value; saved as-is)
      cur.ui_zoom = parseInt(p.querySelector("#st-ui-zoom").value, 10) || 100;
      cur.ui_font_size = parseInt(p.querySelector("#st-ui-font").value, 10) || 0;
      cur.ui_fg = p.querySelector("#st-ui-fg").value;
      cur.term_font_size = parseInt(p.querySelector("#st-term-font").value, 10) || 13;
      cur.term_fg = p.querySelector("#st-term-fg").value;
      cur.term_bg = p.querySelector("#st-term-bg").value;
      // auto-login card
      cur.auto_login_enabled = isEnabled;
      cur.auto_login_mode = modeSel;
      cur.auto_login_user = p.querySelector("#st-al-user").value;
      cur.auto_login_pass = p.querySelector("#st-al-pass").value;
      cur.auto_login_rules = [...rulesEl.querySelectorAll(".row")]
        .map((row) => ({
          target: row.querySelector(".rl-target").value.trim(),
          user: row.querySelector(".rl-user").value,
          pass: row.querySelector(".rl-pass").value,
        }))
        .filter((r) => r.target && r.user);
      await invoke("settings_set", { settings: cur });
      applyAppearance(cur);
      await autoLogin.reload();
      status.textContent = "已保存 ✓";
      setTimeout(() => { if (status.textContent === "已保存 ✓") status.textContent = "改动即自动保存。"; }, 1500);
    } catch (e) {
      status.textContent = String(e);
    }
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  enabledChk.addEventListener("change", () => {
    isEnabled = enabledChk.checked;
    scheduleSave();
  });
  p.querySelector("#st-al-global").addEventListener("click", () => {
    modeSel = "global";
    p.querySelector("#st-al-global").classList.add("sel");
    p.querySelector("#st-al-perdev").classList.remove("sel");
    globalBody.style.display = "";
    perdevBody.style.display = "none";
    hint.textContent = "所有连接使用同一组账号密码";
    scheduleSave();
  });
  p.querySelector("#st-al-perdev").addEventListener("click", () => {
    modeSel = "per_device";
    p.querySelector("#st-al-perdev").classList.add("sel");
    p.querySelector("#st-al-global").classList.remove("sel");
    globalBody.style.display = "none";
    perdevBody.style.display = "";
    hint.textContent = "按设备标识匹配规则,无匹配时回退全局默认";
    scheduleSave();
  });
  // text inputs: save on typing pause and on focus leave
  for (const sel of ["#st-al-user", "#st-al-pass"]) {
    p.querySelector(sel).addEventListener("input", scheduleSave);
    p.querySelector(sel).addEventListener("change", scheduleSave);
  }
  rulesEl.addEventListener("input", scheduleSave);
  rulesEl.addEventListener("change", scheduleSave);
  // row add/remove must save too (delegation: rows come and go)
  p.querySelector("#st-al-addrule").addEventListener("click", scheduleSave);
  rulesEl.addEventListener("click", (e) => {
    if (e.target.classList.contains("rl-del")) scheduleSave();
  });
  // appearance card inputs
  for (const sel of ["#st-ui-zoom", "#st-ui-font", "#st-ui-fg", "#st-term-font", "#st-term-fg", "#st-term-bg"]) {
    p.querySelector(sel).addEventListener("input", scheduleSave);
    p.querySelector(sel).addEventListener("change", scheduleSave);
  }
  // zoom slider: live % readout next to the thumb
  const zoomInput = p.querySelector("#st-ui-zoom");
  const zoomVal = p.querySelector("#st-ui-zoom-val");
  zoomInput.addEventListener("input", () => {
    zoomVal.textContent = `${zoomInput.value}%`;
  });
  // restore appearance defaults: reset controls, then save+apply
  p.querySelector("#st-ui-reset").addEventListener("click", () => {
    zoomInput.value = 100;
    zoomVal.textContent = "100%";
    p.querySelector("#st-ui-font").value = 13;
    p.querySelector("#st-ui-fg").value = "#d4d4d4";
    p.querySelector("#st-term-font").value = 13;
    p.querySelector("#st-term-fg").value = "#d4d4d4";
    p.querySelector("#st-term-bg").value = "#1e1e1e";
    scheduleSave();
  });
  // toggle WebView2 devtools (F12 console/inspector)
  p.querySelector("#st-devtools").addEventListener("click", async () => {
    try {
      const r = await invoke("devtools_toggle");
      status.textContent = r === "open" ? "开发者工具已打开(F12)" : "开发者工具已关闭";
      setTimeout(() => { status.textContent = "改动即自动保存。"; }, 2000);
    } catch (e) {
      status.textContent = String(e);
    }
  });
}
