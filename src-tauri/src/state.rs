// The workspace document, and where it lives.
//
// The same file in the same folder as the Electron host uses, deliberately:
// running one host today and the other tomorrow should show the same
// workspaces, and a port that quietly started a second document would be a port
// nobody could switch back from.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

/// Where this host keeps its own document.
///
/// **Its own, deliberately.** A finished port would share the Electron host's
/// `ia_workspaces` folder, so switching hosts showed the same workspaces — and
/// that is exactly wrong while this one is parked and only ever started to be
/// measured. Two apps writing one document is how a document gets truncated,
/// and the document in question is every workspace somebody has.
///
/// So: `ia_workspaces-tauri`. Starting this host shows an empty app, which is
/// the correct amount of damage for a thing nobody is developing. Point it at
/// the real folder by hand if you ever pick the port back up.
pub fn data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        dirs::config_dir().unwrap_or_default().join("ia_workspaces-tauri")
    }
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .unwrap_or_default()
            .join("Library/Application Support/ia_workspaces-tauri")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs::config_dir().unwrap_or_default().join("ia_workspaces-tauri")
    }
}

pub struct Store {
    file: PathBuf,
    /// Serialises writers. Two saves racing on one file is how a document ends
    /// up half of each.
    lock: Mutex<()>,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { file: dir.join("workspace.json"), lock: Mutex::new(()) }
    }

    pub fn load(&self) -> Value {
        std::fs::read_to_string(&self.file)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null)
    }

    /// Written the way `durableWrite.ts` writes it: a temporary file, flushed
    /// to the disk, then renamed. A rename that lands before the data blocks
    /// publishes a file of the right length full of NUL bytes, which is how the
    /// Electron host lost every workspace once.
    pub fn save(&self, document: Value) {
        let _guard = self.lock.lock().unwrap();
        let temporary = self.file.with_extension("json.tmp");
        let Ok(text) = serde_json::to_string_pretty(&document) else { return };
        if write_durable(&temporary, text.as_bytes()).is_err() {
            return;
        }
        let _ = std::fs::rename(&temporary, &self.file);
    }
}

fn write_durable(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// The shells this machine can offer. The Electron host probes for these; here
/// it is the platform default plus whatever is on PATH, which is enough for the
/// first slice and is where WSL and SSH will be added.
pub fn shells() -> Value {
    #[cfg(windows)]
    {
        json!([
            { "kind": "powershell", "label": "Windows PowerShell", "path": "powershell.exe" },
            { "kind": "pwsh", "label": "PowerShell 7", "path": "pwsh.exe" },
            { "kind": "cmd", "label": "Command Prompt", "path": "cmd.exe" }
        ])
    }
    #[cfg(not(windows))]
    {
        json!([
            { "kind": "bash", "label": "bash", "path": "bash" },
            { "kind": "zsh", "label": "zsh", "path": "zsh" }
        ])
    }
}
