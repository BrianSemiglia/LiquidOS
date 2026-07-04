package main

// modulegraph.go — Go port of canvas/module-graph.js.
//
// A canvas presentation is canvas.js plus the modules it imports, transitively.
// The server versions that subtree (versionImports) and walks it on disk
// (closure/closureVersion), always from the imports the code actually declares.
//
// The JS uses es-module-lexer (WASM) for byte-exact import offsets. We don't
// need those offsets: the JS `quoted ? e-1 : e` logic exists only to land the
// ?v= query INSIDE the specifier's closing quote for both static and dynamic
// imports. So a scanner that finds each module-specifier string literal and its
// closing-quote offset yields identical output — verified against the real
// module-graph.js over a battery in modulegraph_test.go.

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// encodeURIComponentJS matches JavaScript's encodeURIComponent: it escapes
// everything except the unreserved set A-Za-z0-9 and -_.!~*'() , encoding other
// bytes as uppercase %XX over UTF-8.
func encodeURIComponentJS(s string) string {
	const unreserved = "-_.!~*'()"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || strings.IndexByte(unreserved, c) >= 0 {
			b.WriteByte(c)
		} else {
			const hex = "0123456789ABCDEF"
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0f])
		}
	}
	return b.String()
}

func itoa64(n int64) string { return strconv.FormatInt(n, 10) }

// specifierRef is one module specifier string literal found in source.
type specifierRef struct {
	value      string // the specifier text, e.g. "./env.js"
	closeQuote int    // byte offset of its closing quote
}

func isRelativeSpecifier(s string) bool {
	return strings.HasPrefix(s, "./") || strings.HasPrefix(s, "../")
}

// Statement phases for scanSpecifiers. A specifier string is captured only
// inside a genuine import/export construct — never from a bare `from` or a
// string elsewhere — matching es-module-lexer.
type scanPhase int

const (
	phaseNone      scanPhase = iota // not in an import/export
	phaseAfterImp                   // saw `import` keyword; next string (bare) or `from`/`(` decides
	phaseAfterExp                   // saw `export` keyword; only a following `from` yields a specifier
	phaseExpectStr                  // saw `from`; the next string is the specifier
	phaseDynArg                     // saw `import(`; a sole string arg is the specifier
	phaseDynGotStr                  // saw the string in `import(`; only `)` next commits it
)

// scanSpecifiers finds every statically-known module specifier: the string
// literal of a static `import`/`export … from` (including bare `import "x"`)
// and of a sole-string-literal dynamic `import("x")`. It walks the source with
// a state machine so `import`-looking text inside comments, strings, or regex
// literals is ignored, and computed dynamic imports (import(base + x)) stay
// opaque — matching es-module-lexer.
func scanSpecifiers(source string) []specifierRef {
	var refs []specifierRef
	n := len(source)
	prevSignificant := byte(0) // last non-space code byte, for regex/division disambiguation
	phase := phaseNone
	var pendingDyn *specifierRef // a dynamic-import string awaiting its closing `)`

	i := 0
	for i < n {
		c := source[i]

		// Comments (don't change phase or prevSignificant).
		if c == '/' && i+1 < n && source[i+1] == '/' {
			i += 2
			for i < n && source[i] != '\n' {
				i++
			}
			continue
		}
		if c == '/' && i+1 < n && source[i+1] == '*' {
			i += 2
			for i+1 < n && !(source[i] == '*' && source[i+1] == '/') {
				i++
			}
			i += 2
			continue
		}

		// Regex literal — can't be a specifier; skip it.
		if c == '/' && regexCanFollow(prevSignificant) {
			i++
			inClass := false
			for i < n {
				if source[i] == '\\' {
					i += 2
					continue
				}
				if source[i] == '[' {
					inClass = true
				} else if source[i] == ']' {
					inClass = false
				} else if source[i] == '/' && !inClass {
					i++
					break
				} else if source[i] == '\n' {
					break
				}
				i++
			}
			prevSignificant = '/'
			continue
		}

		// String / template literal.
		if c == '"' || c == '\'' || c == '`' {
			start := i
			quote := c
			i++
			for i < n {
				if source[i] == '\\' {
					i += 2
					continue
				}
				if source[i] == quote {
					break
				}
				i++
			}
			if i < n { // a terminated literal
				ref := specifierRef{value: source[start+1 : i], closeQuote: i}
				switch phase {
				case phaseAfterImp, phaseExpectStr: // bare `import 'x'` or `… from 'x'`
					refs = append(refs, ref)
					phase = phaseNone
				case phaseDynArg: // `import( 'x'` — commit only if `)` follows
					pendingDyn = &ref
					phase = phaseDynGotStr
				default:
					phase = phaseNone
				}
			}
			prevSignificant = quote
			if i < n {
				i++
			}
			continue
		}

		// Whitespace.
		if c == ' ' || c == '\t' || c == '\r' || c == '\n' {
			i++
			continue
		}

		// Identifier / keyword.
		if isIdentStart(c) {
			start := i
			for i < n && isIdentPart(source[i]) {
				i++
			}
			word := source[start:i]
			switch word {
			case "import":
				phase = phaseAfterImp
			case "export":
				phase = phaseAfterExp
			case "from":
				if phase == phaseAfterImp || phase == phaseAfterExp {
					phase = phaseExpectStr
				}
				// A bare `from` outside an import/export head is not a specifier.
			default:
				// Any other identifier inside a dyn-arg means a computed
				// expression, not a sole string literal → opaque.
				if phase == phaseDynArg {
					phase = phaseNone
				}
			}
			prevSignificant = word[len(word)-1]
			continue
		}

		// Punctuation.
		switch {
		case c == '(' && phase == phaseAfterImp:
			phase = phaseDynArg // dynamic import
		case c == ')' && phase == phaseDynGotStr:
			refs = append(refs, *pendingDyn) // sole-string dynamic import commits
			pendingDyn = nil
			phase = phaseNone
		case c == ';':
			phase = phaseNone
		case phase == phaseDynArg || phase == phaseDynGotStr:
			// Any other punctuation in a dyn arg (`+`, `,`, …) → computed → opaque.
			phase = phaseNone
			pendingDyn = nil
		}
		prevSignificant = c
		i++
	}
	return refs
}

// regexCanFollow reports whether a `/` after prev starts a regex literal rather
// than a division. Regex follows nothing, an operator, or a grouping opener.
func regexCanFollow(prev byte) bool {
	switch prev {
	case 0, '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '/', '%', '<', '>', '~', '^':
		return true
	}
	return false
}

func isIdentStart(c byte) bool {
	return c == '_' || c == '$' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isIdentPart(c byte) bool {
	return isIdentStart(c) || (c >= '0' && c <= '9')
}

// versionImports rewrites every relative import specifier to carry ?v=token, so
// the module subtree loads under one token (canvas/module-graph.js).
func versionImports(source, token string) string {
	if token == "" {
		return source
	}
	query := "?v=" + encodeURIComponentJS(token)
	refs := scanSpecifiers(source)

	// Splice from the end so earlier offsets stay valid.
	out := source
	for i := len(refs) - 1; i >= 0; i-- {
		r := refs[i]
		if !isRelativeSpecifier(r.value) {
			continue
		}
		out = out[:r.closeQuote] + query + out[r.closeQuote:]
	}
	return out
}

// relativeSpecifiers returns the relative specifiers a source imports.
func relativeSpecifiers(source string) []string {
	var out []string
	for _, r := range scanSpecifiers(source) {
		if isRelativeSpecifier(r.value) {
			out = append(out, r.value)
		}
	}
	return out
}

// closure is the transitive set of files reachable from entry through relative
// imports (absolute, cleaned paths).
func closure(entry string) map[string]bool {
	seen := map[string]bool{}
	var walk func(file string)
	walk = func(file string) {
		normalized := filepath.Clean(file)
		if seen[normalized] {
			return
		}
		info, err := os.Stat(normalized)
		if err != nil || info.IsDir() {
			return
		}
		seen[normalized] = true
		data, err := os.ReadFile(normalized)
		if err != nil {
			return
		}
		dir := filepath.Dir(normalized)
		for _, spec := range relativeSpecifiers(string(data)) {
			walk(filepath.Join(dir, spec))
		}
	}
	walk(entry)
	return seen
}

// closureVersion is the newest mtime (ms) across the closure — the token that
// bumps whenever any module the presentation depends on changes; "" when the
// entry is absent.
func closureVersion(entry string) string {
	info, err := os.Stat(entry)
	if err != nil || info.IsDir() {
		return ""
	}
	var newest int64
	for file := range closure(entry) {
		if fi, err := os.Stat(file); err == nil {
			// JS uses mtimeMs (float ms); millisecond precision is enough for a
			// cache token and matches how the client compares it as a string.
			ms := fi.ModTime().UnixMilli()
			if ms > newest {
				newest = ms
			}
		}
	}
	return itoa64(newest)
}
