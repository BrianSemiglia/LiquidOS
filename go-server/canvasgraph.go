package main

// canvasgraph.go — Go port of canvas/graph.js.
//
// Produces renderedInput(): the canvas JSON the client renders (served by
// /input). Leaf components carry empty html — they paint client-side via
// canvas.js / <liquidos-file> — so the graph's job is identity + metadata:
// scope, resource urls/versions, needsRepair, and the presentation's cache
// token. A damaged index.json surfaces a canvas-level Repair card instead of an
// empty canvas.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// nowISO matches JavaScript's Date.toISOString(): UTC, millisecond precision,
// trailing Z (e.g. 2026-07-04T04:31:32.123Z).
func nowISO() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

type canvasGraph struct {
	canvasPath string // active canvas folder
	workspace  string // workspace root (for resolveCanvasReference / workspaceRel)
}

func newCanvasGraph(canvasPath, workspace string) *canvasGraph {
	return &canvasGraph{canvasPath: canvasPath, workspace: workspace}
}

func (g *canvasGraph) indexPath() string { return filepath.Join(g.canvasPath, "index.json") }

// resolveCanvasReference mirrors server.js: absolute stays absolute; a path
// under the canvas-name prefix resolves from the workspace; everything else
// resolves from the canvas folder.
func (g *canvasGraph) resolveCanvasReference(value string) string {
	if value == "" {
		return g.canvasPath
	}
	if filepath.IsAbs(value) {
		return filepath.Clean(value)
	}
	rel := strings.TrimPrefix(value, "./")
	canvasName := filepath.Base(g.canvasPath)
	if rel == canvasName || strings.HasPrefix(rel, canvasName+"/") {
		return filepath.Join(g.workspace, rel)
	}
	return filepath.Join(g.canvasPath, rel)
}

func toPosix(p string) string { return filepath.ToSlash(p) }

func (g *canvasGraph) componentScopePath(componentPath string) string {
	rel, _ := filepath.Rel(g.canvasPath, componentPath)
	return toPosix(rel)
}

// componentFolderPath: the folder itself if it's a dir, else its parent.
func componentFolderPath(componentPath string) string {
	if info, err := os.Stat(componentPath); err == nil && info.IsDir() {
		return componentPath
	}
	return filepath.Dir(componentPath)
}

func (g *canvasGraph) canvasJsPath() string { return filepath.Join(g.canvasPath, "canvas.js") }

var httpURLRe = regexp.MustCompile(`(?i)^https?://`)

func localResourcePath(resource map[string]any) string {
	p, ok := resource["path"].(string)
	if !ok || p == "" || httpURLRe.MatchString(p) {
		return ""
	}
	return p
}

func (g *canvasGraph) canvasLocalPath(file string) string {
	if filepath.IsAbs(file) {
		return filepath.Clean(file)
	}
	return filepath.Join(g.canvasPath, file)
}

func (g *canvasGraph) localResourceFile(resource map[string]any) string {
	if lp := localResourcePath(resource); lp != "" {
		return g.canvasLocalPath(lp)
	}
	return ""
}

// resourceUrl: an external resource keeps its url; a local one is served under
// /workspace/<canvas>/<path> (its version rides on the query, added by client).
func (g *canvasGraph) resourceUrl(resource map[string]any) string {
	if u, ok := resource["url"].(string); ok && u != "" {
		return u
	}
	local := localResourcePath(resource)
	if local == "" || filepath.IsAbs(local) {
		return ""
	}
	rel := filepath.ToSlash(filepath.Join(filepath.Base(g.canvasPath), filepath.FromSlash(local)))
	return "/workspace/" + rel
}

func escapeHTML(value string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")
	return r.Replace(value)
}

// --- diagnostics / repair -------------------------------------------------

func (g *canvasGraph) relationshipsDir() string { return filepath.Join(g.canvasPath, "relationships") }

func hasFailedDiagnostic(folder string) bool {
	data, err := os.ReadFile(filepath.Join(folder, "diagnostics", "status.json"))
	if err != nil {
		return false
	}
	var status map[string]json.RawMessage
	if json.Unmarshal(data, &status) != nil {
		return false
	}
	for _, raw := range status {
		var entry struct {
			OK *bool `json:"ok"`
		}
		if json.Unmarshal(raw, &entry) == nil && entry.OK != nil && !*entry.OK {
			return true
		}
	}
	return false
}

func relationshipSender(relName string) string {
	if idx := strings.Index(relName, "-to-"); idx > 0 {
		return relName[:idx]
	}
	return ""
}

// componentNeedsRepair: the component's own failed diagnostics OR any
// relationship where it's the sender with a failed diagnostic.
func (g *canvasGraph) componentNeedsRepair(componentPath string) bool {
	folder := componentFolderPath(componentPath)
	if hasFailedDiagnostic(folder) {
		return true
	}
	componentName := filepath.Base(folder)
	relsDir := g.relationshipsDir()
	entries, err := os.ReadDir(relsDir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if !e.IsDir() || relationshipSender(e.Name()) != componentName {
			continue
		}
		if hasFailedDiagnostic(filepath.Join(relsDir, e.Name())) {
			return true
		}
	}
	return false
}

// diagnosticsMu serializes the read-modify-write in updateDiagnostics. The
// client reports several categories for one component at once — a relationship
// that remounts POSTs `import` and `mount` in the same tick — and concurrent
// handlers would each read the same "before" copy, so the last writer dropped
// the other's category. A lost `mount: ok:false` is a failure the user never
// sees: the file ends up healthy, no further write means no further watch
// event, and the Repair button never appears.
var diagnosticsMu sync.Mutex

// updateDiagnostics merges a category into <component>/diagnostics/status.json,
// preserving other categories. Never breaks component loading on failure.
func (g *canvasGraph) updateDiagnostics(componentPath, category string, partial map[string]any) {
	diagnosticsMu.Lock()
	defer diagnosticsMu.Unlock()
	diagnosticsDir := filepath.Join(componentFolderPath(componentPath), "diagnostics")
	statusPath := filepath.Join(diagnosticsDir, "status.json")
	if os.MkdirAll(diagnosticsDir, 0o755) != nil {
		return
	}
	current := map[string]any{}
	if data, err := os.ReadFile(statusPath); err == nil {
		json.Unmarshal(data, &current)
	}
	now := nowISO()
	entry := map[string]any{"at": now}
	for k, v := range partial {
		entry[k] = v
	}
	current["updatedAt"] = now
	current[category] = entry
	if out, err := json.MarshalIndent(current, "", "  "); err == nil {
		os.WriteFile(statusPath, append(out, '\n'), 0o644)
	}
}

// --- entries --------------------------------------------------------------

type inputEntry struct {
	index         int
	entryPath     string
	componentPath string
}

func (g *canvasGraph) readIndex() (map[string]any, []any, error) {
	data, err := os.ReadFile(g.indexPath())
	if err != nil {
		return nil, nil, err
	}
	var input map[string]any
	if err := json.Unmarshal(data, &input); err != nil {
		return nil, nil, err
	}
	comps, ok := input["components"].([]any)
	if !ok {
		return input, nil, errComponentsArray
	}
	return input, comps, nil
}

var errComponentsArray = &statusError{code: 500, msg: `index.json must contain { "components": [...] }`}

func (g *canvasGraph) inputEntries() ([]inputEntry, error) {
	_, comps, err := g.readIndex()
	if err != nil {
		return nil, err
	}
	out := make([]inputEntry, 0, len(comps))
	for i, cp := range comps {
		s, ok := cp.(string)
		if !ok {
			return nil, &statusError{code: 500, msg: "index.json components[] must be a string path"}
		}
		out = append(out, inputEntry{index: i, entryPath: s, componentPath: g.resolveCanvasReference(s)})
	}
	return out, nil
}

// relationshipEntries: functions.js-bearing folders under relationships/.
func (g *canvasGraph) relationshipEntries() []inputEntry {
	dir := g.relationshipsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []inputEntry
	for i, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, e.Name(), "functions.js")); err != nil {
			continue
		}
		out = append(out, inputEntry{index: i, componentPath: filepath.Join(dir, e.Name())})
	}
	return out
}

func (g *canvasGraph) workspaceRel(file string) string {
	rel, _ := filepath.Rel(filepath.Dir(g.canvasPath), file)
	return toPosix(rel)
}

// renderedResources computes url + version for a component's resources (only
// relationships carry any — their functions.js).
func (g *canvasGraph) renderedResources(resources map[string]any) map[string]any {
	out := map[string]any{}
	for name, r := range resources {
		res, ok := r.(map[string]any)
		if !ok {
			out[name] = r
			continue
		}
		merged := map[string]any{}
		for k, v := range res {
			merged[k] = v
		}
		merged["url"] = g.resourceUrl(res)
		version := ""
		if lf := g.localResourceFile(res); lf != "" {
			version = closureVersion(lf)
		}
		merged["version"] = version
		out[name] = merged
	}
	return out
}

// renderEntry builds one component/relationship record for renderedInput.
func (g *canvasGraph) renderEntry(componentPath, entryPath string, component map[string]any) map[string]any {
	css, _ := component["css"].(string)
	html, _ := component["html"].(string)
	renderedHTML := ""
	if css != "" {
		renderedHTML = "<style>" + css + "</style>"
	}
	renderedHTML += html

	repairLevel, _ := component["repairLevel"].(string)
	resources, _ := component["resources"].(map[string]any)
	return map[string]any{
		"componentPath": componentPath,
		"entryPath":     entryPath,
		"scope":         componentFolderPath(componentPath),
		"repairLevel":   repairLevel,
		"html":          renderedHTML,
		"resources":     g.renderedResources(resources),
		"needsRepair":   g.componentNeedsRepair(componentPath),
	}
}

func (g *canvasGraph) relationshipComponents() []map[string]any {
	out := []map[string]any{} // JSON [] not null when empty (the client iterates it)
	for _, entry := range g.relationshipEntries() {
		relPath, _ := filepath.Rel(g.canvasPath, filepath.Join(entry.componentPath, "functions.js"))
		component := map[string]any{
			"html": "",
			"resources": map[string]any{
				"functions": map[string]any{
					"path": toPosix(relPath),
					"mime": "text/javascript",
				},
			},
		}
		out = append(out, g.renderEntry(entry.componentPath, "", component))
	}
	return out
}

// renderedInput is the canvas JSON the client renders. On any error it returns
// a canvas-level Repair card instead of an empty canvas.
func (g *canvasGraph) renderedInput() map[string]any {
	input, _, err := g.readIndex()
	if err == nil {
		var entries []inputEntry
		entries, err = g.inputEntries()
		if err == nil {
			// Every entry must resolve to an existing file.
			var missing []string
			for _, e := range entries {
				if info, statErr := os.Stat(e.componentPath); statErr != nil || info.IsDir() {
					missing = append(missing, e.entryPath)
				}
			}
			if len(missing) > 0 {
				err = &statusError{code: 500, msg: "index.json references components without a valid entry file: " + strings.Join(missing, ", ")}
			}
		}
		if err == nil {
			out := map[string]any{}
			for k, v := range input {
				out[k] = v
			}
			out["canvasPath"] = g.canvasPath
			out["canvasJsVersion"] = closureVersion(g.canvasJsPath())
			comps := make([]map[string]any, 0, len(entries))
			for _, e := range entries {
				// Leaf component: empty html, identity only (loadLeafComponent).
				comps = append(comps, g.renderEntry(e.componentPath, e.entryPath, map[string]any{"html": "", "title": ""}))
			}
			out["components"] = comps
			out["relationships"] = g.relationshipComponents()
			return out
		}
	}

	// Error path: canvas Repair card.
	return map[string]any{
		"canvasPath":      g.canvasPath,
		"canvasJsVersion": "",
		"canvasError":     err.Error(),
		"components": []map[string]any{{
			"componentPath": g.canvasPath,
			"scope":         g.canvasPath,
			"repairLevel":   "canvas",
			"html":          g.invalidCanvasCardHTML(err.Error()),
		}},
		"relationships": []map[string]any{},
	}
}

const canvasRepairContract = "\n\nThis is a canvas-shape problem — read skills/canvas/SKILL.md before acting."

func (g *canvasGraph) invalidCanvasCardHTML(errMessage string) string {
	title := "Canvas is damaged"
	scope := g.canvasPath
	prompt := "Repair required due to error: " + errMessage + canvasRepairContract
	return `<div role="group" aria-label="` + escapeHTML(title) + `" style="min-height:9rem;padding:1rem;border:1px solid rgba(248,113,113,0.45);border-radius:16px;background:rgba(127,29,29,0.22);color:#fecaca;display:grid;place-items:center;text-align:center;" data-repair-level="canvas">` +
		`<div style="display:grid;gap:0.75rem;justify-items:center;max-width:28rem;">` +
		`<div style="font-weight:750;font-size:1.05rem;letter-spacing:-0.01em;">` + escapeHTML(title) + `</div>` +
		`<liquidos-callback on="click" scope="` + escapeHTML(scope) + `" prompt="` + escapeHTML(prompt) + `">` +
		`<button style="border:1px solid rgba(252,165,165,0.35);border-radius:999px;background:rgba(127,29,29,0.55);color:#fecaca;padding:0.55rem 0.9rem;font:inherit;font-weight:700;cursor:pointer;">Repair</button>` +
		`</liquidos-callback>` +
		`</div>` +
		`</div>`
}

// validateCanvasConfig throws if index.json isn't a components-string-array.
func (g *canvasGraph) validateCanvasConfig() error {
	_, comps, err := g.readIndex()
	if err != nil {
		if err == errComponentsArray {
			return &statusError{code: 500, msg: "Canvas config must contain a components array"}
		}
		return err
	}
	for i, cp := range comps {
		if _, ok := cp.(string); !ok {
			return &statusError{code: 500, msg: "Canvas component path at index " + itoa64(int64(i)) + " must be a string"}
		}
	}
	return nil
}

// findLeafComponentByPath resolves a component reference (in any of the forms a
// route might use) to its index.json entry, or nil (graph.js).
func (g *canvasGraph) findLeafComponentByPath(componentPath string) *inputEntry {
	if componentPath == "" {
		return nil
	}
	absolute := g.resolveCanvasReference(componentPath)
	folder := componentFolderPath(absolute)
	entries, err := g.inputEntries()
	if err != nil {
		return nil
	}
	for i := range entries {
		e := &entries[i]
		cp := e.componentPath
		if cp == componentPath ||
			cp == absolute ||
			g.componentScopePath(cp) == componentPath ||
			componentFolderPath(cp) == componentPath ||
			componentFolderPath(cp) == absolute ||
			g.componentScopePath(componentFolderPath(cp)) == componentPath ||
			g.componentScopePath(componentFolderPath(cp)) == absolute ||
			componentFolderPath(cp) == folder {
			return e
		}
	}
	return nil
}

// pathIsInside reports whether file is base or nested under it (server.js).
func pathIsInside(file, base string) bool {
	rel, err := filepath.Rel(base, file)
	if err != nil {
		return false
	}
	return rel == "" || (!strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel))
}

// graphDependsOn: does the rendered graph depend on this workspace-relative
// file? (presentation closure, relationship closures, index.json, relationships
// tree.) Everything a <liquidos-file> watches repaints through its own morph.
func (g *canvasGraph) graphDependsOn(rel string) bool {
	name := filepath.Base(g.canvasPath)
	if rel == name+"/index.json" || strings.HasPrefix(rel, name+"/relationships/") {
		return true
	}
	for f := range closure(g.canvasJsPath()) {
		if g.workspaceRel(f) == rel {
			return true
		}
	}
	for _, entry := range g.relationshipEntries() {
		for f := range closure(filepath.Join(entry.componentPath, "functions.js")) {
			if g.workspaceRel(f) == rel {
				return true
			}
		}
	}
	return false
}
