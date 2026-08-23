// The shells, and the bytes they print.
//
// `portable-pty` is WezTerm's: ConPTY on Windows, `openpty` elsewhere, one API
// over both. It is the closest thing Rust has to node-pty and the better tested
// of the two on Windows, which is the platform this app is used on.
//
// One reader thread per shell rather than an async runtime. A pty read blocks
// until there are bytes and there are never more than a few dozen of them; a
// thread each costs a stack and nothing else, and the alternative is dragging
// tokio in to wait on file descriptors that are not pollable on Windows anyway.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/// What the renderer is told when bytes arrive.
#[derive(Clone, Serialize)]
struct Output {
    #[serde(rename = "paneId")]
    pane_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    #[serde(rename = "paneId")]
    pane_id: String,
    #[serde(rename = "exitCode")]
    exit_code: i32,
}

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    /// Set when the shell has gone, so a write to a dead pane is a no-op rather
    /// than an error somebody has to handle three layers up.
    alive: Arc<Mutex<bool>>,
}

pub struct Manager {
    app: AppHandle,
    sessions: Mutex<HashMap<String, Session>>,
}

impl Manager {
    pub fn new(app: AppHandle) -> Self {
        Self { app, sessions: Mutex::new(HashMap::new()) }
    }

    /// Starts a shell for a pane, or reports the one already there.
    ///
    /// Re-spawning a live pane is not an error and must not replace anything:
    /// it is what a renderer that has just re-mounted a tab does, and the shell
    /// it is asking about is the one already running.
    pub fn spawn(&self, request: Value) -> Result<Value, String> {
        let pane_id = request["paneId"].as_str().unwrap_or_default().to_string();
        if pane_id.is_empty() {
            return Err("pty:spawn: no paneId".into());
        }
        if self.sessions.lock().unwrap().contains_key(&pane_id) {
            return Ok(json!({ "ok": true }));
        }

        let cols = request["cols"].as_u64().unwrap_or(80) as u16;
        let rows = request["rows"].as_u64().unwrap_or(24) as u16;
        let pair = NativePtySystem::default()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;

        let mut command = CommandBuilder::new(shell_for(&request));
        for argument in request["args"].as_array().into_iter().flatten() {
            if let Some(text) = argument.as_str() {
                command.arg(text);
            }
        }
        if let Some(cwd) = request["cwd"].as_str() {
            if !cwd.is_empty() {
                command.cwd(cwd);
            }
        }
        // The pane's own id, so anything the shell starts can find its way back
        // — the same contract `iaw notify` relies on under Electron.
        command.env("IAW_PANE_ID", &pane_id);

        let mut child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
        drop(pair.slave);

        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let alive = Arc::new(Mutex::new(true));

        let app = self.app.clone();
        let id = pane_id.clone();
        let flag = alive.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        // Lossy on purpose: a pty carries bytes, and a multi-byte
                        // character split across two reads must not take the pane
                        // down. The renderer's terminal reassembles what it can.
                        let text = String::from_utf8_lossy(&buffer[..n]).to_string();
                        let _ = app.emit("pty:data", Output { pane_id: id.clone(), data: text });
                    }
                }
            }
            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            *flag.lock().unwrap() = false;
            let _ = app.emit("pty:exit", Exit { pane_id: id.clone(), exit_code: code });
        });

        self.sessions
            .lock()
            .unwrap()
            .insert(pane_id, Session { writer, master: pair.master, alive });
        Ok(json!({ "ok": true }))
    }

    pub fn write(&self, pane_id: &str, data: &str) {
        if let Some(session) = self.sessions.lock().unwrap().get_mut(pane_id) {
            let _ = session.writer.write_all(data.as_bytes());
            let _ = session.writer.flush();
        }
    }

    pub fn resize(&self, pane_id: &str, cols: u16, rows: u16) {
        if let Some(session) = self.sessions.lock().unwrap().get(pane_id) {
            let _ = session
                .master
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }

    pub fn kill(&self, pane_id: &str) {
        // Dropping the master closes the pty, which ends the shell and unblocks
        // the reader thread; the thread then reports the exit on its way out.
        self.sessions.lock().unwrap().remove(pane_id);
    }

    /// Whether a pane still has a shell. The renderer asks before closing one.
    pub fn is_busy(&self, pane_id: &str) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .get(pane_id)
            .map(|s| *s.alive.lock().unwrap())
            .unwrap_or(false)
    }
}

/// Which program to run, with the platform's own shell as the answer to silence.
fn shell_for(request: &Value) -> String {
    if let Some(file) = request["file"].as_str() {
        if !file.is_empty() {
            return file.to_string();
        }
    }
    match request["shell"].as_str().unwrap_or("") {
        "pwsh" => "pwsh.exe".into(),
        "cmd" => "cmd.exe".into(),
        "bash" => "bash".into(),
        "zsh" => "zsh".into(),
        "fish" => "fish".into(),
        _ => default_shell(),
    }
}

#[cfg(windows)]
fn default_shell() -> String {
    "powershell.exe".into()
}

#[cfg(not(windows))]
fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
}
