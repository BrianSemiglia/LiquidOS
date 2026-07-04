package main

// canvasfiles.go — Go port of canvas/files.js.
//
// Canvas materialization and CRUD: create a canvas from the app's template +
// local assets, list canvases, and delete one. Faithful to files.js, including
// its name-sanitization and HTTP status codes (surfaced as statusError).

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// nonSlugRun matches files.js createCanvas's /[^a-z0-9_-]+/g — runs of
// characters outside the canvas-slug set, collapsed to a single dash.
var nonSlugRun = regexp.MustCompile(`[^a-z0-9_-]+`)

// statusError carries the HTTP status code files.js attaches to its errors so
// the route layer can reply with the same code.
type statusError struct {
	code int
	msg  string
}

func (e *statusError) Error() string { return e.msg }
func newStatusError(code int, format string, a ...any) *statusError {
	return &statusError{code: code, msg: fmt.Sprintf(format, a...)}
}

func (c config) canvasTemplateRoot() string {
	return filepath.Join(c.root, "skills", "canvas", "scripts", "templates")
}

func (c config) localAssetRoot() string {
	return filepath.Join(c.root, "skills", "canvas")
}

// copyTemplateDirectory recursively copies source into target, skipping
// .gitkeep and canvas.html, and never overwriting an existing file.
func copyTemplateDirectory(source, target string) error {
	if err := os.MkdirAll(target, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == ".gitkeep" || entry.Name() == "canvas.html" {
			continue
		}
		sourcePath := filepath.Join(source, entry.Name())
		targetPath := filepath.Join(target, entry.Name())
		if entry.IsDir() {
			if err := copyTemplateDirectory(sourcePath, targetPath); err != nil {
				return err
			}
		} else if entry.Type().IsRegular() {
			if _, err := os.Stat(targetPath); os.IsNotExist(err) {
				if err := copyFile(sourcePath, targetPath); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode())
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

// writeDefaultFile writes contents only if the file does not already exist.
func writeDefaultFile(filePath, contents string) error {
	if _, err := os.Stat(filePath); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(filePath, []byte(contents), 0o644)
}

func (c config) copyLocalAssetDirectory(sourceName, canvasPath string) error {
	sourcePath := filepath.Join(c.localAssetRoot(), sourceName)
	targetPath := filepath.Join(canvasPath, sourceName)
	if info, err := os.Stat(sourcePath); err == nil && info.IsDir() {
		return copyTemplateDirectory(sourcePath, targetPath)
	}
	return nil
}

// ensureLocalAssetReferences fills in a missing/blank presentation key. A
// damaged index.json is a canvas-level repair case and must not throw here.
func ensureLocalAssetReferences(canvasPath string) {
	indexPath := filepath.Join(canvasPath, "index.json")
	data, err := os.ReadFile(indexPath)
	if err != nil {
		return
	}
	var input map[string]any
	if json.Unmarshal(data, &input) != nil {
		return
	}
	presentation, ok := input["presentation"].(string)
	if !ok || strings.TrimSpace(presentation) == "" {
		input["presentation"] = "presentations/stack.js"
		if out, err := json.MarshalIndent(input, "", "  "); err == nil {
			os.WriteFile(indexPath, append(out, '\n'), 0o644)
		}
	}
}

// ensureCanvasDefaults materializes canvas <name> from the app template + local
// assets and a default index.json (files.js ensureCanvasDefaults).
func (c config) ensureCanvasDefaults(name string) (string, error) {
	canvasPath := filepath.Join(c.workspace, name)
	if err := os.MkdirAll(canvasPath, 0o755); err != nil {
		return "", err
	}
	if info, err := os.Stat(c.canvasTemplateRoot()); err == nil && info.IsDir() {
		if err := copyTemplateDirectory(c.canvasTemplateRoot(), canvasPath); err != nil {
			return "", err
		}
	}
	if err := os.MkdirAll(filepath.Join(canvasPath, "components"), 0o755); err != nil {
		return "", err
	}
	if err := c.copyLocalAssetDirectory("presentations", canvasPath); err != nil {
		return "", err
	}
	defaultIndex, _ := json.MarshalIndent(map[string]any{
		"components":   []any{},
		"presentation": "presentations/stack.js",
	}, "", "  ")
	if err := writeDefaultFile(filepath.Join(canvasPath, "index.json"), string(defaultIndex)+"\n"); err != nil {
		return "", err
	}
	ensureLocalAssetReferences(canvasPath)
	return canvasPath, nil
}

// validCanvasName mirrors files.js /^[^/][^/]*$/: non-empty, no slash.
func validCanvasName(name string) bool {
	return name != "" && !strings.Contains(name, "/")
}

// createCanvas sanitizes the name, materializes the canvas, and stubs an empty
// feature-requirements.txt (files.js createCanvas).
func (c config) createCanvas(name string) (string, error) {
	safe := strings.ToLower(strings.TrimSpace(name))
	safe = nonSlugRun.ReplaceAllString(safe, "-")
	safe = strings.Trim(safe, "-")
	if safe == "" {
		return "", newStatusError(400, "Canvas name is required")
	}
	if _, err := os.Stat(filepath.Join(c.workspace, safe)); err == nil {
		return "", newStatusError(409, "Canvas already exists: %s", safe)
	}
	canvasPath, err := c.ensureCanvasDefaults(safe)
	if err != nil {
		return "", err
	}
	// feature-requirements.txt: empty at creation only (missing → Repair vs
	// empty → Generate in the UI); bootstrap leaves a missing one missing.
	if err := os.WriteFile(filepath.Join(canvasPath, "feature-requirements.txt"), []byte(""), 0o644); err != nil {
		return "", err
	}
	return safe, nil
}

// deleteCanvasFolder removes the canvas folder only; recording the event and
// committing to git is the endpoint's job (files.js deleteCanvas).
func (c config) deleteCanvasFolder(name string) (string, error) {
	if !validCanvasName(name) {
		return "", newStatusError(400, "Invalid canvas name")
	}
	canvasPath := filepath.Join(c.workspace, name)
	if _, err := os.Stat(filepath.Join(canvasPath, "index.json")); err != nil {
		return "", newStatusError(404, "Canvas does not exist: %s", name)
	}
	if err := os.RemoveAll(canvasPath); err != nil {
		return "", err
	}
	return name, nil
}
