use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

/// A transport-agnostic session: bytes in, bytes out, plus control ops.
/// Serial/telnet/ssh all implement the same shape (M2 adds the latter two).
/// The channel carries JSON-encoded session events as strings.
pub type SessionTx = Channel<String>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Serial,
    Telnet,
    Ssh,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Connecting,
    Open,
    Closed,
    Error,
}

impl PartialEq for SessionState {
    fn eq(&self, other: &Self) -> bool {
        matches!(
            (self, other),
            (SessionState::Closed, SessionState::Closed)
                | (SessionState::Open, SessionState::Open)
                | (SessionState::Error, SessionState::Error)
                | (SessionState::Connecting, SessionState::Connecting)
        )
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: u32,
    pub kind: SessionKind,
    pub label: String,
    pub state: SessionState,
}

/// Handle used by the spawn task to report state transitions and to be told to stop.
pub struct SessionHandle {
    pub info: SessionInfo,
    pub close_tx: tokio::sync::oneshot::Sender<()>,
}

pub struct SessionManager {
    next_id: Mutex<u32>,
    sessions: Mutex<HashMap<u32, SessionHandle>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            next_id: Mutex::new(1),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn alloc_id(&self) -> u32 {
        let mut n = self.next_id.lock().unwrap();
        let id = *n;
        *n += 1;
        id
    }

    pub fn insert(&self, handle: SessionHandle) {
        self.sessions.lock().unwrap().insert(handle.info.id, handle);
    }

    pub fn set_state(&self, id: u32, state: SessionState) {
        if let Some(h) = self.sessions.lock().unwrap().get_mut(&id) {
            h.info.state = state;
        }
    }

    pub fn remove(&self, id: u32) {
        self.sessions.lock().unwrap().remove(&id);
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let mut v: Vec<SessionInfo> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .map(|h| h.info.clone())
            .collect();
        v.sort_by_key(|s| s.id);
        v
    }

    /// Signal the session task to stop. Returns false if unknown or already closing.
    pub fn close(&self, id: u32) -> bool {
        let mut map = self.sessions.lock().unwrap();
        if let Some(h) = map.remove(&id) {
            let _ = h.close_tx.send(());
            true
        } else {
            false
        }
    }
}

/// Event pushed to the frontend channel for a session.
#[derive(Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum SessionEvent<'a> {
    Data { bytes: &'a [u8] },
    State { state: &'a SessionState },
}

impl SessionEvent<'_> {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap()
    }
}

/// Events that arrive before the manager knows the id can't be routed through
/// state updates alone; sessions send their own state events on the same channel.
pub fn spawn_session_task<F>(
    mgr: &SessionManager,
    kind: SessionKind,
    label: String,
    tx: SessionTx,
    task: F,
) -> u32
where
    F: FnOnce(u32, SessionTx, tokio::sync::oneshot::Receiver<()>) + Send + 'static,
{
    let id = mgr.alloc_id();
    let (close_tx, close_rx) = tokio::sync::oneshot::channel();
    mgr.insert(SessionHandle {
        info: SessionInfo {
            id,
            kind,
            label,
            state: SessionState::Connecting,
        },
        close_tx,
    });
    tauri::async_runtime::spawn(async move {
        tokio::task::spawn_blocking(move || task(id, tx, close_rx));
    });
    id
}

#[tauri::command]
pub fn session_list(mgr: State<'_, SessionManager>) -> Vec<SessionInfo> {
    mgr.list()
}

#[tauri::command]
pub fn session_close(mgr: State<'_, SessionManager>, id: u32) -> bool {
    mgr.close(id)
}
