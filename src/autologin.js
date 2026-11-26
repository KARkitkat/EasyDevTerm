// Auto-login: watches the session data stream for login prompts and injects
// credentials. Prompt-triggered (not blind send on connect) because opening
// a serial port asserts DTR/RTS which resets many boards - a blind send would
// be swallowed by U-Boot before the shell ever prints "login:".
// Pure logic, no DOM/IPC: the caller injects a send() callback.

import { invoke } from "./ipc.js";

let cfg = {
  auto_login_enabled: false,
  auto_login_mode: "global",
  auto_login_user: "",
  auto_login_pass: "",
  auto_login_rules: [],
};

export async function load() {
  const s = await invoke("settings_get").catch(() => ({}));
  cfg = s;
}
load();

// Re-read settings after the settings panel saves.
export async function reload() {
  await load();
}

// sid -> { stage, buf, dec, user, pass, send, timer }
const active = new Map();

const LOGIN_RE = /(?:login|username)\s*:\s*$/i;
const PASSWORD_RE = /password\s*:\s*$/i;
const TAIL = 256; // keep only the stream tail; prompts live at the end
const PASSWORD_TIMEOUT = 10000; // no Password prompt after login -> give up

export function begin(sid, send, user, pass) {
  if (!cfg.auto_login_enabled || !user || !pass) return;
  drop(sid);
  active.set(sid, {
    stage: 0,
    buf: "",
    dec: new TextDecoder(),
    user,
    pass,
    send,
    timer: null,
  });
}

/// Pick credentials for a device key ("COM4" / "192.168.10.123:2356"):
/// per_device mode matches rules exactly and falls back to the global pair.
export function credentialsFor(devKey) {
  if (!cfg.auto_login_enabled) return null;
  if (cfg.auto_login_mode === "per_device") {
    const rule = (cfg.auto_login_rules ?? []).find(
      (r) => (r.target || "").trim() === devKey
    );
    if (rule) return { user: rule.user, pass: rule.pass };
  }
  return { user: cfg.auto_login_user, pass: cfg.auto_login_pass };
}

/// Feed raw session bytes (before xterm); returns true when something was sent.
export function feed(sid, bytes) {
  const st = active.get(sid);
  if (!st || st.stage >= 2) return false;
  st.buf += st.dec.decode(bytes, { stream: true });
  if (st.buf.length > TAIL) st.buf = st.buf.slice(-TAIL);

  if (st.stage === 0 && LOGIN_RE.test(st.buf)) {
    st.stage = 1;
    st.buf = "";
    st.send(sid, st.user + "\r");
    // Devices without a Password prompt (already-authenticated shells) must
    // not wedge in stage 1 forever.
    st.timer = setTimeout(() => drop(sid), PASSWORD_TIMEOUT);
    return true;
  }
  if (st.stage === 1 && PASSWORD_RE.test(st.buf)) {
    clearTimeout(st.timer);
    st.stage = 2;
    st.buf = "";
    st.send(sid, st.pass + "\r");
    return true;
  }
  return false;
}

export function drop(sid) {
  const st = active.get(sid);
  if (st?.timer) clearTimeout(st.timer);
  active.delete(sid);
}
