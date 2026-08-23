// ia_workspaces, hosted by Wails instead of Electron.
//
// The third answer to the same 119 channels. Same renderer, same `Backend`
// contract, same one-door bridge as the Rust host: the renderer calls
// `Ipc(channel, args)` and this matches on the string. Keeping the two ports
// the same shape is deliberate — it makes them comparable, which is the whole
// reason both exist.
//
// Go rather than Rust for the same job, to find out what the difference costs.
// The interesting numbers are memory and startup; see tools/benchHost.mjs.
package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend
var assets embed.FS

func main() {
	host := NewHost()

	err := wails.Run(&options.App{
		Title:  "ia_workspaces",
		Width:  1280,
		Height: 800,
		// Frameless, like the Electron window: the app draws its own title bar
		// and the traffic lights are part of the layout.
		Frameless:        true,
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        host.Startup,
		OnShutdown:       host.Shutdown,
		Bind:             []interface{}{host},
		WindowStartState: options.Normal,
	})
	if err != nil {
		panic(err)
	}
}
