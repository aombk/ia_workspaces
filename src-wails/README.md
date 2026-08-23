# The Wails host — parked

The same second host as `src-tauri`, in Go instead of Rust, built to find out
what the language difference costs. It builds, opens a window, loads the real UI
and runs a shell. It is **not developed**.

**State: 20 of 119 channels**, the same twenty the Rust host answers. See
`node tools/ipcManifest.mjs --verbose` for the rest, and `src-tauri/README.md`
for the measurements and for why both are parked — the reasons are the same,
because both use WebView2 and lose the same three things.

What the language changed, on this machine: Wails started in 624 ms against
Tauri's 1081, used 46 MB more private memory and three times the idle CPU, and
its binary is 18 MB against 7.1. Neither difference decides anything.

## Building it, if you come back

```
node build.mjs --hosts                       # the renderer bundle
cp -r ../out/tauri/renderer/* frontend/      # what wails embeds
wails build -s -o ia_workspaces.exe
node tools/benchHost.mjs wails
```

Go, and `go install github.com/wailsapp/wails/v2/cmd/wails@latest`.
