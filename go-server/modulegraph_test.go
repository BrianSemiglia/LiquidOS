package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// nodeVersionImports runs the REAL canvas/module-graph.js versionImports over a
// source, so the Go port can be checked for byte-exact parity against it.
func nodeVersionImports(t *testing.T, app, source, token string) string {
	t.Helper()
	script := `
const { versionImports } = require(process.argv[1]);
const { init } = require('es-module-lexer');
init.then(() => {
  let src = '';
  process.stdin.on('data', d => src += d);
  process.stdin.on('end', () => process.stdout.write(versionImports(src, process.argv[2])));
});
`
	cmd := exec.Command("node", "-e", script, filepath.Join(app, "canvas", "module-graph.js"), token)
	cmd.Dir = app
	cmd.Stdin = strings.NewReader(source)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("node versionImports: %v", err)
	}
	return string(out)
}

func TestVersionImportsParity(t *testing.T) {
	wd, _ := os.Getwd()
	app := filepath.Dir(wd)

	cases := []struct {
		name, src, token string
	}{
		{"static-default", `import env from './env.js';\nconsole.log(env);`, "abc"},
		{"static-named", "import { a, b } from './lib/util.js'\nimport x from '../shared.js'", "v1"},
		{"bare-import", `import './styles.css';`, "t"},
		{"export-from", `export { thing } from './thing.js';\nexport * from './all.js';`, "9"},
		{"dynamic", "const m = await import('./lazy.js');", "tok"},
		{"double-quotes", `import a from "./a.js";`, "x"},
		{"bare-specifier-untouched", `import react from 'react';\nimport x from './x.js';`, "z"},
		{"import-in-line-comment", "// import fake from './nope.js'\nimport real from './real.js';", "c"},
		{"import-in-block-comment", "/* import fake from './nope.js' */\nimport real from './real.js';", "c"},
		{"import-word-in-string", `const s = "please import from './fake.js'";\nimport real from './real.js';`, "c"},
		{"template-literal", "const t = `import from './fake.js'`;\nimport real from './real.js';", "c"},
		{"token-needs-encoding", `import x from './x.js';`, "a b/c?d"},
		{"no-token", `import x from './x.js';`, ""},
		{"regex-with-quote", "const re = /['\"]/;\nimport x from './x.js';", "c"},
		{"mixed", "import a from './a.js';\nimport 'bare';\nexport * from '../b.js';\nconst c = import(\"./c.js\");", "MIX"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			want := nodeVersionImports(t, app, tc.src, tc.token)
			got := versionImports(tc.src, tc.token)
			if got != want {
				t.Errorf("versionImports mismatch\n src:  %q\n want: %q\n got:  %q", tc.src, want, got)
			}
		})
	}
}
