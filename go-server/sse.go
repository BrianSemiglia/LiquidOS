package main

// sse.go — Go port of server.js's SSE hubs and agent-output plumbing.
//
// Two channels:
//   /events        — coarse "something changed, reload" pings (broadcast).
//   /agent/stream  — the agent's framed output as `slice` events plus
//                    `debug-*` status events the activity rail reads.
//
// Every producer's output runs through one lqpatch sniffer per source, emitting
// sequenced slice events so a marker one producer holds open can't swallow
// another's bytes. A monotonic seq orders all slices authoritatively.

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"sync"
)

// sseHub is a set of connected SSE clients; broadcast writes a pre-formatted
// frame to each.
type sseHub struct {
	mu      sync.Mutex
	clients map[chan string]bool
}

func newSSEHub() *sseHub { return &sseHub{clients: map[chan string]bool{}} }

func (h *sseHub) add() chan string {
	ch := make(chan string, 64)
	h.mu.Lock()
	h.clients[ch] = true
	h.mu.Unlock()
	return ch
}

func (h *sseHub) remove(ch chan string) {
	h.mu.Lock()
	if h.clients[ch] {
		delete(h.clients, ch)
		close(ch)
	}
	h.mu.Unlock()
}

func (h *sseHub) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

// broadcast sends a raw SSE frame to every client (dropping to a slow client's
// buffer is better than blocking the whole hub).
func (h *sseHub) broadcast(frame string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		select {
		case ch <- frame:
		default:
		}
	}
}

// serve streams frames to one client until it disconnects.
func (h *sseHub) serve(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ch := h.add()
	defer h.remove(ch)

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case frame, open := <-ch:
			if !open {
				return
			}
			if _, err := w.Write([]byte(frame)); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// agentDebugState is the current agent status snapshot + recent output lines.
type agentDebugState struct {
	mu      sync.Mutex
	current map[string]any
	lines   []string
}

const maxDebugLines = 200

func (d *agentDebugState) pushLine(line string) {
	d.mu.Lock()
	d.lines = append(d.lines, line)
	if len(d.lines) > maxDebugLines {
		d.lines = d.lines[len(d.lines)-maxDebugLines:]
	}
	d.mu.Unlock()
}

func (d *agentDebugState) snapshotLines() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.lines...)
}

// streamHub carries the agent output framing: the /events + /agent/stream hubs,
// the per-source sniffers, and the shared slice sequence.
type streamHub struct {
	events *sseHub
	agent  *sseHub

	debug agentDebugState

	mu       sync.Mutex
	sniffers map[string]*sniffer
	sliceSeq int
}

const agentSource = "agent"

var sliceAllowedOps = map[string]bool{"replace": true, "append": true, "prepend": true, "setAttr": true, "remove": true, "stream": true, "writeFile": true}
var sliceStreamingOps = map[string]bool{"stream": true, "replace": true, "append": true, "prepend": true}

func newStreamHub() *streamHub {
	return &streamHub{events: newSSEHub(), agent: newSSEHub(), sniffers: map[string]*sniffer{}}
}

// broadcastEvents sends a coarse reload ping. A nil payload is the bare
// "update" message server.js uses.
func (s *streamHub) broadcastEvents(payload any) {
	msg := "update"
	if payload != nil {
		b, _ := json.Marshal(payload)
		msg = string(b)
	}
	s.events.broadcast("data: " + msg + "\n\n")
}

func (s *streamHub) emitSlice(payload map[string]any) {
	b, _ := json.Marshal(payload)
	s.agent.broadcast("event: slice\ndata: " + string(b) + "\n\n")
}

func (s *streamHub) emitDebugEvent(payload map[string]any) {
	b, _ := json.Marshal(payload)
	s.agent.broadcast("event: " + payload["type"].(string) + "\ndata: " + string(b) + "\n\n")
}

// snifferFor returns (creating if needed) the sniffer for a producer source,
// wiring its framing callbacks to sequenced slice events.
func (s *streamHub) snifferFor(source string) *sniffer {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sn, ok := s.sniffers[source]; ok {
		return sn
	}
	nextSeq := func() int {
		s.sliceSeq++
		return s.sliceSeq
	}
	sn := newSniffer(snifferConfig{
		allowedOps:   sliceAllowedOps,
		streamingOps: sliceStreamingOps,
		onText:       func(text string) { s.emitSlice(map[string]any{"kind": "narration", "source": source, "text": text}) },
		onAtomic: func(attrs map[string]string, inner string) {
			s.emitSlice(map[string]any{"kind": "atomic", "seq": nextSeq(), "source": source, "attrs": attrs, "inner": inner})
		},
		onStreamOpen: func(attrs map[string]string) *streamHandle {
			seq := nextSeq()
			s.emitSlice(map[string]any{"kind": "open", "seq": seq, "source": source, "attrs": attrs})
			return &streamHandle{
				appendChunk: func(text string) { s.emitSlice(map[string]any{"kind": "chunk", "seq": seq, "text": text}) },
				closeFn:     func() { s.emitSlice(map[string]any{"kind": "close", "seq": seq}) },
			}
		},
		onReject: func(reason string, attrs map[string]string) {
			s.emitSlice(map[string]any{"kind": "reject", "seq": nextSeq(), "source": source, "reason": reason, "attrs": attrs})
		},
	})
	s.sniffers[source] = sn
	return sn
}

// serializeProducerChunk feeds a producer's output chunk into its sniffer.
func (s *streamHub) serializeProducerChunk(source, chunk string) {
	if chunk == "" {
		return
	}
	s.snifferFor(source).feed(chunk)
}

// dropSniffer clears a producer's sniffer (server.js serverSniffers.delete), so
// a half-open marker from a killed producer can't bleed into the next spawn.
func (s *streamHub) dropSniffer(source string) {
	s.mu.Lock()
	delete(s.sniffers, source)
	s.mu.Unlock()
}

// setCurrentAgentDebug records the agent status and, on the running->not-running
// edge, flushes the agent sniffer so trailing narration is emitted.
func (s *streamHub) setCurrentAgentDebug(next map[string]any) {
	s.debug.mu.Lock()
	prevStatus, _ := s.debug.current["status"].(string)
	current := map[string]any{}
	for k, v := range next {
		current[k] = v
	}
	if _, ok := current["source"]; !ok {
		current["source"] = agentSource
	}
	current["at"] = nowISO()
	s.debug.current = current
	nextStatus, _ := current["status"].(string)
	s.debug.mu.Unlock()

	if prevStatus == "running" && nextStatus != "" && nextStatus != "running" {
		s.mu.Lock()
		sn := s.sniffers[agentSource]
		s.mu.Unlock()
		if sn != nil {
			sn.end()
		}
	}
	s.emitDebugEvent(map[string]any{"type": "debug-status", "current": current})
}

func (s *streamHub) currentDebug() map[string]any {
	s.debug.mu.Lock()
	defer s.debug.mu.Unlock()
	return s.debug.current
}

var ansiRe = regexp.MustCompile("\x1b\\[[0-9;]*[A-Za-z]")

// writeProcessOutput logs an agent/service output chunk line-by-line and feeds
// the activity rail's debug lines (skipping blank/ansi-only lines).
func (s *streamHub) writeProcessOutput(label, chunk string) {
	normalized := strings.ReplaceAll(strings.ReplaceAll(chunk, "\r\n", "\n"), "\r", "\n")
	for _, line := range splitKeepNewline(normalized) {
		if line == "" {
			continue
		}
		if strings.TrimSpace(ansiRe.ReplaceAllString(line, "")) == "" {
			continue
		}
		s.debug.pushLine(line)
	}
}

// splitKeepNewline splits on newline boundaries keeping the trailing \n on each
// piece (JS split(/(?<=\n)/)).
func splitKeepNewline(text string) []string {
	var out []string
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			out = append(out, text[start:i+1])
			start = i + 1
		}
	}
	if start < len(text) {
		out = append(out, text[start:])
	}
	return out
}
