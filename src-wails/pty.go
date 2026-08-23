// The shells, and the bytes they print.
//
// `go-pty` is the Go equivalent of what the Rust host gets from portable-pty:
// ConPTY on Windows, openpty elsewhere, one API over both. One reader goroutine
// per shell, which is what goroutines are for.
package main

import (
	"context"
	"io"
	"os"
	"sync"

	"github.com/aymanbagabas/go-pty"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type session struct {
	pty   pty.Pty
	cmd   *pty.Cmd
	alive bool
}

type PtyManager struct {
	ctx      context.Context
	mutex    sync.Mutex
	sessions map[string]*session
}

func NewPtyManager() *PtyManager {
	return &PtyManager{sessions: map[string]*session{}}
}

func (m *PtyManager) Attach(ctx context.Context) { m.ctx = ctx }

// Spawn starts a shell for a pane, or reports the one already there.
//
// Re-spawning a live pane is not an error and must not replace anything: it is
// what a renderer that has just re-mounted a tab does.
func (m *PtyManager) Spawn(request interface{}) (interface{}, error) {
	spec, _ := request.(map[string]interface{})
	paneID, _ := spec["paneId"].(string)
	if paneID == "" {
		return nil, errNoPane
	}

	m.mutex.Lock()
	if _, running := m.sessions[paneID]; running {
		m.mutex.Unlock()
		return map[string]interface{}{"ok": true}, nil
	}
	m.mutex.Unlock()

	terminal, err := pty.New()
	if err != nil {
		return nil, err
	}
	if cols, rows := size(spec); cols > 0 {
		terminal.Resize(cols, rows)
	}

	command := terminal.Command(shellFor(spec))
	if cwd, ok := spec["cwd"].(string); ok && cwd != "" {
		command.Dir = cwd
	}
	// The pane's own id, so anything the shell starts can find its way back —
	// the same contract `iaw notify` relies on under Electron. The command
	// starts with no environment of its own, so this is the process's plus one.
	command.Env = append(os.Environ(), "IAW_PANE_ID="+paneID)
	if err := command.Start(); err != nil {
		terminal.Close()
		return nil, err
	}

	held := &session{pty: terminal, cmd: command, alive: true}
	m.mutex.Lock()
	m.sessions[paneID] = held
	m.mutex.Unlock()

	go m.pump(paneID, held)
	return map[string]interface{}{"ok": true}, nil
}

// pump reads until the shell goes, then reports how it went.
func (m *PtyManager) pump(paneID string, held *session) {
	buffer := make([]byte, 8192)
	for {
		n, err := held.pty.Read(buffer)
		if n > 0 {
			runtime.EventsEmit(m.ctx, "pty:data", map[string]interface{}{
				"paneId": paneID,
				// A pty carries bytes; a multi-byte character split across two
				// reads must not take the pane down. The renderer's terminal
				// reassembles what it can.
				"data": string(buffer[:n]),
			})
		}
		if err != nil {
			if err != io.EOF {
				_ = err
			}
			break
		}
	}
	code := 0
	if err := held.cmd.Wait(); err != nil {
		code = -1
	}
	m.mutex.Lock()
	held.alive = false
	delete(m.sessions, paneID)
	m.mutex.Unlock()
	runtime.EventsEmit(m.ctx, "pty:exit", map[string]interface{}{"paneId": paneID, "exitCode": code})
}

func (m *PtyManager) Write(paneID string, data string) {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	if held, ok := m.sessions[paneID]; ok {
		held.pty.Write([]byte(data))
	}
}

func (m *PtyManager) Resize(paneID string, cols int, rows int) {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	if held, ok := m.sessions[paneID]; ok && cols > 0 && rows > 0 {
		held.pty.Resize(cols, rows)
	}
}

func (m *PtyManager) Kill(paneID string) {
	m.mutex.Lock()
	held, ok := m.sessions[paneID]
	delete(m.sessions, paneID)
	m.mutex.Unlock()
	if ok {
		// Closing the pty ends the shell and unblocks the reader, which reports
		// the exit on its way out.
		held.pty.Close()
	}
}

func (m *PtyManager) IsBusy(paneID string) bool {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	held, ok := m.sessions[paneID]
	return ok && held.alive
}

func (m *PtyManager) CloseAll() {
	m.mutex.Lock()
	held := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		held = append(held, s)
	}
	m.sessions = map[string]*session{}
	m.mutex.Unlock()
	for _, s := range held {
		s.pty.Close()
	}
}

func size(spec map[string]interface{}) (int, int) {
	cols, _ := spec["cols"].(float64)
	rows, _ := spec["rows"].(float64)
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}
	return int(cols), int(rows)
}

// shellFor picks the program to run, with the platform's own shell as the
// answer to silence.
func shellFor(spec map[string]interface{}) string {
	if file, ok := spec["file"].(string); ok && file != "" {
		return file
	}
	switch spec["shell"] {
	case "pwsh":
		return "pwsh.exe"
	case "cmd":
		return "cmd.exe"
	case "bash":
		return "bash"
	case "zsh":
		return "zsh"
	}
	return defaultShell()
}
