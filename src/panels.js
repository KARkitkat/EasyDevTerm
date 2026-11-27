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
  onReconnect,
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

/// The TFTP transfer staging dir: always `tftptmp` next to the exe (created
/// by the backend on demand). Every transfer stages here, then copies out to
/// wherever the user asked for - one fixed relay, no dir switching.
async function defaultTftpDir() {
  return await invoke("tftp_default_dir").catch(() => "");
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
    createSessionTab(sid, label, "serial", {
      port,
      reconnectable: { kind: "serial", port, baud_rate: baud, label },
    });
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
    createSessionTab(sid, label, "telnet", {
      ip: host,
      port,
      reconnectable: { kind: "telnet", host, port, label },
    });
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
                `<div class="list-item ct-hist-item" data-kind="saved" data-idx="${i}">${r.note || r.label} <button class="rb-dl ct-edit" title="编辑备注名" style="float:right"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M11.5 2.5a1.4 1.4 0 0 1 2 2L6 12l-3 1 1-3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button> <span class="ct-unsave muted" title="从已保存移除" style="float:right">✕</span></div>`
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
  // Edit a saved connection: note (display name) + target address fields.
  box.querySelectorAll(".ct-edit").forEach((el) => {
    el.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const item = ev.target.closest(".ct-hist-item");
      const idx = parseInt(item.dataset.idx, 10);
      const s = await invoke("settings_get").catch(() => ({}));
      const r = (s.saved_devices ?? [])[idx];
      if (!r) return;
      const isSerial = r.kind === "serial";
      const ov = document.createElement("div");
      ov.className = "perm-dialog";
      ov.innerHTML = `
        <div class="perm-box editor-box" style="width:min(420px,90vw)">
          <p class="sc-title">编辑连接</p>
          <p class="muted" style="margin:4px 0 8px">${isSerial ? "串口" : "Telnet"} · 原标识: ${r.label}</p>
          <div class="row"><span class="sc-label" style="width:70px">备注名</span><input id="note-input" placeholder="留空恢复默认" value="${escAttr(r.note || "")}" /></div>
          ${isSerial
            ? `<div class="row"><span class="sc-label" style="width:70px">串口</span><input id="edit-port" value="${escAttr(r.port)}" placeholder="如 COM4" /></div>
               <div class="row"><span class="sc-label" style="width:70px">波特率</span><input id="edit-baud" value="${r.baud_rate}" placeholder="115200" /></div>`
            : `<div class="row"><span class="sc-label" style="width:70px">IP 地址</span><input id="edit-host" value="${escAttr(r.host)}" placeholder="如 192.168.1.1" /></div>
               <div class="row"><span class="sc-label" style="width:70px">端口</span><input id="edit-port" value="${r.port}" placeholder="23" /></div>`}
          <div class="row" style="margin-top:8px">
            <button id="note-ok" style="flex:1">确定</button>
            <button id="note-cancel" class="ed-cancel" style="flex:1">取消</button>
          </div>
        </div>
      `;
      document.body.appendChild(ov);
      const input = ov.querySelector("#note-input");
      input.focus();
      input.select();
      const close = () => ov.remove();
      ov.querySelector("#note-cancel").addEventListener("click", close);
      ov.querySelectorAll("input").forEach((inp) =>
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter") ov.querySelector("#note-ok").click();
          if (e.key === "Escape") close();
        })
      );
      ov.querySelector("#note-ok").addEventListener("click", async () => {
        const note = input.value.trim();
        close();
        const cur = await invoke("settings_get").catch(() => ({}));
        const rec = (cur.saved_devices ?? [])[idx];
        if (!rec) return;
        rec.note = note;
        if (isSerial) {
          const port = ov.querySelector("#edit-port")?.value.trim();
          const baud = parseInt(ov.querySelector("#edit-baud")?.value, 10);
          if (port) rec.port = port;
          if (baud > 0) rec.baud_rate = baud;
          rec.label = `${rec.port} @ ${rec.baud_rate}`;
        } else {
          const host = ov.querySelector("#edit-host")?.value.trim();
          const port = parseInt(ov.querySelector("#edit-port")?.value, 10);
          if (host) rec.host = host;
          if (port > 0) rec.port = port;
          rec.label = rec.port === 23 ? `telnet ${rec.host}` : `telnet ${rec.host}:${rec.port}`;
        }
        await invoke("settings_set", { settings: cur }).catch(() => {});
        renderDeviceHistory(mount);
      });
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

/// Escape a value for use inside an HTML attribute (double-quoted).
function escAttr(t) {
  return String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
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
      <button id="rb-transfers" title="传输记录" style="padding:6px 8px;line-height:0"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M5.5 13.5v-11M2.5 5.5l3-3 3 3M10.5 2.5v11M7.5 10.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
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

    <div id="transfers-block" style="display:none">
    <h3 style="margin-top:14px">传输记录</h3>
    <div id="tf-transfers" class="scroll-list muted">暂无传输</div>
    </div>
  `;

  /* --- router browser (hidden session) --- */
  const rbStatus = p.querySelector("#rb-status");
  const rbList = p.querySelector("#rb-list");
  const rbPathEl = p.querySelector("#rb-path");
  const rbPathRow = p.querySelector("#rb-path-row");
  let cwd = "/";

  function rshArgs() {
    const host = p.querySelector("#rb-host").value.trim();
    const port = parseInt(p.querySelector("#rb-port").value, 10) || 23;
    // Fall back to the auto-login credentials for this device (same rules the
    // terminal sessions use) when the user left the fields empty.
    let user = p.querySelector("#rb-user").value.trim();
    let password = p.querySelector("#rb-pass").value;
    if (!user || !password) {
      const creds = autoLogin.credentialsFor(`${host}:${port}`);
      if (creds) {
        if (!user) user = creds.user || "";
        if (!password) password = creds.pass || "";
      }
    }
    return { host, port, user: user || "root", password };
  }

  async function saveRshSettings() {
    const s = await invoke("settings_get").catch(() => ({}));
    s.telnet_user = p.querySelector("#rb-user").value.trim();
    s.telnet_password = p.querySelector("#rb-pass").value;
    await invoke("settings_set", { settings: s }).catch(() => {});
  }

  // File-row icon buttons (stroke style, same family as the download icon).
  const RB_ICONS = {
    open: `<svg viewBox="0 0 16 16" width="14" height="14"><path d="M6.5 3.5h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3M9.5 2.5h4v4M13 3 8.5 7.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    rename: `<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 4v8M4 3h8M4 13h8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
    del: `<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2.5 4h11M5.5 4V2.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V4M4 4l.7 9a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4M6.5 6.5v5M9.5 6.5v5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    perm: `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3" y="7" width="10" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  };

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
                `<div class="list-item rb-entry" data-name="${e.name}" data-dir="${e.is_dir}">${e.is_dir ? "📁" : "📄"} <span class="rb-name">${e.name}${e.is_dir ? "/" : ""}</span>${e.is_dir ? "" :
                  `<button class="rb-dl" title="下载到 PC"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 1v8M4.5 5.5 8 9l3.5-3.5M2 11.5V13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` +
                  `<button class="rb-dl rb-open" title="下载到本地并用默认编辑器打开,关闭后若有修改则回传设备">${RB_ICONS.open}</button>` +
                  `<button class="rb-dl rb-rename" title="重命名">${RB_ICONS.rename}</button>` +
                  `<button class="rb-dl rb-del" title="删除">${RB_ICONS.del}</button>` +
                  `<button class="rb-dl rb-perm" title="权限">${RB_ICONS.perm}</button>`
                }</div>`
            )
            .join("")
        : `<p class="muted">(空目录)</p>`;
      rbStatus.textContent = "";
      rbList.querySelectorAll(".rb-entry").forEach((el) => {
        el.addEventListener("click", async (ev) => {
          if (ev.target.closest(".rb-dl")) return; // icon buttons handle themselves
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
          if (btn.classList.contains("rb-open")) await openFile(name);
          else if (btn.classList.contains("rb-rename")) await renameFile(name);
          else if (btn.classList.contains("rb-del")) await deleteFile(name);
          else if (btn.classList.contains("rb-perm")) await editPerms(name);
          else await downloadFile(name);
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

  // Auto-connect when following an active telnet window: credentials may come
  // from the form, saved telnet settings, or the auto-login config.
  if (followIp) {
    const a = rshArgs();
    if (a.password || !a.user) doConnect();
  }
  p.querySelector("#rb-up").addEventListener("click", () => {
    if (cwd !== "/") browse(cwd.replace(/\/[^/]*$/, "") || "/");
  });
  p.querySelector("#rb-refresh").addEventListener("click", () => browse(cwd));

  /// Ensure the TFTP server runs on the relay dir (tftptmp). Returns the
  /// actual port (69, or a fallback when 69 was taken) or null on failure.
  async function ensureTftpServer() {
    const srvPort = parseInt(portInput?.value ?? "69", 10) || 69;
    const running = await invoke("tftp_server_status").catch(() => false);
    if (running) return srvPort;
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
      const r = await invoke("tftp_server_start", { args: { dir: await defaultTftpDir(), port: srvPort }, onEvent: evCh });
      srvStatus.textContent = "运行中";
      toggleBtn.textContent = "停止";
      toggleBtn.classList.add("stop");
      let port = srvPort;
      const m = /随机端口 (\d+)/.exec(r);
      if (m) {
        port = parseInt(m[1], 10);
        portInput.value = port;
      }
      return port;
    } catch (e) {
      rbStatus.textContent = `服务端启动失败: ${e}`;
      return null;
    }
  }

  /* --- download: device pushes file to PC server dir, then save-as --- */
  async function downloadFile(name) {
    const host = p.querySelector("#rb-host").value.trim();
    if (!host) { rbStatus.textContent = "未填写路由器 IP"; return; }
    // relay is always tftptmp; show it in the input for transparency
    const srvDir = await defaultTftpDir();
    if (!srvDir) { rbStatus.textContent = "无法确定服务目录"; return; }
    if (dirInput && !dirInput.value.trim()) dirInput.value = srvDir;

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
    const srvPort = await ensureTftpServer();
    if (srvPort == null) return;

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

  /* --- open: device pushes file to tftptmp, built-in editor shows it,
         "save" writes back to the device (permissions preserved) --- */
  async function openFile(name) {
    const host = p.querySelector("#rb-host").value.trim();
    if (!host) { rbStatus.textContent = "未填写路由器 IP"; return; }
    const relayDir = await defaultTftpDir();
    if (!relayDir) { rbStatus.textContent = "无法确定服务目录"; return; }
    const srvPort = await ensureTftpServer();
    if (srvPort == null) return;
    const pcIp = await invoke("local_ip_toward", { dst: host }).catch((e) => { rbStatus.textContent = String(e); return null; });
    if (!pcIp) return;

    const remote = cwd === "/" ? `/${name}` : `${cwd}/${name}`;
    const portArg = srvPort === 69 ? "" : ` ${srvPort}`;
    rbStatus.textContent = `读取 ${name}…`;
    try {
      // remember current permissions so the write-back keeps them
      const lsOut = await invoke("rsh_exec", { args: rshArgs(), cmd: `ls -l '${remote}' 2>&1` });
      const permMatch = /(?:^|\s)([-dl][rwxstST-]{9})/.exec(lsOut || "");
      const permStr = permMatch ? permMatch[1] : "";

      setTransferRow("open", name, "0%", `← ${remote}`);
      const pushOut = (await invoke("rsh_exec", {
        args: rshArgs(),
        cmd: `tftp -p -l '${remote}' -r '${name}' ${pcIp}${portArg}`,
      }) || "").trim();
      if (pushOut) {
        setTransferRow("open", name, "失败", pushOut, "fail");
        rbStatus.textContent = `读取失败: ${pushOut}`;
        return;
      }

      // load the local copy into the built-in editor
      const localPath = `${relayDir}\\${name}`;
      const b64 = await invoke("read_file_base64", { path: localPath });
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (bytes.includes(0)) {
        setTransferRow("open", name, "失败", "二进制文件", "fail");
        rbStatus.textContent = "二进制文件,内置编辑器不支持,请使用下载";
        return;
      }
      const dec = new TextDecoder("utf-8", { fatal: false });
      const text = dec.decode(bytes);
      if (text.includes("\uFFFD")) {
        rbStatus.textContent = "提示: 非 UTF-8 文本,保存可能损坏编码";
      }

      // editor dialog (same overlay family as the permission dialog)
      const ov = document.createElement("div");
      ov.className = "perm-dialog";
      ov.innerHTML = `
        <div class="perm-box editor-box">
          <p class="sc-title">${name}</p>
          <p class="muted" style="margin:4px 0 8px">${permStr || ""}</p>
          <div class="ed-wrap">
            <pre id="ed-gutter" aria-hidden="true"></pre>
            <textarea id="ed-text" spellcheck="false"></textarea>
          </div>
          <div class="ed-findbar">
            <input id="ed-find" placeholder="查找" style="flex:2" />
            <input id="ed-replace" placeholder="替换为" style="flex:2" />
            <button id="ed-find-next" title="查找下一个(Enter)">下一个</button>
            <button id="ed-replace-one" title="替换当前,再查找下一个">替换</button>
            <button id="ed-replace-all" title="替换全部">全部</button>
            <span id="ed-find-status" class="muted"></span>
            <input id="ed-goto" placeholder="跳转行号" class="ed-goto" />
            <button id="ed-goto-go" title="跳到指定行(光标定位)">跳转</button>
          </div>
          <div class="ed-findbar">
            <span id="ed-save-note" class="muted" style="flex:1"></span>
            <button id="ed-save">保存</button>
            <button id="ed-cancel" class="ed-cancel">取消</button>
          </div>
        </div>
      `;
      document.body.appendChild(ov);
      const ta = ov.querySelector("#ed-text");
      const gutter = ov.querySelector("#ed-gutter");
      ta.value = text;
      // line-number gutter: rebuild on input, scroll-lock with the textarea
      const renderGutter = () => {
        const n = ta.value.split("\n").length;
        let s = "";
        for (let i = 1; i <= n; i++) s += i + "\n";
        gutter.textContent = s;
      };
      renderGutter();
      ta.addEventListener("input", () => {
        renderGutter();
        findState.from = 0; // content changed: restart search from the top
      });
      ta.addEventListener("scroll", () => {
        gutter.scrollTop = ta.scrollTop;
      });

      /* --- find & replace / goto --- */
      const findState = { from: 0 };
      const findInput = ov.querySelector("#ed-find");
      const findStatus = ov.querySelector("#ed-find-status");
      const setSel = (start, len) => {
        ta.focus();
        ta.setSelectionRange(start, start + len);
        // scroll the selection into view (textarea has no scrollIntoView;
        // estimate the line and scroll by line height)
        const line = ta.value.slice(0, start).split("\n").length - 1;
        const lh = 18; // 12px * 1.5
        const target = line * lh - ta.clientHeight / 2;
        ta.scrollTop = Math.max(0, target);
        gutter.scrollTop = ta.scrollTop;
      };
      const doFind = (from) => {
        const needle = findInput.value;
        if (!needle) { findStatus.textContent = ""; return -1; }
        const idx = ta.value.indexOf(needle, from);
        if (idx < 0) {
          // wrap once
          const wrapped = ta.value.indexOf(needle, 0);
          if (wrapped < 0) { findStatus.textContent = "未找到"; return -1; }
          findStatus.textContent = "已从头开始";
          setSel(wrapped, needle.length);
          findState.from = wrapped + needle.length;
          return wrapped;
        }
        setSel(idx, needle.length);
        findState.from = idx + needle.length;
        return idx;
      };
      ov.querySelector("#ed-find-next").addEventListener("click", () => doFind(findState.from));
      findInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); doFind(findState.from); }
        if (e.key === "Escape") findInput.blur();
      });
      ov.querySelector("#ed-replace-one").addEventListener("click", () => {
        const needle = findInput.value;
        const repl = ov.querySelector("#ed-replace").value;
        if (!needle) return;
        const sel = ta.value.indexOf(needle, findState.from);
        const at = sel >= 0 ? sel : ta.value.indexOf(needle, 0); // use selection if it matches
        const start = ta.selectionStart;
        if (ta.value.slice(start, ta.selectionEnd) === needle) {
          ta.setRangeText(repl, start, ta.selectionEnd, "end");
          ta.dispatchEvent(new Event("input"));
          doFind(ta.selectionStart);
        } else {
          // selection isn't a match: find the next one first
          const idx = at >= 0 ? at : -1;
          if (idx < 0) { findStatus.textContent = "未找到"; return; }
          ta.setRangeText(repl, idx, idx + needle.length, "end");
          ta.dispatchEvent(new Event("input"));
          doFind(idx + repl.length);
        }
      });
      ov.querySelector("#ed-replace-all").addEventListener("click", () => {
        const needle = findInput.value;
        const repl = ov.querySelector("#ed-replace").value;
        if (!needle) return;
        ta.value = ta.value.split(needle).join(repl);
        ta.dispatchEvent(new Event("input"));
        findStatus.textContent = "已全部替换";
      });
      const doGoto = () => {
        const v = parseInt(ov.querySelector("#ed-goto").value, 10);
        const lines = ta.value.split("\n");
        if (!v || v < 1 || v > lines.length) return;
        // char offset of the start of line v
        let off = 0;
        for (let i = 0; i < v - 1; i++) off += lines[i].length + 1;
        setSel(off, 0);
      };
      ov.querySelector("#ed-goto-go").addEventListener("click", doGoto);
      ov.querySelector("#ed-goto").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); doGoto(); }
        if (e.key === "Escape") e.target.blur();
      });
      ov.querySelector("#ed-cancel").addEventListener("click", () => {
        ov.remove();
        setTransferRow("open", name, "成功", "未修改", "ok");
        rbStatus.textContent = "已取消(设备文件未动)";
      });
      ov.querySelector("#ed-save").addEventListener("click", async () => {
        const edited = ov.querySelector("#ed-text").value;
        ov.remove();
        rbStatus.textContent = "写入本地副本…";
        try {
          const newBytes = new TextEncoder().encode(edited);
          let binStr = "";
          newBytes.forEach((b) => (binStr += String.fromCharCode(b)));
          await invoke("write_file_base64", { path: localPath, dataBase64: btoa(binStr) });

          setTransferRow("open", name, "0%", `回传 ${remote}`);
          rbStatus.textContent = "回传到设备…";
          const pullOut = (await invoke("rsh_exec", {
            args: rshArgs(),
            cmd: `tftp -g -l '${remote}' -r '${name}' ${pcIp}${portArg}`,
          }) || "").trim();
          if (pullOut) {
            setTransferRow("open", name, "失败", pullOut, "fail");
            rbStatus.textContent = `回传失败: ${pullOut}`;
            return;
          }
          if (permStr) {
            const oct = permToOctal(permStr.slice(1));
            if (oct) await invoke("rsh_exec", { args: rshArgs(), cmd: `chmod ${oct} '${remote}'` });
          }
          setTransferRow("open", name, "成功", `回传 ${remote}`, "ok");
          rbStatus.textContent = "修改已回传设备";
          refreshFiles();
        } catch (e) {
          rbStatus.textContent = String(e);
        }
      });
    } catch (e) {
      rbStatus.textContent = String(e);
    }
  }

  /// "rwxr-xr--" -> "754" (u/g/o rwx bits only; sticky/setuid not handled).
  function permToOctal(s) {
    const tri = (t) =>
      (t[0] === "r" ? 4 : 0) + (t[1] === "w" ? 2 : 0) + (t[2] === "x" ? 1 : 0);
    return `${tri(s.slice(0, 3))}${tri(s.slice(3, 6))}${tri(s.slice(6, 9))}`;
  }

  /* --- rename / delete / perms: single rsh_exec each --- */
  async function renameFile(name) {
    const newName = prompt("新文件名:", name);
    if (!newName || newName === name) return;
    if (/['"\\/$]/.test(newName)) { rbStatus.textContent = "文件名含非法字符"; return; }
    const oldPath = cwd === "/" ? `/${name}` : `${cwd}/${name}`;
    const newPath = cwd === "/" ? `/${newName}` : `${cwd}/${newName}`;
    rbStatus.textContent = "重命名中…";
    try {
      const out = (await invoke("rsh_exec", {
        args: rshArgs(),
        cmd: `mv '${oldPath}' '${newPath}' 2>&1`,
      }) || "").trim();
      if (out) { rbStatus.textContent = `重命名失败: ${out}`; return; }
      rbStatus.textContent = `已重命名为 ${newName}`;
      browse(cwd);
    } catch (e) {
      rbStatus.textContent = String(e);
    }
  }

  async function deleteFile(name) {
    if (!confirm(`确定删除设备上的 ${name} ?此操作不可恢复。`)) return;
    const path = cwd === "/" ? `/${name}` : `${cwd}/${name}`;
    rbStatus.textContent = "删除中…";
    try {
      const out = (await invoke("rsh_exec", {
        args: rshArgs(),
        cmd: `rm -f '${path}' 2>&1`,
      }) || "").trim();
      if (out) { rbStatus.textContent = `删除失败: ${out}`; return; }
      rbStatus.textContent = `已删除 ${name}`;
      browse(cwd);
    } catch (e) {
      rbStatus.textContent = String(e);
    }
  }

  async function editPerms(name) {
    const path = cwd === "/" ? `/${name}` : `${cwd}/${name}`;
    rbStatus.textContent = "读取权限…";
    let permStr = "";
    try {
      const lsOut = await invoke("rsh_exec", { args: rshArgs(), cmd: `ls -l '${path}' 2>&1` });
      const m = /(?:^|\s)([-dl][rwxstST-]{9})/.exec(lsOut || "");
      if (!m) { rbStatus.textContent = "无法解析权限(设备输出格式不同)"; return; }
      permStr = m[1];
    } catch (e) {
      rbStatus.textContent = String(e);
      return;
    }
    rbStatus.textContent = "";

    // lightweight dialog: 3x3 checkbox grid (u/g/o x r/w/x) + octal readout
    const ov = document.createElement("div");
    ov.className = "perm-dialog";
    const tri = (t) =>
      (t[0] === "r" ? 4 : 0) + (t[1] === "w" ? 2 : 0) + (t[2] === "x" ? 1 : 0);
    // permStr still carries the file-type char ("-rw-r--r--"): drop it so the
    // u/g/o triads align, then pre-check the grid from the real permissions.
    const perms = permStr.slice(1);
    const cur = [tri(perms.slice(0, 3)), tri(perms.slice(3, 6)), tri(perms.slice(6, 9))];
    ov.innerHTML = `
      <div class="perm-box">
        <p class="sc-title">${name}</p>
        <p class="muted" style="margin:4px 0 8px">当前权限: ${permStr}</p>
        <table class="perm-grid">
          <tr><th></th><th>r</th><th>w</th><th>x</th></tr>
          <tr><th>u</th><td><input type="checkbox" data-p="0" data-b="4"${cur[0] & 4 ? " checked" : ""}/></td><td><input type="checkbox" data-p="0" data-b="2"${cur[0] & 2 ? " checked" : ""}/></td><td><input type="checkbox" data-p="0" data-b="1"${cur[0] & 1 ? " checked" : ""}/></td></tr>
          <tr><th>g</th><td><input type="checkbox" data-p="1" data-b="4"${cur[1] & 4 ? " checked" : ""}/></td><td><input type="checkbox" data-p="1" data-b="2"${cur[1] & 2 ? " checked" : ""}/></td><td><input type="checkbox" data-p="1" data-b="1"${cur[1] & 1 ? " checked" : ""}/></td></tr>
          <tr><th>o</th><td><input type="checkbox" data-p="2" data-b="4"${cur[2] & 4 ? " checked" : ""}/></td><td><input type="checkbox" data-p="2" data-b="2"${cur[2] & 2 ? " checked" : ""}/></td><td><input type="checkbox" data-p="2" data-b="1"${cur[2] & 1 ? " checked" : ""}/></td></tr>
        </table>
        <p class="muted" style="margin:8px 0">八进制: <b id="perm-oct">${cur[0]}${cur[1]}${cur[2]}</b></p>
        <div class="row" style="margin-top:6px">
          <button id="perm-ok" style="flex:1">应用</button>
          <button id="perm-cancel" style="flex:1">取消</button>
        </div>
      </div>
    `;
    document.body.appendChild(ov);
    const octEl = ov.querySelector("#perm-oct");
    const readOct = () => {
      const v = [0, 0, 0];
      ov.querySelectorAll("input:checked").forEach((c) => {
        v[parseInt(c.dataset.p, 10)] += parseInt(c.dataset.b, 10);
      });
      octEl.textContent = v.join("");
      return v.join("");
    };
    ov.querySelectorAll("input").forEach((c) => c.addEventListener("change", readOct));
    ov.querySelector("#perm-cancel").addEventListener("click", () => ov.remove());
    ov.querySelector("#perm-ok").addEventListener("click", async () => {
      const oct = readOct();
      ov.remove();
      rbStatus.textContent = "应用权限…";
      try {
        const out = (await invoke("rsh_exec", {
          args: rshArgs(),
          cmd: `chmod ${oct} '${path}' 2>&1`,
        }) || "").trim();
        if (out) { rbStatus.textContent = `chmod 失败: ${out}`; return; }
        rbStatus.textContent = `权限已更新为 ${oct}`;
        browse(cwd);
      } catch (e) {
        rbStatus.textContent = String(e);
      }
    });
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
      // relay is always tftptmp next to the exe
      srvDir = await defaultTftpDir();
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
  const transfersBtn = p.querySelector("#rb-transfers");

  /// Track in-flight transfers: a set of dir+file keys not yet finalized.
  /// The transfers button pulses while the set is non-empty.
  const activeTransfers = new Set();
  function transferBusy(key, busy) {
    if (busy) activeTransfers.add(key);
    else activeTransfers.delete(key);
    transfersBtn.classList.toggle("xfer-active", activeTransfers.size > 0);
  }

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
    const key = `${dir}:${file}`;
    const el = transferRow(dir, file);
    el.dataset.key = key;
    el.textContent = `[${tag}] ${file}${detail ? " " + detail : ""}`;
    el.style.color = cls === "fail" ? "#e06c75" : cls === "ok" ? "#98c379" : "";
    // busy while a percentage/first-contact tag shows; done on 成功/失败
    transferBusy(key, !["成功", "失败"].includes(tag) && !tag.startsWith("提示"));
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
  // Transfers toggle: same behavior, for the transfer log block.
  p.querySelector("#rb-transfers").addEventListener("click", () => {
    const blk = p.querySelector("#transfers-block");
    blk.style.display = blk.style.display === "none" ? "" : "none";
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
      <div class="row">
        <input id="cf-upfile" placeholder="文件完整路径,如 C:\\tftp\\fw.bin" />
        <button id="cf-upbrowse" class="rb-dl" title="选择文件" style="padding:6px 8px;line-height:0"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.5 2h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
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
    // folder icon: pick a file and fill the path input
    cfBody.querySelector("#cf-upbrowse").addEventListener("click", async () => {
      const picked = await invoke("pick_files").catch(() => []);
      if (picked && picked.length) cfBody.querySelector("#cf-upfile").value = picked[0];
    });
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
      // copy file into the relay dir so the device can pull it
      const d = await defaultTftpDir();
      if (d) {
        try { await invoke("tftp_copy_in", { dir: d, src: path, name }); refreshFiles(); } catch (_) {}
      }
      saveTftpSettings({ cmd_upload_ip: ip });
    });
    cfBody.querySelector("#cf-upsend").addEventListener("click", () => {
      const { cmd, path, ip } = genCmd();
      if (!path) { st.textContent = "先填文件路径"; return; }
      saveTftpSettings({ cmd_upload_ip: ip });
      sendTftpToActive(cmd, st, { localFile: path });
    });
  });

  p.querySelector("#cf-down").addEventListener("click", () => {
    cfBody.innerHTML = `
      <p class="muted">设备将用 tftp -p 把文件推到 PC 服务目录,完成后自动转到保存路径</p>
      <div class="row"><input id="cf-dnname" value="${settings.cmd_download_name ?? ""}" placeholder="远端文件名" /></div>
      <div class="row">
        <input id="cf-dnsave" placeholder="本地保存路径,如 C:\\Users\\me\\Desktop\\fw.bin" />
        <button id="cf-dnbrowse" class="rb-dl" title="选择保存位置" style="padding:6px 8px;line-height:0"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 3.5a1 1 0 0 1 1-1h3l1.5 2h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
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
    // save-path picker: ask where to put the downloaded file
    cfBody.querySelector("#cf-dnbrowse").addEventListener("click", async () => {
      const name = cfBody.querySelector("#cf-dnname").value.trim() || "download.bin";
      const pth = await invoke("pick_save_path", { defaultName: name }).catch(() => "");
      if (pth) cfBody.querySelector("#cf-dnsave").value = pth;
    });
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
    cfBody.querySelector("#cf-dnsend").addEventListener("click", async () => {
      const { cmd, name, ip } = genCmd();
      if (!name) { st.textContent = "先填文件名"; return; }
      const savePath = cfBody.querySelector("#cf-dnsave").value.trim();
      saveTftpSettings({ cmd_download_ip: ip, cmd_download_name: name });
      // Send via the active serial window; after the push lands in the server
      // dir, wait for the file then export it to savePath. No tftp_dir set?
      // Derive the server dir from the chosen save path's folder.
      const srv = await (async () => {
        // relay is always tftptmp next to the exe
        const dir = await defaultTftpDir();
        if (!dir) { st.textContent = "无法确定服务目录"; return null; }
        const running = await invoke("tftp_server_status").catch(() => false);
        if (!running) {
          st.textContent = "启动 TFTP 服务端…";
          try {
            await invoke("tftp_server_start", { args: { dir, port: 69 }, onEvent: channel(() => {}) });
          } catch (e) { st.textContent = `服务端启动失败: ${e}`; return null; }
        }
        return { dir };
      })();
      if (!srv) return;
      const active = window.__devtermActiveSession?.();
      if (active?.kind !== "serial") { st.textContent = "当前页面不是串口"; return; }
      if (savePath) {
        // poll the server dir for the pushed file, then move it to savePath
        st.textContent = "已发送,等待设备推送…";
        const deadline = Date.now() + 60000;
        const poll = setInterval(async () => {
          if (Date.now() > deadline) { clearInterval(poll); st.textContent = "等待超时:设备未推送文件"; return; }
          try {
            const files = await invoke("tftp_list_dir", { dir: srv.dir });
            if (files.some((f) => f.name === name)) {
              clearInterval(poll);
              try {
                await invoke("tftp_export", { srvDir: srv.dir, name, savePath });
                st.textContent = `下载完成: ${savePath}`;
              } catch (e) { st.textContent = `转存失败: ${e}`; }
              refreshFiles();
            }
          } catch (_) {}
        }, 1000);
      } else {
        st.textContent = "已发送到当前串口窗口(文件落在服务目录)";
      }
      window.__devtermSendToSession?.(active.id, cmd + "\r");
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

/// Send a tftp command straight to the ACTIVE window, but only when it is a
/// serial session (telnet windows get a refusal - the command is serial-first).
/// Ensures the TFTP server is running first (relay = tftptmp), copies
/// localFile into the relay dir when provided.
async function sendTftpToActive(cmd, statusEl, { localFile } = {}) {
  const active = window.__devtermActiveSession?.();
  if (active?.kind !== "serial") {
    statusEl.textContent = "当前页面不是串口";
    return false;
  }
  // relay is always tftptmp next to the exe
  const dir = await defaultTftpDir();
  if (!dir) {
    statusEl.textContent = "无法确定服务目录";
    return false;
  }
  if (localFile) {
    const name = localFile.split(/[\\/]/).pop();
    try { await invoke("tftp_copy_in", { src: localFile, name }); } catch (_) {}
  }
  const running = await invoke("tftp_server_status").catch(() => false);
  if (!running) {
    statusEl.textContent = "启动 TFTP 服务端…";
    try {
      const r = await invoke("tftp_server_start", { args: { dir, port: 69 }, onEvent: channel(() => {}) });
      const m = /随机端口 (\d+)/.exec(r || "");
      if (m) {
        // server fell back to a random port: rebuild the command with it
        const withPort = cmd.includes(" ") ? `${cmd} ${m[1]}` : cmd;
        statusEl.textContent = "已发送到当前串口窗口";
        window.__devtermSendToSession?.(active.id, withPort + "\r");
        return true;
      }
    } catch (e) {
      statusEl.textContent = `服务端启动失败: ${e}`;
      return false;
    }
  }
  statusEl.textContent = "已发送到当前串口窗口";
  window.__devtermSendToSession?.(active.id, cmd + "\r");
  return true;
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

  // Enter on a disconnected tab opens a FRESH connection in a new tab (the
  // old tab stays as history). Failure shows in the connect panel like usual.
  onReconnect((s) => {
    if (s.kind === "telnet") openTelnet(s.reconnectable.host, s.reconnectable.port);
    else openSerial(s.reconnectable.port, s.reconnectable.baud_rate, s.reconnectable.label);
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

  p.innerHTML = `
    <h3>快捷命令</h3>
    <p class="muted" id="qc-status"></p>
    <div class="settings-card">
      <div class="sc-head">
        <span class="sc-title">命令</span>
      </div>
      <div id="qc-list"></div>
      <div class="row" style="margin-top:8px">
        <button id="qc-add-cmd" style="flex:1">+ 添加命令</button>
        <button id="qc-add-folder" style="flex:1">+ 添加文件夹</button>
      </div>
    </div>
  `;
  const list = p.querySelector("#qc-list");
  const status = p.querySelector("#qc-status");

  const save = () => invoke("cmds_save", { cmds }).catch((e) => { status.textContent = String(e); });

  /// Render grouped commands: folder headers + command rows with edit/delete.
  /// Entries with `folder: true` are EMPTY folders (marker entries).
  function render() {
    const folders = cmds.filter((c) => c.folder).map((c) => c.group);
    const realCmds = cmds.filter((c) => !c.folder);
    const groups = new Map();
    const order = [];
    // declared (possibly still empty) folders come first
    for (const f of folders) {
      if (!groups.has(f)) {
        groups.set(f, []);
        order.push(f);
      }
    }
    for (const c of realCmds) {
      const g = c.group || "未分组";
      if (!groups.has(g)) {
        groups.set(g, []);
        order.push(g);
      }
      groups.get(g).push(c);
    }
    list.innerHTML = order
      .map((g) => {
        const items = groups.get(g) ?? [];
        return `
        <div class="list-item qc-folder" data-group="${encodeURIComponent(g)}" style="cursor:default"><span class="qc-caret" style="cursor:pointer;flex:none;line-height:0"><svg viewBox="0 0 16 16" width="12" height="12" style="transition:transform .15s"><path d="M5 6l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span> <span style="flex:1"><b>📁 ${g}</b></span> <span class="qc-folder-del muted" title="删除文件夹" style="cursor:pointer">✕</span> <button class="rb-dl qc-folder-edit" title="重命名文件夹"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M11.5 2.5a1.4 1.4 0 0 1 2 2L6 12l-3 1 1-3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
        <div class="qc-folder-body" data-folder="${encodeURIComponent(g)}">
        ${items
          .map(
            (c) =>
              `<div class="list-item qc-item" data-name="${encodeURIComponent(c.name)}" data-group="${encodeURIComponent(g)}"><div style="flex:1;overflow:hidden;text-overflow:ellipsis"><b>${c.name}</b><br><span class="muted" style="font-size:11px">${c.cmd.replace(/</g, "&lt;")}</span></div> <span class="qc-del muted" title="删除命令" style="cursor:pointer">✕</span> <button class="rb-dl qc-edit" title="编辑命令"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M11.5 2.5a1.4 1.4 0 0 1 2 2L6 12l-3 1 1-3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>`
          )
          .join("")}
        ${!items.length ? `<p class="muted" style="margin:4px 0 2px;padding-left:18px;font-size:12px">(空文件夹)</p>` : ""}
        </div>`;
      })
      .join("");

    // Folder header click (not on ✕/pencil): toggle its command list. The
    // caret chevron rotates -90° when collapsed.
    list.querySelectorAll(".qc-folder").forEach((el) => {
      el.addEventListener("click", (ev) => {
        if (ev.target.closest(".qc-folder-del") || ev.target.closest(".qc-folder-edit")) return;
        const body = el.nextElementSibling; // .qc-folder-body
        const caretSvg = el.querySelector(".qc-caret svg");
        const show = body.style.display !== "none";
        body.style.display = show ? "none" : "";
        caretSvg.style.transform = show ? "rotate(-90deg)" : "";
      });
    });

    // Click a command: send to the ACTIVE session; quiet on success.
    list.querySelectorAll(".qc-item").forEach((el) => {
      el.addEventListener("click", async (ev) => {
        if (ev.target.closest(".qc-edit") || ev.target.closest(".qc-del")) return;
        const name = decodeURIComponent(el.dataset.name);
        const group = decodeURIComponent(el.dataset.group || "");
        const c = cmds.find((x) => x.name === name && (x.group || "未分组") === group);
        if (!c) return;
        const active = window.__devtermActiveSession?.();
        if (active?.id == null) {
          status.textContent = "当前未打开任何窗口,无法发送";
          return;
        }
        const ok = await window.__devtermSendToSessionPromise?.(active.id, c.cmd + "\r");
        status.textContent = ok ? "" : "发送失败: 会话已断开";
      });
    });
    // Edit command: dialog with name/cmd/group fields.
    list.querySelectorAll(".qc-edit").forEach((el) => {
      el.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const item = ev.target.closest(".qc-item");
        const name = decodeURIComponent(item.dataset.name);
        const group = decodeURIComponent(item.dataset.group || "");
        const idx = cmds.findIndex((x) => x.name === name && (x.group || "未分组") === group);
        if (idx < 0) return;
        const folders = [...new Set(cmds.map((x) => x.group).filter(Boolean))];
        cmdDialog(cmds[idx], async (updated) => {
          cmds[idx] = updated;
          await save();
          render();
        }, folders);
      });
    });
    // Delete command.
    list.querySelectorAll(".qc-del").forEach((el) => {
      el.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const item = ev.target.closest(".qc-item");
        const name = decodeURIComponent(item.dataset.name);
        const group = decodeURIComponent(item.dataset.group || "");
        const idx = cmds.findIndex((x) => x.name === name && (x.group || "未分组") === group);
        if (idx < 0) return;
        cmds.splice(idx, 1);
        await save();
        render();
      });
    });
    // Rename folder: updates marker + every command inside it.
    list.querySelectorAll(".qc-folder-edit").forEach((el) => {
      el.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const folder = decodeURIComponent(ev.target.closest(".qc-folder").dataset.group);
        folderDialog(folder, async (newName) => {
          if (!newName || newName === folder) return;
          for (const c of cmds) {
            if (c.folder && c.group === folder) c.group = newName;
            else if ((c.group || "未分组") === folder) c.group = newName;
          }
          await save();
          render();
        });
      });
    });
    // Delete folder: removes the marker entry and every command inside it.
    list.querySelectorAll(".qc-folder-del").forEach((el) => {
      el.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const folder = decodeURIComponent(ev.target.closest(".qc-folder").dataset.group);
        const n = cmds.filter((c) => !c.folder && (c.group || "未分组") === folder).length;
        if (n > 0 && !confirm(`文件夹"${folder}"里有 ${n} 个命令,一并删除?`)) return;
        for (let i = cmds.length - 1; i >= 0; i--) {
          const c = cmds[i];
          if (c.folder && c.group === folder) cmds.splice(i, 1);
          else if (!c.folder && (c.group || "未分组") === folder) cmds.splice(i, 1);
        }
        await save();
        render();
      });
    });
  }

  /// Command add/edit dialog (perm-dialog family: labels + dark inputs).
  /// `folders` feeds a custom dropdown (datalist is unreliable in WebView2:
  /// it only opens on typing/focus and its arrow is invisible in dark themes).
  function cmdDialog(initial, onOk, folders = []) {
    const ov = document.createElement("div");
    ov.className = "perm-dialog";
    ov.innerHTML = `
      <div class="perm-box editor-box" style="width:min(420px,90vw)">
        <p class="sc-title">${initial ? "编辑命令" : "添加命令"}</p>
        <div class="row"><span class="sc-label" style="width:70px">名称</span><input id="cmd-name" value="${escAttr(initial?.name || "")}" placeholder="如 查看系统信息" /></div>
        <div class="row"><span class="sc-label" style="width:70px">命令</span><input id="cmd-body" value="${escAttr(initial?.cmd || "")}" placeholder="如 uname -a" /></div>
        <div class="row"><span class="sc-label" style="width:70px">文件夹</span>
          <div style="flex:1;position:relative">
            <input id="cmd-group" value="${escAttr(initial?.group || "")}" placeholder="留空=未分组" style="padding-right:26px" />
            <button id="cmd-group-btn" class="rb-dl" title="选择文件夹" style="position:absolute;right:6px;top:6px;bottom:6px;padding:2px"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M3.5 5.5 8 10l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            <div id="cmd-group-list" style="display:none;position:absolute;left:0;right:0;top:calc(100% + 2px);background:var(--side);border:1px solid var(--border);border-radius:4px;max-height:180px;overflow-y:auto;z-index:10"></div>
          </div>
        </div>
        <div class="row" style="margin-top:8px">
          <button id="cmd-ok" style="flex:1">确定</button>
          <button id="cmd-cancel" class="ed-cancel" style="flex:1">取消</button>
        </div>
      </div>
    `;
    document.body.appendChild(ov);
    // custom folder dropdown
    const groupInput = ov.querySelector("#cmd-group");
    const groupList = ov.querySelector("#cmd-group-list");
    ov.querySelector("#cmd-group-btn").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (groupList.style.display !== "none") {
        groupList.style.display = "none";
        return;
      }
      const items = folders.length
        ? folders.map((f) => `<div class="qc-opt" style="padding:10px 10px" data-v="${escAttr(f)}">${f}</div>`).join("")
        : `<div class="muted" style="padding:10px;font-size:12px">(暂无文件夹,直接输入名称)</div>`;
      groupList.innerHTML = items;
      groupList.style.display = "block";
    });
    groupList.addEventListener("click", (e) => {
      const opt = e.target.closest(".qc-opt");
      if (!opt) return;
      groupInput.value = opt.dataset.v;
      groupList.style.display = "none";
    });
    // click elsewhere closes the dropdown
    ov.addEventListener("click", (e) => {
      if (!e.target.closest("#cmd-group-btn") && !e.target.closest("#cmd-group-list")) {
        groupList.style.display = "none";
      }
    });
    const nameInput = ov.querySelector("#cmd-name");
    nameInput.focus();
    const close = () => ov.remove();
    ov.querySelector("#cmd-cancel").addEventListener("click", close);
    ov.querySelectorAll("input").forEach((inp) =>
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") ov.querySelector("#cmd-ok").click();
        if (e.key === "Escape") close();
      })
    );
    ov.querySelector("#cmd-ok").addEventListener("click", () => {
      const name = ov.querySelector("#cmd-name").value.trim();
      const cmd = ov.querySelector("#cmd-body").value.trim();
      const group = ov.querySelector("#cmd-group").value.trim();
      if (!name || !cmd) return;
      close();
      onOk({ name, cmd, group });
    });
  }

  /// Folder name dialog (same perm-box style). `initial` prefills for rename.
  function folderDialog(initial, onOk) {
    const ov = document.createElement("div");
    ov.className = "perm-dialog";
    ov.innerHTML = `
      <div class="perm-box" style="width:min(380px,90vw)">
        <p class="sc-title">${initial ? "重命名文件夹" : "添加文件夹"}</p>
        <div class="row"><span class="sc-label" style="width:70px">名称</span><input id="folder-name" value="${escAttr(initial || "")}" placeholder="文件夹名称" /></div>
        <div class="row" style="margin-top:8px">
          <button id="folder-ok" style="flex:1">确定</button>
          <button id="folder-cancel" class="ed-cancel" style="flex:1">取消</button>
        </div>
      </div>
    `;
    document.body.appendChild(ov);
    const input = ov.querySelector("#folder-name");
    input.focus();
    input.select();
    const close = () => ov.remove();
    ov.querySelector("#folder-cancel").addEventListener("click", close);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") ov.querySelector("#folder-ok").click();
      if (e.key === "Escape") close();
    });
    ov.querySelector("#folder-ok").addEventListener("click", () => {
      const name = input.value.trim();
      if (!name) return;
      close();
      onOk(name);
    });
  }

  // Add command: empty dialog, folder datalist from existing groups.
  p.querySelector("#qc-add-cmd").addEventListener("click", () => {
    const folders = [...new Set(cmds.map((x) => x.group).filter(Boolean))];
    cmdDialog(null, (c) => {
      cmds.push(c);
      save().then(render);
    }, folders);
  });

  // Add folder: a marker entry (folder: true) renders as an empty folder.
  p.querySelector("#qc-add-folder").addEventListener("click", () => {
    folderDialog(null, async (name) => {
      cmds.push({ name: "", cmd: "", group: name, folder: true });
      await save();
      render();
    });
  });

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
