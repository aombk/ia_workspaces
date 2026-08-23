// One door, and a match arm per channel behind it.
//
// The renderer calls `invoke('ipc', { channel, args })`; everything the app can
// ask for arrives here as a string and a list of JSON values. An arm that does
// not exist yet answers `unimplemented`, which the renderer's adapter turns
// into a rejected promise naming the channel — a port in progress then fails
// loudly at the one feature that is missing rather than at startup.
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::State;

use crate::{files, state, Host};

type Args = Vec<Value>;

#[tauri::command]
pub async fn ipc(host: State<'_, Arc<Host>>, channel: String, args: Args) -> Result<Value, String> {
    dispatch(&host, &channel, &args).await
}

/// A positional argument, or a helpful failure naming which one was missing.
fn arg<'a>(args: &'a Args, index: usize, channel: &str) -> Result<&'a Value, String> {
    args.get(index)
        .ok_or_else(|| format!("{channel}: argument {index} was not supplied"))
}

fn text(args: &Args, index: usize, channel: &str) -> Result<String, String> {
    arg(args, index, channel)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("{channel}: argument {index} should be a string"))
}

fn number(args: &Args, index: usize, channel: &str) -> Result<i64, String> {
    arg(args, index, channel)?
        .as_i64()
        .ok_or_else(|| format!("{channel}: argument {index} should be a number"))
}

async fn dispatch(host: &Arc<Host>, channel: &str, args: &Args) -> Result<Value, String> {
    match channel {
        // ------------------------------------------------------------ state
        "state:load" => Ok(host.state.load()),
        "state:save" => {
            host.state.save(arg(args, 0, channel)?.clone());
            Ok(Value::Null)
        }

        // -------------------------------------------------------------- pty
        "pty:spawn" => host.ptys.spawn(arg(args, 0, channel)?.clone()),
        "pty:write" => {
            host.ptys
                .write(&text(args, 0, channel)?, &text(args, 1, channel)?);
            Ok(Value::Null)
        }
        "pty:resize" => {
            host.ptys.resize(
                &text(args, 0, channel)?,
                number(args, 1, channel)? as u16,
                number(args, 2, channel)? as u16,
            );
            Ok(Value::Null)
        }
        "pty:kill" => {
            host.ptys.kill(&text(args, 0, channel)?);
            Ok(Value::Null)
        }
        // Sleeping is killing that keeps the pane. The screen lives in the
        // renderer and the scrollback store, neither of which this touches.
        "pty:sleep" => {
            host.ptys.kill(&text(args, 0, channel)?);
            Ok(Value::Null)
        }
        "pty:isBusy" => Ok(json!(host.ptys.is_busy(&text(args, 0, channel)?))),

        // ------------------------------------------------------------ files
        "files:readDir" => files::read_dir(&text(args, 0, channel)?, args[1].as_bool() == Some(true)),
        "files:readText" => files::read_text(&text(args, 0, channel)?),
        "files:writeText" => {
            files::write_text(&text(args, 0, channel)?, &text(args, 1, channel)?)?;
            Ok(Value::Null)
        }
        "files:stamp" => Ok(files::stamp(&text(args, 0, channel)?)),
        "files:isDirectory" => Ok(json!(files::is_directory(&text(args, 0, channel)?))),

        // -------------------------------------------------------------- app
        "app:homeDir" => Ok(json!(dirs::home_dir().unwrap_or_default().to_string_lossy())),
        "app:version" => Ok(json!(env!("CARGO_PKG_VERSION"))),
        "shell:list" => Ok(state::shells()),

        // Everything not yet ported. Named, so the renderer's error says which
        // feature is missing rather than "undefined is not a function", and so
        // `node tools/ipcManifest.mjs --verbose` can list what is left.
        other => Err(format!("unimplemented channel: {other}")),
    }
}

/// Channels this host raises at the renderer, rather than answering.
///
/// Named here for the manifest's benefit — `tools/ipcManifest.mjs` counts the
/// channel strings in this crate, and an event emitted from `pty.rs` is still
/// a channel this host implements.
#[allow(dead_code)]
pub const EVENTS: &[&str] = &["pty:data", "pty:exit", "pty:meta", "pane:status"];
