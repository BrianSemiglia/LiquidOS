#!/bin/bash
set -euo pipefail

#
# feed.sh — produce a feed.json from a directory of bundles.
#
# Usage:
#   bash skills/share-app/scripts/feed.sh <bundles-dir> [output-path]
#
# Walks every immediate subdirectory of <bundles-dir> that looks like a
# bundle (has canvas-requirements.txt) and emits a JSON manifest listing
# each one with the metadata needed to BROWSE the feed without
# downloading the bundles themselves: name, subtitle, tags, the canvas-
# requirements text, the list of component names, a content hash, and
# size.
#
# This is what a peer would serve at /share/feed (when the network
# layer lands) and what other peers would pull to decide which bundles
# to fetch in full.
#

BUNDLES_DIR="${1:-}"
OUTPUT_PATH="${2:-${BUNDLES_DIR:+$BUNDLES_DIR/feed.json}}"

if [ -z "$BUNDLES_DIR" ]; then
    echo "Usage: $0 <bundles-dir> [output-path]" >&2
    echo "" >&2
    echo "Produces a feed.json describing each bundle in <bundles-dir>." >&2
    echo "Default output-path is <bundles-dir>/feed.json." >&2
    exit 1
fi

if [ ! -d "$BUNDLES_DIR" ]; then
    echo "Error: bundles directory does not exist: $BUNDLES_DIR" >&2
    exit 1
fi

BUNDLES_DIR="$(cd "$BUNDLES_DIR" && pwd)"

# Collect bundle directories. A bundle is any immediate subdirectory
# with a canvas-requirements.txt at its root.
BUNDLE_DIRS=()
for D in "$BUNDLES_DIR"/*/; do
    [ -d "$D" ] || continue
    if [ -f "$D/canvas-requirements.txt" ]; then
        BUNDLE_DIRS+=("${D%/}")
    fi
done

if [ "${#BUNDLE_DIRS[@]}" -eq 0 ]; then
    # Empty but valid feed — useful for "I've published nothing yet."
    node -e '
process.stdout.write(JSON.stringify({
    feedVersion: 1,
    generatedAt: new Date().toISOString(),
    bundles: []
}, null, 2) + "\n");
' > "$OUTPUT_PATH"
    echo "$OUTPUT_PATH" >&2
    cat "$OUTPUT_PATH"
    exit 0
fi

# Build the manifest. One Node invocation does the JSON heavy lifting
# (file reads, hashing, listing components, assembling the object) and
# emits the final JSON.
node -e '
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const bundles = process.argv.slice(1);

const readText = (p) => {
    try { return fs.readFileSync(p, "utf8"); }
    catch { return ""; }
};

// Deterministic content hash: walk the bundle tree in sorted order,
// concatenating relative-path + null + bytes for each file. sha256 the
// whole thing. Same shape any well-behaved implementation can produce
// — no platform-dependent quirks.
const hashBundle = (root) => {
    const hash = crypto.createHash("sha256");
    let totalSize = 0;
    const walk = (dir, rel) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            const sub = rel ? rel + "/" + entry.name : entry.name;
            if (entry.isDirectory()) {
                walk(full, sub);
            } else if (entry.isFile()) {
                const buf = fs.readFileSync(full);
                hash.update(sub);
                hash.update(Buffer.from([0]));
                hash.update(buf);
                totalSize += buf.length;
            }
        }
    };
    walk(root, "");
    return { hash: "sha256-" + hash.digest("hex"), size: totalSize };
};

const listComponents = (root) => {
    const compDir = path.join(root, "components");
    if (!fs.existsSync(compDir)) return [];
    return fs.readdirSync(compDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(e => {
            // Each component ships its verbatim feature-requirements.txt
            // inline so a browser can read what the bundle offers
            // before downloading. Files are small (a few hundred bytes
            // each, typically) so the feed stays cheap to fetch.
            const reqFile = path.join(compDir, e.name, "feature-requirements.txt");
            const requirements = readText(reqFile);
            return { name: e.name, requirements };
        });
};

const parseTags = (s) =>
    s.split(/\r?\n/).map(t => t.trim()).filter(Boolean);

const entries = bundles.map(b => {
    const { hash, size } = hashBundle(b);
    return {
        name: path.basename(b),
        subtitle: readText(path.join(b, "canvas-subtitle.txt")).trim(),
        tags: parseTags(readText(path.join(b, "canvas-tags.txt"))),
        canvasRequirements: readText(path.join(b, "canvas-requirements.txt")),
        components: listComponents(b),
        hash,
        size,
        createdAt: fs.statSync(b).birthtime.toISOString()
    };
});

const feed = {
    feedVersion: 1,
    generatedAt: new Date().toISOString(),
    bundles: entries
};

process.stdout.write(JSON.stringify(feed, null, 2) + "\n");
' "${BUNDLE_DIRS[@]}" > "$OUTPUT_PATH"

# Echo the output path to stderr so a caller can tell where it landed
# without parsing stdout. stdout is the JSON itself for piping.
echo "$OUTPUT_PATH" >&2
cat "$OUTPUT_PATH"
