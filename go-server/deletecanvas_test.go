package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDeleteCanvasTimeline(t *testing.T) {
	c := testConfig(t)
	ap := newActivityPersistence(c.workspace, func() string { return filepath.Join(c.workspace, "home") }, nil)

	if _, err := c.createCanvas("scratch"); err != nil {
		t.Fatal(err)
	}
	deleted, err := c.deleteCanvasWithTimeline(ap, "scratch")
	if err != nil || deleted != "scratch" {
		t.Fatalf("delete = %q, %v", deleted, err)
	}
	if _, err := os.Stat(filepath.Join(c.workspace, "scratch")); !os.IsNotExist(err) {
		t.Errorf("canvas folder should be gone")
	}

	events := ap.recentEvents(10)
	// Newest first: did delete, will delete, then earlier commits.
	if len(events) < 2 || events[0] != "User did delete canvas with name 'scratch'" || events[1] != "User will delete canvas with name 'scratch'" {
		t.Errorf("delete timeline = %#v", events)
	}
}
