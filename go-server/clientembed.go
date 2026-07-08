package main

import (
	"embed"
	"io/fs"
)

// Built client assets, baked into the binary. The committed PLACEHOLDER keeps
// the embed valid before the build step runs (disk fallback in that case).
//
//go:embed all:clientdist
var clientDistFS embed.FS

// embeddedClient returns built bytes for a ROOT-relative path, or ok=false.
func embeddedClient(rel string) ([]byte, bool) {
	if rel == "" {
		return nil, false
	}
	data, err := fs.ReadFile(clientDistFS, "clientdist/"+rel)
	if err != nil {
		return nil, false
	}
	return data, true
}
