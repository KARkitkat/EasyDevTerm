// EasyDevTerm entry: verify IPC link with the Rust backend on startup.
import { invoke } from "./ipc.js";
import { initPanels } from "./panels.js";
import { applyAppearance } from "./terminals.js";

const check = document.getElementById("ipc-check");
try {
  const msg = await invoke("greet", { name: "EasyDevTerm" });
  check.textContent = `后端 IPC 正常: ${msg}`;
  initPanels();
  // version badge in the sidebar + version in the window title
  const ver = await invoke("app_version").catch(() => "");
  if (ver) {
    document.getElementById("app-ver").textContent = `v${ver}`;
    document.title = `EasyDevTerm v${ver}`;
  }
  // apply saved appearance (zoom / fonts / colors) once settings are readable
  const s = await invoke("settings_get").catch(() => null);
  if (s) applyAppearance(s);
} catch (e) {
  check.textContent = `后端 IPC 异常: ${e}`;
}
