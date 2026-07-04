package main

// agent_bridge.go — the Go half of the agent bridge.
//
// The agent layer stays JS in a Node sidecar (agent/sidecar.js). This spawns
// that sidecar and drives the runtime facade over line-delimited JSON on stdio:
// each call() sends {id, method, args} and blocks until the id-matched reply
// arrives, so concurrent calls (a probe during a long run) are safe. Host
// events (agent output / status) arrive unsolicited and are handed to a sink.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
)

// hostEvent is an unsolicited notification from a running agent: streamed
// output, or a status/debug snapshot. Phase 4 wires output to the SSE broadcast
// and status to the current-agent debug snapshot.
type hostEvent struct {
	Type   string          `json:"type"`
	Label  string          `json:"label"`
	Chunk  string          `json:"chunk"`
	Stream string          `json:"stream"`
	Debug  json.RawMessage `json:"debug"`
}

type bridgeReply struct {
	ID     int             `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
	// present only on the one-time ready line
	Event             string `json:"event"`
	Selection         string `json:"selection"`
	RuntimePromptPath string `json:"runtimePromptPath"`
	Host              *struct {
		hostEvent
	} `json:"host"`
}

type agentBridge struct {
	cmd  *exec.Cmd
	stdin *bufio.Writer
	enc   *json.Encoder

	mu       sync.Mutex
	nextID   int
	pending  map[int]chan bridgeReply

	onHost func(hostEvent)

	// readyCh is closed exactly once — when the sidecar reports ready, or when
	// its stdout closes first (it died during boot), in which case readyErr is
	// set. readyOnce guards the close; readyErr is safe to read after the close
	// (happens-before via channel close).
	readyOnce sync.Once
	readyCh   chan struct{}
	readyErr  error

	// filled from the sidecar's ready line
	selection         string
	runtimePromptPath string
}

func (b *agentBridge) signalReady(err error) {
	b.readyOnce.Do(func() {
		b.readyErr = err
		close(b.readyCh)
	})
}

// startAgentBridge spawns the Node sidecar for the given agent scripts and
// blocks until it reports ready. app is ROOT (where agent/sidecar.js and
// skills/ live); agentScripts are app-relative or absolute, matching the CLI.
func startAgentBridge(app, workspace, selection string, agentScripts []string, onHost func(hostEvent)) (*agentBridge, error) {
	nodeBin := os.Getenv("LIQUIDOS_NODE")
	if nodeBin == "" {
		nodeBin = "node"
	}
	args := []string{
		filepath.Join(app, "agent", "sidecar.js"),
		"--workspace", workspace,
		"--app", app,
	}
	for _, a := range agentScripts {
		// Agent scripts ship with the app; resolve a relative path against the
		// app dir so callers can name them app-relative (boot-workspace-sandbox
		// parity), rather than against the sidecar's cwd.
		if !filepath.IsAbs(a) {
			a = filepath.Join(app, a)
		}
		args = append(args, "--agent", a)
	}
	if selection != "" {
		args = append(args, "--selection", selection)
	}

	cmd := exec.Command(nodeBin, args...)
	cmd.Dir = app // server.js runs with the app dir as cwd; the agent's own
	// working directory arrives per-run via context.workingDirectory.
	cmd.Stderr = os.Stderr

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	b := &agentBridge{
		cmd:     cmd,
		stdin:   bufio.NewWriter(stdinPipe),
		nextID:  1,
		pending: map[int]chan bridgeReply{},
		onHost:  onHost,
		readyCh: make(chan struct{}),
	}
	b.enc = json.NewEncoder(b.stdin)

	go b.readLoop(stdoutPipe)

	<-b.readyCh
	if b.readyErr != nil {
		b.close()
		return nil, b.readyErr
	}
	return b, nil
}

func (b *agentBridge) readLoop(r interface{ Read([]byte) (int, error) }) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024) // agent replies can be large
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var msg bridgeReply
		if err := json.Unmarshal(line, &msg); err != nil {
			fmt.Fprintf(os.Stderr, "agent bridge: bad reply: %s\n", line)
			continue
		}
		switch {
		case msg.Event == "ready":
			b.selection = msg.Selection
			b.runtimePromptPath = msg.RuntimePromptPath
			b.signalReady(nil)
		case msg.Event == "host":
			if b.onHost != nil && msg.Host != nil {
				b.onHost(msg.Host.hostEvent)
			}
		default: // id-matched method reply
			b.mu.Lock()
			ch := b.pending[msg.ID]
			delete(b.pending, msg.ID)
			b.mu.Unlock()
			if ch != nil {
				ch <- msg
			}
		}
	}
	// stdout closed. If it closed before the ready line, the sidecar died
	// during boot — unblock startAgentBridge with an error rather than hang.
	b.signalReady(errors.New("agent sidecar exited before ready (see stderr)"))

	// Fail any in-flight calls so callers don't hang.
	b.mu.Lock()
	for id, ch := range b.pending {
		ch <- bridgeReply{ID: id, OK: false, Error: "agent sidecar exited"}
		delete(b.pending, id)
	}
	b.mu.Unlock()
}

// call sends a method invocation and blocks for its reply. The raw JSON result
// is unmarshalled into out (may be nil to ignore the result).
func (b *agentBridge) call(method string, args any, out any) error {
	b.mu.Lock()
	id := b.nextID
	b.nextID++
	ch := make(chan bridgeReply, 1)
	b.pending[id] = ch
	req := map[string]any{"id": id, "method": method}
	if args != nil {
		req["args"] = args
	}
	err := b.enc.Encode(req) // Encoder writes a trailing newline (one line per call)
	if err == nil {
		err = b.stdin.Flush()
	}
	b.mu.Unlock()
	if err != nil {
		b.mu.Lock()
		delete(b.pending, id)
		b.mu.Unlock()
		return err
	}

	reply := <-ch
	if !reply.OK {
		return errors.New(reply.Error)
	}
	if out != nil && len(reply.Result) > 0 {
		return json.Unmarshal(reply.Result, out)
	}
	return nil
}

// Facade methods mirroring active-runtime.js.

func (b *agentBridge) probe() (json.RawMessage, error) {
	var raw json.RawMessage
	err := b.call("probe", nil, &raw)
	return raw, err
}

func (b *agentBridge) currentDebug() (json.RawMessage, error) {
	var raw json.RawMessage
	err := b.call("currentDebug", nil, &raw)
	return raw, err
}

func (b *agentBridge) activeKind() (string, error) {
	var kind string
	err := b.call("activeKind", nil, &kind)
	return kind, err
}

func (b *agentBridge) selectAgent(kind string) (json.RawMessage, error) {
	var raw json.RawMessage
	err := b.call("select", map[string]any{"kind": kind}, &raw)
	return raw, err
}

func (b *agentBridge) preparePrompt(prompt string) (string, error) {
	var out string
	err := b.call("preparePrompt", map[string]any{"prompt": prompt}, &out)
	return out, err
}

// run dispatches a prompt and blocks until the agent finishes, returning the
// final agentResponse string (server.js runQueuedAgentJob). context is the
// pure-JSON run context {job, canvasPath, indexPath, workingDirectory, origin,
// systemPromptPath}.
func (b *agentBridge) run(prompt string, context map[string]any) (string, error) {
	var out string
	err := b.call("run", map[string]any{"prompt": prompt, "context": context}, &out)
	return out, err
}

func (b *agentBridge) close() {
	if b.cmd != nil && b.cmd.Process != nil {
		b.stdin.Flush()
		b.cmd.Process.Kill()
		b.cmd.Wait()
	}
}
