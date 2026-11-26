// Session tabs + xterm.js lifecycle. One Terminal per session, created lazily
// and kept in a map keyed by session id.

const termArea = document.getElementById("term-area");
const tabbar = document.getElementById("tabbar");
const welcome = document.getElementById("welcome");

export const sessions = new Map(); // id -> {term, fit, wrap, info, ondata}

let activeId = null;

export function getActiveSession() {
  return activeId != null ? sessions.get(activeId) : null;
}

export function sessionKind(id) {
  const s = sessions.get(id);
  return s ? s.kind : "serial";
}

export function onSessionData(cb) {
  sessions._dataCb = cb;
}

export function onSessionClose(cb) {
  sessions._closeCb = cb;
}

// Command assistant hooks: list serial sessions / write into one.
window.__devtermSerialSessions = () =>
  [...sessions.entries()]
    .filter(([, s]) => s.kind === "serial")
    .map(([id, s]) => ({ id, label: s.label }));
// All live sessions (any kind) for quick-command targeting.
window.__devtermAllSessions = () =>
  [...sessions.entries()].map(([id, s]) => ({ id, label: s.label, kind: s.kind }));
window.__devtermSendToSession = (id, text) => {
  const s = sessions.get(id);
  if (s) {
    // Send only over the transport: the device echoes the command back
    // naturally, so a local term.write here would duplicate it on screen
    // ("uname -a" appearing twice) and garble the prompt line.
    sessions._dataCb?.(id, text);
  }
};
// Telnet session targets (label "telnet <ip>[:port]") for the browser.
window.__devtermTelnetIps = () =>
  [...sessions.values()]
    .filter((s) => s.kind === "telnet")
    .map((s) => s.label.replace(/^telnet\s+/, "").trim())
    .filter(Boolean);
// Info about the ACTIVE session (id + kind + ip + port) for panels.
// ip/port are stored on the session at creation (no label parsing).
window.__devtermActiveSession = () => {
  const s = getActiveSession();
  if (!s) return { id: null, kind: null, ip: null, port: null };
  const base = { id: activeId, kind: s.kind, ip: null, port: null };
  if (s.kind === "telnet") {
    let ip = s.ip;
    let port = s.port;
    if (!ip) {
      // legacy session created before meta existed: fall back to label
      const target = s.label.replace(/^telnet\s+/, "").trim();
      const [a, b] = target.split(":");
      ip = a;
      port = b ? parseInt(b, 10) : 23;
    }
    return { ...base, kind: "telnet", ip, port: port ?? 23 };
  }
  return base;
};

// Terminal appearance settings (applied to new terminals; live-updated on
// existing ones by applyTermAppearance). Kept in sync with config by panels.js.
export const termAppearance = { fontSize: 13, fg: "", bg: "" };

/// Apply UI font/zoom vars and terminal appearance everywhere. Called at
/// startup and whenever the settings panel saves appearance fields.
export function applyAppearance(ui) {
  const root = document.documentElement.style;
  if (ui.ui_zoom && ui.ui_zoom !== 100) {
    root.setProperty("zoom", String(ui.ui_zoom / 100));
  } else {
    root.removeProperty("zoom");
  }
  root.setProperty("--ui-font-size", (ui.ui_font_size ? ui.ui_font_size : 13) + "px");
  root.setProperty("--ui-fg", ui.ui_fg || "");
  if (ui.ui_fg) root.setProperty("--fg", ui.ui_fg);

  termAppearance.fontSize = ui.term_font_size || 13;
  termAppearance.fg = ui.term_fg || "";
  termAppearance.bg = ui.term_bg || "";
  for (const s of sessions.values()) {
    applyTermAppearance(s.term);
  }
}

function applyTermAppearance(term) {
  const theme = { background: termAppearance.bg || "#1e1e1e", foreground: termAppearance.fg || "#d4d4d4" };
  term.options.fontSize = termAppearance.fontSize;
  term.options.theme = theme;
}

export function createSessionTab(id, label, kind = "serial", meta = {}) {
  let s = sessions.get(id);
  if (s) {
    activateSession(id);
    return s;
  }

  const wrap = document.createElement("div");
  wrap.className = "term-wrap";
  const termEl = document.createElement("div");
  termEl.className = "term-host";
  wrap.appendChild(termEl);

  const term = new Terminal({ // globalThis.Terminal from xterm.js UMD
    cursorBlink: true,
    fontSize: termAppearance.fontSize,
    fontFamily: "Consolas, 'Courier New', monospace",
    theme: {
      background: termAppearance.bg || "#1e1e1e",
      foreground: termAppearance.fg || "#d4d4d4",
    },
    scrollback: 10000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(termEl);
  term.onData((data) => {
    const cb = sessions._dataCb;
    if (cb && id === activeId) cb(id, data);
  });

  const tab = document.createElement("div");
  tab.className = "tab";
  tab.innerHTML = `<span class="tab-label"></span><span class="tab-close" title="关闭">✕</span>`;
  tab.querySelector(".tab-label").textContent = label;
  tab.addEventListener("click", () => activateSession(id));
  tab.querySelector(".tab-close").addEventListener("click", (e) => {
    e.stopPropagation();
    closeSession(id);
  });

  termArea.insertBefore(wrap, welcome);
  tabbar.appendChild(tab);

  s = { term, fit, wrap, tab, label, kind, ip: meta.ip ?? null, port: meta.port ?? null };
  sessions.set(id, s);
  activateSession(id);
  // Let the observer (and any layout) settle, then fit twice: once now and
  // once after fonts/layout settle - fixes the "half visible" first render.
  termArea.dispatchEvent(new CustomEvent("session-created", { detail: { wrap } }));
  requestAnimationFrame(() => {
    s.fit.fit();
    setTimeout(() => s.fit.fit(), 50);
  });
  return s;
}

export function activateSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  activeId = id;
  for (const [sid, sess] of sessions) {
    sess.wrap.classList.toggle("active", sid === id);
    sess.tab.classList.toggle("active", sid === id);
  }
  welcome.style.display = "none";
  requestAnimationFrame(() => {
    s.fit.fit();
    s.term.focus();
  });
}

export function sessionWrite(id, bytes) {
  const s = sessions.get(id);
  if (s) s.term.write(bytes);
}

export function sessionState(id, state, reason) {
  const s = sessions.get(id);
  if (!s) return;
  if (state === "closed" || state === "error") {
    s.tab.classList.add("disconnected");
    s.term.write(`\r\n\x1b[90m── 会话已断开${reason ? ": " + reason : ""} ──\x1b[0m\r\n`);
  }
}

export async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  const cb = sessions._closeCb;
  if (cb) await cb(id);
  s.term.dispose();
  s.wrap.remove();
  s.tab.remove();
  sessions.delete(id);
  if (activeId === id) {
    activeId = null;
    const rest = [...sessions.keys()];
    if (rest.length) activateSession(rest[rest.length - 1]);
    else welcome.style.display = "";
  }
}

// Refit whenever the terminal area itself resizes (panel open/close, window
// resize, tab bar wrapping). Observing the shared container is more reliable
// than observing individual wraps.
export function refitAll() {
  const s = getActiveSession();
  if (s) {
    try { s.fit.fit(); } catch (_) {}
  }
}
const ro = new ResizeObserver(refitAll);
ro.observe(termArea);
window.addEventListener("resize", refitAll);
