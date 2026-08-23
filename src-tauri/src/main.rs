// ia_workspaces, hosted by Tauri instead of Electron.
//
// The renderer is the same 32,000 lines either way: it talks to a `Backend`
// object and has never imported Electron. What differs is who answers, and this
// is the other answer — the same 119 channels `src/shared/ipc.ts` names, over
// one Tauri command instead of one `ipcMain.handle` per channel.
//
// **Why one command and not 108.** Tauri wants a Rust function per command and
// a matching name on the JavaScript side. That is fine for an app with a dozen;
// with a hundred and eight it is a hundred and eight places to keep two names
// in step, and the renderer already addresses everything by a channel string.
// So the string comes through as an argument and `ipc::dispatch` matches on it,
// which also means an unimplemented channel is one arm away rather than a
// missing symbol — and `tools/ipcManifest.mjs` can count the arms.
//
// **Why this exists at all.** Electron's main process measures 586 MB on the
// machine this was written on, against a renderer's 158 MB. Most of that is a
// Node runtime holding scrollback rings and a few maps. The same job in Rust is
// tens of megabytes, and the renderer keeps its Chromium either way.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;
mod ipc;
mod pty;
mod state;

use std::sync::Arc;

// `manage` and `handle` come from this trait, not from `App` itself.
use tauri::Manager;

/// Everything the host owns, handed to every channel that needs it.
pub struct Host {
    pub ptys: pty::Manager,
    pub state: state::Store,
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = state::data_dir();
            std::fs::create_dir_all(&dir).ok();
            let host = Arc::new(Host {
                ptys: pty::Manager::new(app.handle().clone()),
                state: state::Store::new(dir),
            });
            app.manage(host);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ipc::ipc])
        .run(tauri::generate_context!())
        .expect("ia_workspaces failed to start");
}
