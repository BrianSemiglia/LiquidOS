#!/usr/bin/env node
//
// add-suggestions.mjs — append next-prompt ideas to a canvas's suggestions.
//
// Usage:
//   node skills/suggestions/scripts/add-suggestions.mjs <canvas> "idea one" "idea two" ...
//
// The agent runs with the workspace as its CWD, so the first argument is just
// the canvas (its folder name, e.g. "gadgets") — the script owns the file name
// and writes to <canvas>/suggestions.json, creating it if needed. Every
// remaining argument is one suggestion — a single tappable prompt in the
// user's own voice, e.g. "Add fireflies near the campfire at night".
//
// The list is a FIFO queue capped at 50. New ideas go to the front (so the
// freshest, most-contextual suggestions surface first); when the list would
// exceed 50, the oldest at the back are dropped. Re-adding an existing idea
// moves it back to the front rather than duplicating it.
//
import fs from 'node:fs';
import path from 'node:path';

const MAX = 50;

const [canvas, ...incomingRaw] = process.argv.slice(2);

if (!canvas || incomingRaw.length === 0) {
    console.error('usage: add-suggestions.mjs <canvas> "idea" ["idea" ...]');
    process.exit(1);
}

// The agent passes only the canvas; the script owns the file name.
const file = path.resolve(process.cwd(), canvas, 'suggestions.json');

// Incoming: trim, drop blanks, dedupe within this batch (keep first occurrence).
const seen = new Set();
const incoming = [];
for (const raw of incomingRaw) {
    const idea = String(raw).trim();
    if (!idea || seen.has(idea)) continue;
    seen.add(idea);
    incoming.push(idea);
}

// Existing list (tolerate a missing or malformed file — treat as empty).
let existing = [];
try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) {
        existing = parsed.filter(s => typeof s === 'string' && s.trim().length);
    }
} catch {
    // missing / invalid → start fresh
}

// Newest first; an idea already present is refreshed to the front, not doubled.
const merged = [...incoming, ...existing.filter(s => !seen.has(s))];
const capped = merged.slice(0, MAX);   // FIFO: oldest (tail) drops once over MAX

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(capped, null, 2) + '\n');

const dropped = merged.length - capped.length;
console.log(
    `Added ${incoming.length} → ${capped.length} suggestion(s) for canvas "${canvas}"` +
    (dropped > 0 ? ` (${dropped} oldest dropped, capped at ${MAX})` : '')
);
