package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// nodeRenderedInput runs the REAL canvas/graph.js renderedInput() for a canvas,
// wired exactly as server.js wires it, so the Go port can be deep-compared.
func nodeRenderedInput(t *testing.T, app, canvasPath string) map[string]any {
	t.Helper()
	script := `
const path = require('path');
const fs = require('fs');
const { createCanvasGraph } = require(process.argv[1]);
const { init } = require('es-module-lexer');
const canvasPath = process.argv[2];
const workspacePath = path.dirname(canvasPath);
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const resolveCanvasReference = (value) => {
  if (!value) return canvasPath;
  if (path.isAbsolute(value)) return path.normalize(value);
  const relative = value.replace(/^\.\//, '');
  const canvasName = path.basename(canvasPath);
  if (relative === canvasName || relative.startsWith(canvasName + '/')) return path.resolve(workspacePath, relative);
  return path.resolve(canvasPath, relative);
};
init.then(() => {
  const graph = createCanvasGraph({ fs, getCanvasPath: () => canvasPath, getIndexPath: () => path.join(canvasPath, 'index.json'), readJson, resolveCanvasReference });
  process.stdout.write(JSON.stringify(graph.renderedInput()));
});
`
	cmd := exec.Command("node", "-e", script, filepath.Join(app, "canvas", "graph.js"), canvasPath)
	cmd.Dir = app
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("node renderedInput: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("unmarshal node output: %v\n%s", err, out)
	}
	return m
}

// normalizeMtimes sets every file/dir under root to a fixed whole-second time,
// so JS mtimeMs (float) and Go UnixMilli (int) produce identical version tokens.
func normalizeMtimes(t *testing.T, root string) {
	t.Helper()
	fixed := time.Unix(1_700_000_000, 0)
	filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err == nil {
			os.Chtimes(p, fixed, fixed)
		}
		return nil
	})
}

func writeFile(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRenderedInputParity(t *testing.T) {
	wd, _ := os.Getwd()
	app := filepath.Dir(wd)

	ws := filepath.Join(t.TempDir(), "probe.liquidos")
	canvas := filepath.Join(ws, "home")
	writeFile(t, filepath.Join(canvas, "canvas.js"), "export const place = () => {};\n")
	writeFile(t, filepath.Join(canvas, "index.json"),
		`{"components":["components/foo/component.html"],"presentation":"presentations/stack.js"}`)
	writeFile(t, filepath.Join(canvas, "components", "foo", "component.html"),
		`<liquidos-component path="components/foo"><span>hi</span></liquidos-component>`)
	// A relationship (foo the sender) with a functions.js.
	writeFile(t, filepath.Join(canvas, "relationships", "foo-to-bar", "functions.js"),
		"export const connect = () => {};\n")
	// A failed diagnostic on the relationship -> foo needsRepair should be true.
	writeFile(t, filepath.Join(canvas, "relationships", "foo-to-bar", "diagnostics", "status.json"),
		`{"import":{"ok":false}}`)

	normalizeMtimes(t, ws)

	want := nodeRenderedInput(t, app, canvas)

	g := newCanvasGraph(canvas, ws)
	gotJSON, _ := json.Marshal(g.renderedInput())
	var got map[string]any
	json.Unmarshal(gotJSON, &got)

	if !reflect.DeepEqual(got, want) {
		gj, _ := json.MarshalIndent(got, "", "  ")
		wj, _ := json.MarshalIndent(want, "", "  ")
		t.Errorf("renderedInput mismatch\n--- got ---\n%s\n--- want ---\n%s", gj, wj)
	}
}

func TestRenderedInputDamaged(t *testing.T) {
	wd, _ := os.Getwd()
	app := filepath.Dir(wd)

	ws := filepath.Join(t.TempDir(), "probe.liquidos")
	canvas := filepath.Join(ws, "home")
	writeFile(t, filepath.Join(canvas, "canvas.js"), "export const place = () => {};\n")
	// index.json references a component whose entry file does not exist.
	writeFile(t, filepath.Join(canvas, "index.json"),
		`{"components":["components/missing/component.html"]}`)
	normalizeMtimes(t, ws)

	want := nodeRenderedInput(t, app, canvas)
	g := newCanvasGraph(canvas, ws)
	gotJSON, _ := json.Marshal(g.renderedInput())
	var got map[string]any
	json.Unmarshal(gotJSON, &got)

	if !reflect.DeepEqual(got, want) {
		gj, _ := json.MarshalIndent(got, "", "  ")
		wj, _ := json.MarshalIndent(want, "", "  ")
		t.Errorf("damaged renderedInput mismatch\n--- got ---\n%s\n--- want ---\n%s", gj, wj)
	}
}
