//
// module-graph.js — the canvas presentation module graph.
//
// A canvas's presentation is canvas.js plus the modules it imports, and those
// modules' imports, transitively. The server owns two jobs over that graph, both
// driven from the imports the code actually declares — never from file
// extensions or folder names:
//
//   * versionImports(source, token): when a module is served, every RELATIVE
//     import specifier is rewritten to carry the same ?v=token. So the whole
//     subtree loads under one token, and re-importing the root under a fresh
//     token re-fetches (and re-evaluates) every module beneath it — no stale
//     sibling from the browser's module cache. Authors write plain
//     `import './env.js'`; the versioning is the platform's job.
//
//   * closure(entry) / closureVersion(entry): follow those same imports on disk
//     to the transitive set of files the presentation depends on. The version is
//     the newest mtime across that set, so an edit anywhere in the graph bumps
//     the root token; a file nobody imports (state.json, data) is simply absent
//     from the set and never forces a reload.
//
// Only statically-known specifiers are visible — static imports and
// string-literal dynamic imports. A computed dynamic import (`import(base + x)`)
// is opaque by construction; such a module manages its own loading.
//
const path = require('path');
const { init, parse } = require('es-module-lexer');

// es-module-lexer compiles its WASM asynchronously. Until it's ready, parsing
// yields no imports — the graph degrades to "just the entry file", which is
// correct-but-conservative for the millisecond before init resolves at boot.
let ready = false;
init.then(() => { ready = true; });

const isRelative = specifier => specifier.startsWith('./') || specifier.startsWith('../');

const parseImports = source => {
    if (!ready) return [];
    try {
        return parse(source)[0];
    } catch {
        return [];
    }
};

// Relative specifiers this source imports (static + string-literal dynamic).
const relativeSpecifiers = source =>
    parseImports(source).map(entry => entry.n).filter(specifier => specifier && isRelative(specifier));

// Rewrite every relative import specifier to carry ?v=token, so the module
// subtree loads under one token. Splice from the end so earlier offsets stay
// valid. es-module-lexer bounds static specifiers inside the quotes and dynamic
// ones outside, so insert before the closing quote when e-1 is one.
const versionImports = (source, token) => {
    if (!ready || !token) return source;
    const query = '?v=' + encodeURIComponent(token);
    let out = source;
    const edits = parseImports(source)
        .filter(entry => entry.n && isRelative(entry.n))
        .map(entry => {
            const quoted = '"\'`'.includes(out[entry.e - 1]);
            return quoted ? entry.e - 1 : entry.e;
        })
        .sort((a, b) => b - a);
    for (const at of edits) out = out.slice(0, at) + query + out.slice(at);
    return out;
};

// The transitive set of files reachable from `entry` through relative imports.
const closure = (fs, entry) => {
    const seen = new Set();
    const walk = file => {
        const normalized = path.normalize(file);
        if (seen.has(normalized)) return;
        if (!fs.existsSync(normalized) || fs.statSync(normalized).isDirectory()) return;
        seen.add(normalized);
        let source;
        try { source = fs.readFileSync(normalized, 'utf8'); } catch { return; }
        for (const specifier of relativeSpecifiers(source)) {
            walk(path.resolve(path.dirname(normalized), specifier));
        }
    };
    walk(entry);
    return seen;
};

// The newest mtime across the closure — the token that bumps whenever any module
// the presentation depends on changes. '' when the entry itself is absent.
const closureVersion = (fs, entry) => {
    if (!fs.existsSync(entry) || fs.statSync(entry).isDirectory()) return '';
    let newest = 0;
    for (const file of closure(fs, entry)) newest = Math.max(newest, fs.statSync(file).mtimeMs);
    return String(newest);
};

module.exports = { versionImports, closure, closureVersion };
