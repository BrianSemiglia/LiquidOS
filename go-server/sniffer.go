package main

// sniffer.go — Go port of lib/lqpatch-sniffer.js.
//
// Streams a token stream through a state machine watching for
// <lqpatch target=".." op=".." ...>...</lqpatch> markers. Text outside a marker
// is narration; inside is buffered until the close tag (atomic ops) or written
// through chunk-by-chunk (streaming ops). Tag names tolerate whitespace between
// characters because LLM token streams split `lqpatch` mid-name at chunk seams.

import (
	"regexp"
	"strings"
)

var openTagRe = regexp.MustCompile(`<\s*l\s*q\s*p\s*a\s*t\s*c\s*h\b`)
var closeTagRe = regexp.MustCompile(`<\s*/\s*l\s*q\s*p\s*a\s*t\s*c\s*h\s*>`)
var attrRe = regexp.MustCompile(`(\w+)\s*=\s*"([^"]*)"`)

// tagTailSlack is how many bytes to hold back when no tag is found, in case the
// start of one straddles the next chunk.
const tagTailSlack = 32

func decodeAttrValue(value string) string {
	r := strings.NewReplacer("&quot;", `"`, "&apos;", "'", "&lt;", "<", "&gt;", ">", "&amp;", "&")
	return r.Replace(value)
}

func parseAttrs(openTag string) map[string]string {
	attrs := map[string]string{}
	for _, m := range attrRe.FindAllStringSubmatch(openTag, -1) {
		attrs[m[1]] = decodeAttrValue(m[2])
	}
	return attrs
}

type streamHandle struct {
	appendChunk func(string)
	closeFn     func()
}

type snifferConfig struct {
	onText       func(string)
	onAtomic     func(attrs map[string]string, inner string)
	onStreamOpen func(attrs map[string]string) *streamHandle
	onReject     func(reason string, attrs map[string]string)
	allowedOps   map[string]bool
	streamingOps map[string]bool
	validate     func(attrs map[string]string) bool
}

type sniffer struct {
	cfg          snifferConfig
	buf          string
	mode         string // narration | atomic | streaming | rejected
	openTag      string
	attrs        map[string]string
	inner        string
	streamHandle *streamHandle
}

func newSniffer(cfg snifferConfig) *sniffer {
	if cfg.onText == nil {
		cfg.onText = func(string) {}
	}
	if cfg.onAtomic == nil {
		cfg.onAtomic = func(map[string]string, string) {}
	}
	if cfg.onStreamOpen == nil {
		cfg.onStreamOpen = func(map[string]string) *streamHandle { return nil }
	}
	if cfg.onReject == nil {
		cfg.onReject = func(string, map[string]string) {}
	}
	if cfg.allowedOps == nil {
		cfg.allowedOps = map[string]bool{"replace": true, "append": true, "prepend": true, "setAttr": true, "remove": true, "writeFile": true}
	}
	if cfg.streamingOps == nil {
		cfg.streamingOps = map[string]bool{"stream": true}
	}
	if cfg.validate == nil {
		cfg.validate = func(map[string]string) bool { return true }
	}
	return &sniffer{cfg: cfg, mode: "narration"}
}

func (s *sniffer) flushText(text string) {
	if text != "" {
		s.cfg.onText(text)
	}
}

func (s *sniffer) beginPatch() {
	s.attrs = parseAttrs(s.openTag)
	op := s.attrs["op"]
	if op == "" || !s.cfg.allowedOps[op] {
		s.cfg.onReject("unknown-op", s.attrs)
		s.mode = "rejected"
		return
	}
	if !s.cfg.validate(s.attrs) {
		s.cfg.onReject("validate-failed", s.attrs)
		s.mode = "rejected"
		return
	}
	if s.cfg.streamingOps[op] {
		s.streamHandle = s.cfg.onStreamOpen(s.attrs)
		if s.streamHandle == nil {
			s.cfg.onReject("stream-open-refused", s.attrs)
			s.mode = "rejected"
			return
		}
		s.mode = "streaming"
	} else {
		s.mode = "atomic"
		s.inner = ""
	}
}

func (s *sniffer) finishPatch() {
	if s.mode == "streaming" && s.streamHandle != nil {
		if s.streamHandle.closeFn != nil {
			s.streamHandle.closeFn()
		}
		s.streamHandle = nil
	} else if s.mode == "atomic" {
		s.cfg.onAtomic(s.attrs, s.inner)
	}
	s.mode = "narration"
	s.openTag = ""
	s.attrs = nil
	s.inner = ""
}

func (s *sniffer) feed(chunk string) {
	s.buf += chunk
	for len(s.buf) > 0 {
		if s.mode == "narration" {
			loc := openTagRe.FindStringIndex(s.buf)
			if loc == nil {
				safe := len(s.buf) - tagTailSlack
				if safe > 0 {
					s.flushText(s.buf[:safe])
					s.buf = s.buf[safe:]
				}
				return
			}
			s.flushText(s.buf[:loc[0]])
			s.buf = s.buf[loc[0]:]
			tagClose := strings.IndexByte(s.buf, '>')
			if tagClose == -1 {
				return // wait for more chunks
			}
			s.openTag = s.buf[:tagClose+1]
			s.buf = s.buf[tagClose+1:]
			s.beginPatch()
		} else {
			loc := closeTagRe.FindStringIndex(s.buf)
			if loc == nil {
				safe := len(s.buf) - tagTailSlack
				if safe > 0 {
					part := s.buf[:safe]
					if s.mode == "streaming" && s.streamHandle != nil {
						s.streamHandle.appendChunk(part)
					} else if s.mode == "atomic" {
						s.inner += part
					}
					s.buf = s.buf[safe:]
				}
				return
			}
			part := s.buf[:loc[0]]
			if s.mode == "streaming" && s.streamHandle != nil {
				s.streamHandle.appendChunk(part)
			} else if s.mode == "atomic" {
				s.inner += part
			}
			s.buf = s.buf[loc[1]:]
			s.finishPatch()
		}
	}
}

func (s *sniffer) end() {
	if s.mode == "narration" && s.buf != "" {
		s.flushText(s.buf)
	}
	s.buf = ""
}
