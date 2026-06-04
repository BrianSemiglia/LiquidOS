#!/bin/bash
set -euo pipefail

#
# publish.sh — install a bundle into the workspace's .share/ tree so the
# libp2p node can serve it to other peers.
#
# Usage:
#   bash skills/workspace/share/publish.sh <bundle-dir> <workspace.liquidos>
#
# What it does:
#
#   1. Validates that <bundle-dir> looks like a bundle (has
#      requirements.txt). Optionally requires canvas-subtitle.txt
#      and canvas-tags.txt to be present and non-empty — those are the
#      feed metadata other peers will browse before downloading.
#
#   2. Copies the bundle into <workspace>/.share/published/<name>/.
#      (Overwrites any existing version of the same name; publishing
#      with an updated bundle is "republish.")
#
#   3. Computes the bundle's content hash via the same deterministic
#      walk feed.sh uses (sorted entries, null-separated rel-path +
#      bytes, sha256). The hash is the bundle's identity.
#
#   4. Tarballs the bundle into <workspace>/.share/bundles/<hash>.tar.
#      The tarball format itself isn't deterministic on macOS bsdtar
#      out of the box — that's fine, because the bundle's identity is
#      the hash of its CONTENTS, not the hash of the tarball. Receivers
#      unpack and re-walk to verify.
#
#   5. Regenerates <workspace>/.share/feed.json by running feed.sh on
#      .share/published/.
#
# The libp2p protocols registered by the harness (FEED_PROTOCOL and
# BUNDLE_PROTOCOL) read from this same .share/ tree — once publish.sh
# completes, the bundle is reachable by any peer who knows your peer ID.
#

BUNDLE_DIR="${1:-}"
WORKSPACE_DIR="${2:-${LIQUIDOS_WORKSPACE:-}}"

if [ -z "$BUNDLE_DIR" ] || [ -z "$WORKSPACE_DIR" ]; then
    echo "Usage: $0 <bundle-dir> <workspace.liquidos>" >&2
    exit 1
fi

if [ ! -d "$BUNDLE_DIR" ]; then
    echo "Error: bundle does not exist: $BUNDLE_DIR" >&2
    exit 1
fi

BUNDLE_DIR="$(cd "$BUNDLE_DIR" && pwd)"

if [ ! -f "$BUNDLE_DIR/requirements.txt" ]; then
    echo "Error: not a valid bundle (missing requirements.txt): $BUNDLE_DIR" >&2
    exit 1
fi

if [ ! -d "$WORKSPACE_DIR" ]; then
    echo "Error: workspace does not exist: $WORKSPACE_DIR" >&2
    exit 1
fi

WORKSPACE_DIR="$(cd "$WORKSPACE_DIR" && pwd)"

case "$WORKSPACE_DIR" in
    *.liquidos) ;;
    *)
        echo "Error: workspace must be a .liquidos folder: $WORKSPACE_DIR" >&2
        exit 1
        ;;
esac

BUNDLE_NAME="$(basename "$BUNDLE_DIR")"
SHARE_DIR="$WORKSPACE_DIR/.share"
PUBLISHED_DIR="$SHARE_DIR/published"
BUNDLES_DIR="$SHARE_DIR/bundles"
PUBLISHED_BUNDLE="$PUBLISHED_DIR/$BUNDLE_NAME"

mkdir -p "$PUBLISHED_DIR" "$BUNDLES_DIR"

# Copy (overwriting) the bundle into the published tree.
rm -rf "$PUBLISHED_BUNDLE"
cp -R "$BUNDLE_DIR" "$PUBLISHED_BUNDLE"

# Compute the bundle's content hash. Mirror feed.sh's deterministic
# walk: sorted entries, null-separated rel-path + bytes, sha256.
HASH="$(node -e '
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const root = process.argv[1];
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
process.stdout.write("sha256-" + hash.digest("hex"));
' "$PUBLISHED_BUNDLE")"

# Tar the bundle. Bundle name lands at the tar archive's root, so an
# unpacker can pipe into tar -xf and get back a directory matching the
# original bundle.
(cd "$PUBLISHED_DIR" && tar -cf "$BUNDLES_DIR/$HASH.tar" "$BUNDLE_NAME")

# Regenerate the feed from all published bundles.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/feed.sh" "$PUBLISHED_DIR" "$SHARE_DIR/feed.json" >/dev/null

# One-line JSON summary on stdout.
node -e '
const name = process.argv[1];
const hash = process.argv[2];
const tarPath = process.argv[3];
const feedPath = process.argv[4];
process.stdout.write(JSON.stringify({
    name, hash, tarPath, feedPath
}) + "\n");
' "$BUNDLE_NAME" "$HASH" "$BUNDLES_DIR/$HASH.tar" "$SHARE_DIR/feed.json"
