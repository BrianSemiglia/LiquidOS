package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPermanentFixOwed(t *testing.T) {
	cases := []struct {
		name   string
		events []string
		want   bool
	}{
		{"recover not yet fixed", []string{"User did prompt", recoverEvent, "older"}, true},
		{"recover then fixed", []string{fixEvent, recoverEvent}, false},
		{"no crash at all", []string{"User did prompt", "User did quit"}, false},
		{"fix before newer recover owes again", []string{recoverEvent, fixEvent, recoverEvent}, true},
		{"empty", nil, false},
	}
	for _, tc := range cases {
		if got := permanentFixOwed(tc.events); got != tc.want {
			t.Errorf("%s: permanentFixOwed=%v want %v", tc.name, got, tc.want)
		}
	}
}

func TestCrashReportRoundTrip(t *testing.T) {
	ws := t.TempDir()

	if _, ok := consumeCrashReport(ws); ok {
		t.Errorf("no marker should mean not ok")
	}

	writeCrashReport(ws, "boom", "at foo\nat bar")
	if _, err := os.Stat(crashMarkerPath(ws)); err != nil {
		t.Fatalf("marker not written: %v", err)
	}

	report, ok := consumeCrashReport(ws)
	if !ok || report.Reason != "boom" || report.Stack != "at foo\nat bar" {
		t.Errorf("report = %#v ok=%v", report, ok)
	}
	// consume removes the marker.
	if _, err := os.Stat(crashMarkerPath(ws)); !os.IsNotExist(err) {
		t.Errorf("marker should be removed after consume")
	}
}

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
