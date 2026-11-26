// Thin wrapper over the Tauri IPC bridge injected by the Rust backend.
export function invoke(cmd, args = {}) {
  return window.__TAURI_INTERNALS__.invoke(cmd, args);
}

// Minimal stand-in for tauri api's Channel: Rust's tauri::ipc::Channel<T>
// deserializes any value whose toJSON returns "__CHANNEL__:<callback-id>".
// Rust delivers each message via runCallback(id, {message, index}); the
// official Channel unwraps .message, so we do the same. Our session events
// are JSON strings, parsed here once.
export function channel(onMessage) {
  const id = window.__TAURI_INTERNALS__.transformCallback((envelope) => {
    const m = envelope && typeof envelope === "object" && "message" in envelope ? envelope.message : envelope;
    onMessage(typeof m === "string" ? JSON.parse(m) : m);
  });
  return { toJSON: () => `__CHANNEL__:${id}` };
}
