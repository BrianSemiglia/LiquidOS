package main

// deletecanvas.go — Go port of canvas/delete-canvas.js's deleteCanvas().
//
// Deleting a canvas is two commits bracketing the removal: a "will delete"
// snapshot (so a never-committed canvas still leaves a recoverable state) and a
// "did delete" record. The in-app DELETE /canvases/<name> route calls this; the
// agent CLI path (delete-canvas.js) produces the same pair, so deletion behaves
// identically no matter who triggers it. The commit format lives in the timeline
// (via persistActivity) — never hand-write it, or recentEvents stops parsing.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// runDeleteCanvasCLI is the `liquidos-server delete-canvas <name> <workspace>`
// subcommand the agent's delete-instance.sh runs — the same delete + timeline
// pair the DELETE /canvases route performs, so the shell path ships no JS.
// Mirrors canvas/delete-canvas.js's CLI: JSON {canvas,path} on stdout; exit 2
// for a usage/4xx error, 1 otherwise.
func runDeleteCanvasCLI(args []string) {
	if len(args) < 2 || args[0] == "" || args[1] == "" {
		fmt.Fprintln(os.Stderr, "Usage: liquidos-server delete-canvas <canvas-name> <workspace.liquidos>")
		os.Exit(1)
	}
	name := args[0]
	workspace, _ := filepath.Abs(args[1])
	canvasPath := filepath.Join(workspace, name)

	cfg := config{workspace: workspace, canvasPath: canvasPath}
	ap := newActivityPersistence(workspace, func() string { return canvasPath }, nil)

	deleted, err := cfg.deleteCanvasWithTimeline(ap, name)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err.Error())
		if se, ok := err.(*statusError); ok && se.code >= 400 && se.code < 500 {
			os.Exit(2)
		}
		os.Exit(1)
	}
	out, _ := json.Marshal(map[string]string{"canvas": deleted, "path": canvasPath})
	fmt.Println(string(out))
}

func willDeleteCanvasEvent(name string) string {
	return eventWithParameter("User will delete canvas", "name", name)
}
func didDeleteCanvasEvent(name string) string {
	return eventWithParameter("User did delete canvas", "name", name)
}

// deleteCanvasWithTimeline snapshots the canvas, removes it, and records the
// removal — the single source of truth for canvas deletion in the server.
func (c config) deleteCanvasWithTimeline(ap *activityPersistence, name string) (string, error) {
	ap.persistActivity(persistActivityOpts{
		event:         willDeleteCanvasEvent(name),
		scope:         filepath.Join(c.workspace, name),
		agentResponse: "none",
		mode:          "done",
	})
	deleted, err := c.deleteCanvasFolder(name)
	if err != nil {
		return "", err
	}
	ap.persistActivity(persistActivityOpts{
		event:         didDeleteCanvasEvent(deleted),
		scope:         filepath.Join(c.workspace, deleted),
		agentResponse: "none",
		mode:          "done",
	})
	return deleted, nil
}
