//
// lqpatch-sniffer.js
//
// Streams a token stream through a state machine that watches for
// `<lqpatch target="..." op="..." [attr=..] [value=..]>...</lqpatch>`
// markers. Anything outside a marker is narration. Anything inside is
// either buffered until the close tag (atomic ops) or written through
// chunk-by-chunk (op="stream", text-only).
//
// The caller wires the reducers — what to do with narration text and
// with each dispatched op — so the same sniffer drives both DOM
// playground pages and the live LiquidOS app.
//

// LLMs occasionally split the literal `lqpatch` name across a newline
// or whitespace boundary mid-token (we've seen `<lqpat\nch ...` in the
// wild). Match the tag name with optional whitespace between each
// character so we still recognize the marker no matter how it was
// chunked. The character class on the close tag's leading `/` covers
// the same risk on the closing side.
const OPEN_TAG_RE = /<\s*l\s*q\s*p\s*a\s*t\s*c\s*h\b/;
const CLOSE_TAG_RE = /<\s*\/\s*l\s*q\s*p\s*a\s*t\s*c\s*h\s*>/;
// Worst-case length of a partial open or close at a chunk seam: 1 (<) +
// 7 letters + 6 whitespace separators + a few char slack. Hold back
// this many bytes when no tag is found, in case the start of one is at
// the very tail of the buffer.
const TAG_TAIL_SLACK = 32;

const DEFAULT_ATOMIC_OPS = new Set(['replace', 'append', 'prepend', 'setAttr', 'remove', 'writeFile']);
const DEFAULT_STREAMING_OPS = new Set(['stream']);

// Tolerate whitespace (including newlines from chunk-seam splits) on
// both sides of `=` — Claude's token stream regularly splits mid-attr
// into chunks like `target\n="..."`. Standard HTML attr syntax allows
// the whitespace; the sniffer should too.
// HTML-decode common entities the agent emits when the value contains
// characters that would otherwise close the attribute (most often `"` →
// `&quot;` inside CSS attribute selectors like
// `liquidos-component[path="components/foo"] style`). Without this, those
// values reach `document.querySelector(...)` with literal `&quot;` in them,
// which is invalid CSS and the selector silently fails to match.
const decodeAttrValue = value => String(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const parseAttrs = (openTag) => {
    const attrs = {};
    openTag.replace(/(\w+)\s*=\s*"([^"]*)"/g, (_, key, val) => {
        attrs[key] = decodeAttrValue(val);
        return '';
    });
    return attrs;
};

//
// createSniffer({...}) → sniff(chunk) function with a .end() finalizer.
//
// onText(text)            — called with narration chunks (may be many small).
// onAtomic(attrs, inner)  — called once per non-streaming op at close tag.
// onStreamOpen(attrs)     — called once when an op="stream" patch opens;
//                           return an object with appendChunk(text) and
//                           close() callbacks, OR null to drop the stream.
// onReject(reason, attrs) — called for every patch that fails validation
//                           (unknown op, bad target, missing required attr).
// allowedOps              — Set of op names; default covers all built-ins.
// streamingOps            — Set of op names that should stream (no buffer).
// validate(attrs)         — optional extra check; return falsy to reject.
//
export const createSniffer = ({
    onText = () => {},
    onAtomic = () => {},
    onStreamOpen = () => null,
    onReject = () => {},
    allowedOps = DEFAULT_ATOMIC_OPS,
    streamingOps = DEFAULT_STREAMING_OPS,
    validate = () => true,
} = {}) => {
    let buf = '';
    // State: 'narration' | 'atomic' | 'streaming' | 'rejected'.
    let mode = 'narration';
    let openTag = '';
    let attrs = null;
    let inner = '';
    let streamHandle = null;

    const flushText = (text) => { if (text) onText(text); };

    const beginPatch = () => {
        attrs = parseAttrs(openTag);
        const op = attrs.op;
        if (!op || !allowedOps.has(op)) {
            onReject('unknown-op', attrs);
            mode = 'rejected';
            return;
        }
        if (!validate(attrs)) {
            onReject('validate-failed', attrs);
            mode = 'rejected';
            return;
        }
        if (streamingOps.has(op)) {
            streamHandle = onStreamOpen(attrs);
            if (!streamHandle) {
                onReject('stream-open-refused', attrs);
                mode = 'rejected';
                return;
            }
            mode = 'streaming';
        } else {
            mode = 'atomic';
            inner = '';
        }
    };

    const finishPatch = () => {
        if (mode === 'streaming' && streamHandle) {
            try { streamHandle.close && streamHandle.close(); } catch {}
            streamHandle = null;
        } else if (mode === 'atomic') {
            onAtomic(attrs, inner);
        }
        mode = 'narration';
        openTag = '';
        attrs = null;
        inner = '';
    };

    const sniff = (chunk) => {
        buf += chunk;
        while (buf.length) {
            if (mode === 'narration') {
                const m = buf.match(OPEN_TAG_RE);
                if (!m) {
                    // Hold back enough chars to recognize the open tag if
                    // it straddles the next chunk.
                    const safe = buf.length - TAG_TAIL_SLACK;
                    if (safe > 0) {
                        flushText(buf.slice(0, safe));
                        buf = buf.slice(safe);
                    }
                    return;
                }
                flushText(buf.slice(0, m.index));
                buf = buf.slice(m.index);
                const tagClose = buf.indexOf('>');
                if (tagClose === -1) return; // wait for more chunks
                openTag = buf.slice(0, tagClose + 1);
                buf = buf.slice(tagClose + 1);
                beginPatch();
            } else {
                // Inside a patch — atomic, streaming, or rejected. All three
                // wait for the close tag to leave the body.
                const m = buf.match(CLOSE_TAG_RE);
                if (!m) {
                    const safe = buf.length - TAG_TAIL_SLACK;
                    if (safe > 0) {
                        const part = buf.slice(0, safe);
                        if (mode === 'streaming' && streamHandle) {
                            try { streamHandle.appendChunk(part); } catch {}
                        } else if (mode === 'atomic') {
                            inner += part;
                        }
                        buf = buf.slice(safe);
                    }
                    return;
                }
                const part = buf.slice(0, m.index);
                if (mode === 'streaming' && streamHandle) {
                    try { streamHandle.appendChunk(part); } catch {}
                } else if (mode === 'atomic') {
                    inner += part;
                }
                buf = buf.slice(m.index + m[0].length);
                finishPatch();
            }
        }
    };

    sniff.end = () => {
        if (mode === 'narration' && buf.length) flushText(buf);
        buf = '';
    };

    return sniff;
};
