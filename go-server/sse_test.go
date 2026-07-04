package main

import (
	"strings"
	"testing"
)

// drain reads all currently-buffered frames from a client channel.
func drain(ch chan string) string {
	var b strings.Builder
	for {
		select {
		case f := <-ch:
			b.WriteString(f)
		default:
			return b.String()
		}
	}
}

func TestStreamHubSliceFraming(t *testing.T) {
	h := newStreamHub()
	client := h.agent.add()
	defer h.agent.remove(client)

	// A full atomic op flows through the sniffer to a `slice` event.
	h.serializeProducerChunk(agentSource, `narrate <lqpatch target="c/foo" op="setAttr" attr="hidden" value="true"></lqpatch>`)
	frames := drain(client)
	if !strings.Contains(frames, "event: slice") {
		t.Fatalf("expected a slice event, got:\n%s", frames)
	}
	if !strings.Contains(frames, `"kind":"narration"`) || !strings.Contains(frames, `"kind":"atomic"`) {
		t.Errorf("expected narration + atomic slices, got:\n%s", frames)
	}
}

func TestStreamHubEventsPing(t *testing.T) {
	h := newStreamHub()
	client := h.events.add()
	defer h.events.remove(client)

	h.broadcastEvents(nil)
	if got := drain(client); got != "data: update\n\n" {
		t.Errorf("events ping = %q; want \"data: update\\n\\n\"", got)
	}

	h.broadcastEvents(map[string]any{"type": "queue-status"})
	if got := drain(client); !strings.Contains(got, "queue-status") {
		t.Errorf("payload ping missing type: %q", got)
	}
}

func TestStreamHubDebugStatus(t *testing.T) {
	h := newStreamHub()
	client := h.agent.add()
	defer h.agent.remove(client)

	h.setCurrentAgentDebug(map[string]any{"status": "running", "pid": 4242})
	frames := drain(client)
	if !strings.Contains(frames, "event: debug-status") || !strings.Contains(frames, `"status":"running"`) {
		t.Errorf("expected debug-status running frame, got:\n%s", frames)
	}
	if cur := h.currentDebug(); cur["status"] != "running" {
		t.Errorf("currentDebug status = %v", cur["status"])
	}
}
