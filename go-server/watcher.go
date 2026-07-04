package main

// watcher.go — Go port of server.js's @parcel/watcher workspace subscription.
//
// One recursive watch on the whole workspace is the single source of "a file
// changed -> tell the clients". It's workspace-scoped (never torn down on a
// canvas switch), coalesces a burst of writes into one delivery, and re-syncs
// from disk if the backend drops events. fsnotify isn't recursive, so we walk-
// add every directory and add newly-created ones as they appear.

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

type fsWatcher struct {
	root     string
	ignore   map[string]bool
	onEvents func(paths []string) // a coalesced batch of changed absolute paths
	onRescan func()               // backend error/overflow -> re-sync from disk
	w        *fsnotify.Watcher

	mu      sync.Mutex
	pending map[string]bool
	timer   *time.Timer
	closed  chan struct{}
	debounce time.Duration
}

func newFSWatcher(root string, ignore []string, onEvents func([]string), onRescan func()) (*fsWatcher, error) {
	// @parcel/watcher resolves symlinks; match so event paths are under the
	// real root (macOS /var -> /private/var) and line up with the client's view.
	if real, err := filepath.EvalSymlinks(root); err == nil {
		root = real
	}
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	ig := map[string]bool{}
	for _, name := range ignore {
		ig[name] = true
	}
	fw := &fsWatcher{
		root: root, ignore: ig, onEvents: onEvents, onRescan: onRescan, w: w,
		pending: map[string]bool{}, closed: make(chan struct{}), debounce: 30 * time.Millisecond,
	}
	fw.addRecursive(root)
	go fw.run()
	return fw, nil
}

func (fw *fsWatcher) isIgnored(path string) bool {
	rel, err := filepath.Rel(fw.root, path)
	if err != nil {
		return false
	}
	for _, seg := range strings.Split(rel, string(filepath.Separator)) {
		if fw.ignore[seg] {
			return true
		}
	}
	return false
}

// addRecursive registers dir and every subdirectory, skipping ignored trees.
func (fw *fsWatcher) addRecursive(dir string) {
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if p != fw.root && fw.ignore[d.Name()] {
			return filepath.SkipDir
		}
		fw.w.Add(p)
		return nil
	})
}

func (fw *fsWatcher) run() {
	for {
		select {
		case <-fw.closed:
			return
		case event, ok := <-fw.w.Events:
			if !ok {
				return
			}
			if fw.isIgnored(event.Name) {
				continue
			}
			// A newly-created directory must itself be watched (fsnotify isn't
			// recursive), so its children's events aren't missed.
			if event.Op&fsnotify.Create != 0 {
				if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
					fw.addRecursive(event.Name)
				}
			}
			fw.enqueue(event.Name)
		case err, ok := <-fw.w.Errors:
			if !ok {
				return
			}
			_ = err
			if fw.onRescan != nil {
				fw.onRescan()
			}
		}
	}
}

func (fw *fsWatcher) enqueue(path string) {
	fw.mu.Lock()
	fw.pending[path] = true
	if fw.timer == nil {
		fw.timer = time.AfterFunc(fw.debounce, fw.flush)
	}
	fw.mu.Unlock()
}

func (fw *fsWatcher) flush() {
	fw.mu.Lock()
	paths := make([]string, 0, len(fw.pending))
	for p := range fw.pending {
		paths = append(paths, p)
	}
	fw.pending = map[string]bool{}
	fw.timer = nil
	fw.mu.Unlock()
	if len(paths) > 0 && fw.onEvents != nil {
		fw.onEvents(paths)
	}
}

func (fw *fsWatcher) close() {
	select {
	case <-fw.closed:
	default:
		close(fw.closed)
	}
	fw.w.Close()
}
