package main

// deletecanvas.go — Go port of canvas/delete-canvas.js's deleteCanvas().
//
// Deleting a canvas is two commits bracketing the removal: a "will delete"
// snapshot (so a never-committed canvas still leaves a recoverable state) and a
// "did delete" record. The in-app DELETE /canvases/<name> route calls this; the
// agent CLI path (delete-canvas.js) produces the same pair, so deletion behaves
// identically no matter who triggers it. The commit format lives in the timeline
// (via persistActivity) — never hand-write it, or recentEvents stops parsing.

import "path/filepath"

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
