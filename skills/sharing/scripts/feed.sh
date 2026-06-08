#!/bin/bash
set -euo pipefail

#
# feed.sh — produce a feed.json from a directory of published bundles.
#
# Usage:
#   bash skills/share/scripts/feed.sh <published-dir> [output-path]
#
# Walks every immediate subdirectory of <published-dir> that looks
# like a bundle (has feature-requirements.txt) and emits a JSON
# manifest listing each one: name, canvas-level requirements text
# (inline), component requirements (inline), and the content hash.
#

PUBLISHED_DIR="${1:-}"
OUTPUT_PATH="${2:-${PUBLISHED_DIR:+$PUBLISHED_DIR/feed.json}}"

if [ -z "$PUBLISHED_DIR" ]; then
    echo "Usage: $0 <published-dir> [output-path]" >&2
    echo "" >&2
    echo "Produces a feed.json describing each bundle in <published-dir>." >&2
    echo "Default output-path is <published-dir>/feed.json." >&2
    exit 1
fi

if [ ! -d "$PUBLISHED_DIR" ]; then
    echo "Error: published directory does not exist: $PUBLISHED_DIR" >&2
    exit 1
fi

PUBLISHED_DIR="$(cd "$PUBLISHED_DIR" && pwd)"

# Collect bundle directories. A bundle is any immediate subdirectory
# with a feature-requirements.txt at its root.
BUNDLE_DIRS=()
for D in "$PUBLISHED_DIR"/*/; do
    [ -d "$D" ] || continue
    if [ -f "$D/feature-requirements.txt" ]; then
        BUNDLE_DIRS+=("${D%/}")
    fi
done

if [ "${#BUNDLE_DIRS[@]}" -eq 0 ]; then
    # Empty but valid feed — useful for "I've published nothing yet."
    node -e '
process.stdout.write(JSON.stringify({
    feedVersion: 1,
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
// whole thing.
const hashBundle = (root) => {
    const hash = crypto.createHash("sha256");
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
            }
        }
    };
    walk(root, "");
    return "sha256-" + hash.digest("hex");
};

const listComponents = (root) => {
    const compDir = path.join(root, "components");
    if (!fs.existsSync(compDir)) return [];
    return fs.readdirSync(compDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(e => ({
            name: e.name,
            requirements: readText(path.join(compDir, e.name, "feature-requirements.txt"))
        }));
};

const entries = bundles.map(b => ({
    name: path.basename(b),
    canvasRequirements: readText(path.join(b, "feature-requirements.txt")),
    components: listComponents(b),
    hash: hashBundle(b)
}));

const feed = {
    feedVersion: 1,
    bundles: entries
};

process.stdout.write(JSON.stringify(feed, null, 2) + "\n");
' "${BUNDLE_DIRS[@]}" > "$OUTPUT_PATH"

# Echo the output path to stderr so a caller can tell where it landed
# without parsing stdout. stdout is the JSON itself for piping.
echo "$OUTPUT_PATH" >&2
cat "$OUTPUT_PATH"
