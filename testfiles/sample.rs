//! A Rust file, for block comments that really do span lines.

use std::collections::HashMap;
use std::fs;

/// Doc comment on a function.
pub fn read_pairs(path: &str) -> Result<HashMap<String, u32>, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut out = HashMap::new();

    /* This comment
       runs across
       three lines. */
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue; // skip anything without a separator
        };
        let parsed: u32 = value.trim().parse().unwrap_or(0);
        out.insert(key.trim().to_string(), parsed);
    }
    Ok(out)
}

const LIMIT: u64 = 1024 * 1024;
const MASK: u32 = 0xFF00_FF00;
