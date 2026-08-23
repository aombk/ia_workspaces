# The Tauri host — parked

A second host for the same renderer, in Rust. It builds, opens a window, loads
the real UI and runs a shell. It is **not developed** — kept as a starting point
and as evidence, not as something that ships.

**State: 20 of 119 channels.** `node tools/ipcManifest.mjs --verbose` lists the
rest. What works: state load/save, shell list, pty spawn/write/resize/kill with
data and exit events, directory listing, file read/write/stamp, home dir,
version. Everything else answers *"not ported to the Tauri host yet: <channel>"*
through the proxy in `src/backend/tauri.ts`, so the window still opens.

## Why it is parked

Measured against Electron on the machine this was written on, empty window:

| host     | startup | procs | working set | private | idle cpu | binary |
| -------- | ------- | ----- | ----------- | ------- | -------- | ------ |
| tauri    | 1081 ms | 7     | 402 MB      | 206 MB  | 0.5%     | 7.1 MB |
| wails    | 624 ms  | 7     | 399 MB      | 252 MB  | 1.6%     | 18 MB  |
| electron | —       | 5     | 611 MB      | 481 MB  | 2.9%     | 313 MB |

Real savings, and not enough to pay for what is lost. Three things do not port:

- **The browser pane.** `<webview>` is Electron's. A WebView2 child window
  composites over the page with no z-order, so it covers menus, toasts and the
  palette. This is why the first Tauri attempt was dropped, in August.
- **Dragging a file out to Explorer**, which needs a native `CF_HDROP` drag
  source that neither host provides.
- **One engine on three platforms.** WebView2 on Windows is Chromium; macOS and
  Linux get WebKit, and the renderer would have to work there too.

And a standing tax: `src/shared/` is imported by both the renderer and the Node
host, and Rust cannot import TypeScript, so every contract in it is mirrored by
hand.

## Building it, if you come back

```
node build.mjs --hosts        # the renderer bundle this needs
cargo build --release         # in this folder
node tools/benchHost.mjs tauri
```

`cargo`, the MSVC toolchain and the WebView2 runtime are the requirements.
