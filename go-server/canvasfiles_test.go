package main

import (
	"os"
	"path/filepath"
	"testing"
)

func testConfig(t *testing.T) config {
	t.Helper()
	wd, _ := os.Getwd()
	root := filepath.Dir(wd) // repo root, for the real template + local assets
	ws := filepath.Join(t.TempDir(), "probe.liquidos")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	return config{root: root, workspace: ws}
}

func TestCreateCanvasMaterializes(t *testing.T) {
	c := testConfig(t)

	name, err := c.createCanvas("My Canvas!")
	if err != nil {
		t.Fatalf("createCanvas: %v", err)
	}
	if name != "my-canvas" { // trim + lowercase + non-slug run -> dash + trim dashes
		t.Fatalf("sanitized name = %q; want \"my-canvas\"", name)
	}

	canvasPath := filepath.Join(c.workspace, name)
	for _, want := range []string{"index.json", "canvas.js", "feature-requirements.txt"} {
		if _, err := os.Stat(filepath.Join(canvasPath, want)); err != nil {
			t.Errorf("expected %s to exist: %v", want, err)
		}
	}
	if info, err := os.Stat(filepath.Join(canvasPath, "components")); err != nil || !info.IsDir() {
		t.Errorf("expected components/ dir")
	}

	// index.json is the default shape.
	data, _ := os.ReadFile(filepath.Join(canvasPath, "index.json"))
	got := string(data)
	wantIndex := "{\n  \"components\": [],\n  \"presentation\": \"presentations/stack.js\"\n}\n"
	if got != wantIndex {
		t.Errorf("index.json =\n%q\nwant\n%q", got, wantIndex)
	}

	// The created canvas shows up in the listing as current-agnostic but valid.
	found := false
	for _, e := range c.availableCanvases() {
		if e.Name == name && e.Valid {
			found = true
		}
	}
	if !found {
		t.Errorf("created canvas not in availableCanvases()")
	}
}

func TestCreateCanvasErrors(t *testing.T) {
	c := testConfig(t)

	if _, err := c.createCanvas("  !!  "); err == nil {
		t.Errorf("blank-after-sanitize name should error")
	} else if se, ok := err.(*statusError); !ok || se.code != 400 {
		t.Errorf("want 400 statusError, got %v", err)
	}

	if _, err := c.createCanvas("dupe"); err != nil {
		t.Fatalf("first create: %v", err)
	}
	if _, err := c.createCanvas("dupe"); err == nil {
		t.Errorf("duplicate should error")
	} else if se, ok := err.(*statusError); !ok || se.code != 409 {
		t.Errorf("want 409 statusError, got %v", err)
	}
}

func TestDeleteCanvas(t *testing.T) {
	c := testConfig(t)
	if _, err := c.createCanvas("gone"); err != nil {
		t.Fatal(err)
	}

	if _, err := c.deleteCanvasFolder("nope"); err == nil {
		t.Errorf("deleting a missing canvas should error")
	} else if se, ok := err.(*statusError); !ok || se.code != 404 {
		t.Errorf("want 404, got %v", err)
	}

	if _, err := c.deleteCanvasFolder("bad/name"); err == nil {
		t.Errorf("slash name should be rejected")
	} else if se, ok := err.(*statusError); !ok || se.code != 400 {
		t.Errorf("want 400, got %v", err)
	}

	if _, err := c.deleteCanvasFolder("gone"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := os.Stat(filepath.Join(c.workspace, "gone")); !os.IsNotExist(err) {
		t.Errorf("canvas folder should be removed")
	}
}
