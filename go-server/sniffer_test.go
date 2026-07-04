package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// goSniffEvents runs the Go sniffer over chunks with the server's op sets and
// records events in a compact comparable form.
func goSniffEvents(chunks []string) []string {
	var events []string
	allowed := map[string]bool{"replace": true, "append": true, "prepend": true, "setAttr": true, "remove": true, "stream": true, "writeFile": true}
	streaming := map[string]bool{"stream": true, "replace": true, "append": true, "prepend": true}
	s := newSniffer(snifferConfig{
		onText:   func(t string) { events = append(events, "T:"+t) },
		onAtomic: func(a map[string]string, inner string) { events = append(events, "A:"+a["op"]+":"+a["target"]+":"+inner) },
		onStreamOpen: func(a map[string]string) *streamHandle {
			events = append(events, "O:"+a["op"]+":"+a["target"])
			return &streamHandle{
				appendChunk: func(t string) { events = append(events, "C:"+t) },
				closeFn:     func() { events = append(events, "X") },
			}
		},
		onReject:     func(reason string, a map[string]string) { events = append(events, "R:"+reason+":"+a["op"]) },
		allowedOps:   allowed,
		streamingOps: streaming,
	})
	for _, c := range chunks {
		s.feed(c)
	}
	s.end()
	if events == nil {
		events = []string{}
	}
	return events
}

func nodeSniffEvents(t *testing.T, app string, chunks []string) []string {
	t.Helper()
	// lqpatch-sniffer.js is ESM; dynamic import() works from a CommonJS eval.
	script := `
import(process.argv[1]).then(({ createSniffer }) => {
  const events = [];
  const allowed = new Set(['replace','append','prepend','setAttr','remove','stream','writeFile']);
  const streaming = new Set(['stream','replace','append','prepend']);
  const sniff = createSniffer({
    onText: t => events.push('T:'+t),
    onAtomic: (a, inner) => events.push('A:'+a.op+':'+(a.target||'')+':'+inner),
    onStreamOpen: a => { events.push('O:'+a.op+':'+(a.target||'')); return { appendChunk: t => events.push('C:'+t), close: () => events.push('X') }; },
    onReject: (reason, a) => events.push('R:'+reason+':'+(a.op||'')),
    allowedOps: allowed, streamingOps: streaming,
  });
  let raw = '';
  process.stdin.on('data', d => raw += d);
  process.stdin.on('end', () => {
    const chunks = JSON.parse(raw);
    for (const c of chunks) sniff(c);
    sniff.end();
    process.stdout.write(JSON.stringify(events));
  });
});
`
	cmd := exec.Command("node", "-e", script, filepath.Join(app, "lib", "lqpatch-sniffer.js"))
	cmd.Dir = app
	payload, _ := json.Marshal(chunks)
	cmd.Stdin = strings.NewReader(string(payload))
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("node sniffer: %v", err)
	}
	var events []string
	if err := json.Unmarshal(out, &events); err != nil {
		t.Fatalf("unmarshal node events: %v\n%s", err, out)
	}
	return events
}

func TestSnifferParity(t *testing.T) {
	wd, _ := os.Getwd()
	app := filepath.Dir(wd)

	cases := map[string][]string{
		"narration only":     {"hello ", "world"},
		"atomic setAttr":     {`before <lqpatch target="components/foo" op="setAttr" attr="hidden" value="true"></lqpatch> after`},
		"streaming replace":  {`<lqpatch target="c/foo" op="replace">chunk-one`, ` chunk-two</lqpatch>done`},
		"unknown op reject":  {`x <lqpatch target="t" op="frobnicate">body</lqpatch> y`},
		"tag split mid-name": {`narrate <lqp`, `atch target="c/foo" op="stream">a`, `b</lqp`, `atch>tail`},
		"attr split mid-val": {`<lqpatch target`, `="c/foo" op="setAttr" attr="x" val`, `ue="1"></lqpatch>`},
		"entity decode":      {`<lqpatch target="a[path=&quot;c/foo&quot;]" op="remove"></lqpatch>`},
		"two patches":        {`<lqpatch target="a" op="append">one</lqpatch>mid<lqpatch target="b" op="prepend">two</lqpatch>`},
	}

	for name, chunks := range cases {
		t.Run(name, func(t *testing.T) {
			want := nodeSniffEvents(t, app, chunks)
			got := goSniffEvents(chunks)
			if !reflect.DeepEqual(got, want) {
				t.Errorf("sniffer mismatch\n chunks: %q\n want: %#v\n got:  %#v", chunks, want, got)
			}
		})
	}
}
