// Reading and writing, for the tree and the editor.
//
// A thin slice of `src/main/files.ts`: enough for the file tree to list a
// folder and the editor to open what it finds. The rest — git status, search,
// the copy and move operations — comes with the panes that need them.
use serde_json::{json, Value};

/// One folder, as the tree wants it: name, path, directory or not, size, when.
pub fn read_dir(dir: &str, show_hidden: bool) -> Result<Value, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let meta = entry.metadata().ok();
        out.push(json!({
            "name": name,
            "path": entry.path().to_string_lossy(),
            "isDir": meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
            "modified": meta.as_ref().and_then(modified_ms).unwrap_or(0.0),
        }));
    }
    Ok(Value::Array(out))
}

pub fn read_text(path: &str) -> Result<Value, String> {
    std::fs::read_to_string(path)
        .map(Value::from)
        .map_err(|e| e.to_string())
}

pub fn write_text(path: &str, content: &str) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(path, content).map_err(|e| e.to_string())
}

/// Modification time and size, which is how the editor and the canvas notice a
/// file changed underneath them.
pub fn stamp(path: &str) -> Value {
    match std::fs::metadata(path) {
        Ok(meta) => json!({
            "mtime": modified_ms(&meta).unwrap_or(0.0),
            "size": meta.len(),
        }),
        Err(_) => Value::Null,
    }
}

pub fn is_directory(path: &str) -> bool {
    std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

/// Milliseconds since the epoch, which is what JavaScript counts in.
fn modified_ms(meta: &std::fs::Metadata) -> Option<f64> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as f64)
}
