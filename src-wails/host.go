// One door, and a switch per channel behind it.
//
// The mirror of `src-tauri/src/ipc.rs`, in Go. The renderer calls
// `window.go.main.Host.Ipc(channel, args)` through the binding Wails generates,
// and a channel that has not been ported answers an error naming itself — so a
// half-finished host fails at the one feature that is missing rather than at
// startup. `tools/ipcManifest.mjs` counts the strings in this file.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

type Host struct {
	ctx   context.Context
	ptys  *PtyManager
	state *Store
}

func NewHost() *Host {
	return &Host{ptys: NewPtyManager(), state: NewStore(dataDir())}
}

func (h *Host) Startup(ctx context.Context) {
	h.ctx = ctx
	h.ptys.Attach(ctx)
}

func (h *Host) Shutdown(ctx context.Context) {
	h.ptys.CloseAll()
}

// Ipc answers everything the renderer can ask for.
func (h *Host) Ipc(channel string, args []interface{}) (interface{}, error) {
	switch channel {
	// ---------------------------------------------------------------- state
	case "state:load":
		return h.state.Load(), nil
	case "state:save":
		h.state.Save(arg(args, 0))
		return nil, nil

	// ------------------------------------------------------------------ pty
	case "pty:spawn":
		return h.ptys.Spawn(arg(args, 0))
	case "pty:write":
		h.ptys.Write(text(args, 0), text(args, 1))
		return nil, nil
	case "pty:resize":
		h.ptys.Resize(text(args, 0), number(args, 1), number(args, 2))
		return nil, nil
	// Sleeping is killing that keeps the pane; the screen is the renderer's.
	case "pty:kill", "pty:sleep":
		h.ptys.Kill(text(args, 0))
		return nil, nil
	case "pty:isBusy":
		return h.ptys.IsBusy(text(args, 0)), nil

	// ---------------------------------------------------------------- files
	case "files:readDir":
		return readDir(text(args, 0), boolean(args, 1))
	case "files:readText":
		return readText(text(args, 0))
	case "files:writeText":
		return nil, writeText(text(args, 0), text(args, 1))
	case "files:stamp":
		return stamp(text(args, 0)), nil
	case "files:isDirectory":
		return isDirectory(text(args, 0)), nil

	// ------------------------------------------------------------------ app
	case "app:homeDir":
		home, _ := os.UserHomeDir()
		return home, nil
	case "app:version":
		return "1.1.0", nil
	case "shell:list":
		return shells(), nil
	}
	return nil, fmt.Errorf("unimplemented channel: %s", channel)
}

// Events this host raises rather than answers. Emitted from pty.go; named here
// so the manifest can count them.
var events = []string{"pty:data", "pty:exit", "pty:meta", "pane:status"}

// ------------------------------------------------------------------ arguments

func arg(args []interface{}, index int) interface{} {
	if index < len(args) {
		return args[index]
	}
	return nil
}

func text(args []interface{}, index int) string {
	if value, ok := arg(args, index).(string); ok {
		return value
	}
	return ""
}

func number(args []interface{}, index int) int {
	// JSON numbers arrive as float64 whatever they looked like on the way in.
	if value, ok := arg(args, index).(float64); ok {
		return int(value)
	}
	return 0
}

func boolean(args []interface{}, index int) bool {
	value, _ := arg(args, index).(bool)
	return value
}

// ---------------------------------------------------------------------- state

// Store holds the workspace document, in the same file the Electron host uses:
// running one host today and the other tomorrow should show the same
// workspaces.
type Store struct{ file string }

func NewStore(dir string) *Store {
	os.MkdirAll(dir, 0o755)
	return &Store{file: filepath.Join(dir, "workspace.json")}
}

func (s *Store) Load() interface{} {
	bytes, err := os.ReadFile(s.file)
	if err != nil {
		return nil
	}
	var document interface{}
	if json.Unmarshal(bytes, &document) != nil {
		return nil
	}
	return document
}

// Save writes through a temporary file that is flushed before the rename. A
// rename that lands before the data blocks publishes a file of the right length
// full of NUL bytes, which is how the Electron host lost every workspace once.
func (s *Store) Save(document interface{}) {
	bytes, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return
	}
	temporary := s.file + ".tmp"
	file, err := os.Create(temporary)
	if err != nil {
		return
	}
	if _, err := file.Write(bytes); err != nil {
		file.Close()
		return
	}
	file.Sync()
	file.Close()
	os.Rename(temporary, s.file)
}

// dataDir is this host's own, and not the Electron host's.
//
// A finished port would share `ia_workspaces`, so switching hosts showed the
// same workspaces. While this one is parked and only started to be measured,
// that is exactly wrong: two apps writing one document is how a document gets
// truncated, and that document is every workspace somebody has. Starting this
// host shows an empty app, which is the right amount of damage.
func dataDir() string {
	config, err := os.UserConfigDir()
	if err != nil {
		home, _ := os.UserHomeDir()
		config = filepath.Join(home, ".config")
	}
	if runtime.GOOS == "darwin" {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Application Support", "ia_workspaces-wails")
	}
	return filepath.Join(config, "ia_workspaces-wails")
}

func shells() []map[string]string {
	if runtime.GOOS == "windows" {
		return []map[string]string{
			{"kind": "powershell", "label": "Windows PowerShell", "path": "powershell.exe"},
			{"kind": "pwsh", "label": "PowerShell 7", "path": "pwsh.exe"},
			{"kind": "cmd", "label": "Command Prompt", "path": "cmd.exe"},
		}
	}
	return []map[string]string{
		{"kind": "bash", "label": "bash", "path": "bash"},
		{"kind": "zsh", "label": "zsh", "path": "zsh"},
	}
}

// ---------------------------------------------------------------------- files

func readDir(dir string, showHidden bool) (interface{}, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]interface{}, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if !showHidden && len(name) > 0 && name[0] == '.' {
			continue
		}
		info, _ := entry.Info()
		row := map[string]interface{}{
			"name":  name,
			"path":  filepath.Join(dir, name),
			"isDir": entry.IsDir(),
		}
		if info != nil {
			row["size"] = info.Size()
			row["modified"] = info.ModTime().UnixMilli()
		}
		out = append(out, row)
	}
	return out, nil
}

func readText(path string) (string, error) {
	bytes, err := os.ReadFile(path)
	return string(bytes), err
}

func writeText(path string, content string) error {
	os.MkdirAll(filepath.Dir(path), 0o755)
	return os.WriteFile(path, []byte(content), 0o644)
}

func stamp(path string) interface{} {
	info, err := os.Stat(path)
	if err != nil {
		return nil
	}
	return map[string]interface{}{
		"mtime": info.ModTime().UnixMilli(),
		"size":  info.Size(),
	}
}

func isDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

var _ = time.Now
