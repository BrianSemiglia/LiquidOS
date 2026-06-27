#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
dispatch_id="${1:?missing dispatch id}"
runtime_dir="../data/.runtime/${dispatch_id}"
log_path="${runtime_dir}/service.log"
io_binary="${runtime_dir}/IO"

mkdir -p "${runtime_dir}"
: > "${log_path}"

log() {
  printf '%s start.sh: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "${log_path}"
}

render_pid=""
io_pid=""

stop() {
  trap - TERM INT EXIT
  log "stopping component services"

  if [ -n "${render_pid}" ] && kill -0 "${render_pid}" 2>/dev/null; then
    kill -TERM "${render_pid}" 2>/dev/null || true
  fi

  if [ -n "${io_pid}" ] && kill -0 "${io_pid}" 2>/dev/null; then
    kill -TERM "${io_pid}" 2>/dev/null || true
  fi

  wait 2>/dev/null || true
}

trap stop TERM INT EXIT

# IO is a host-specific build artifact: compile it here, on the machine that
# runs it, into data/.runtime/ — a disposable per-host cache. Never commit or
# distribute the compiled binary; ship only IO.swift and let each host build it.
#
# Rebuild when the binary is missing or stale, AND when it arrived quarantined:
# a com.apple.quarantine attr means the binary came from elsewhere (a copied or
# downloaded workspace), so never trust it — it may not match the IO.swift you
# can read. Rebuilding from source guarantees the binary IS this IO.swift.
if [ ! -x "${io_binary}" ] \
   || [ IO.swift -nt "${io_binary}" ] \
   || xattr -p com.apple.quarantine "${io_binary}" >/dev/null 2>&1; then
  log "compiling IO.swift -> ${io_binary}"
  swiftc IO.swift -o "${io_binary}" -framework AVFoundation >> "${log_path}" 2>&1
  chmod +x "${io_binary}"
fi

# Fallback: a freshly compiled binary is never quarantined, but if one slipped
# through unbuilt (e.g. swiftc unavailable), strip the attr so macOS Gatekeeper
# doesn't block its launch with a separate "developer cannot be verified" prompt
# — a second approval on top of the app itself.
xattr -d com.apple.quarantine "${io_binary}" 2>/dev/null || true

node render.js >> "${log_path}" 2>&1 &
render_pid=$!

"${io_binary}" >> "${log_path}" 2>&1 &
io_pid=$!

log "started render pid=${render_pid} io pid=${io_pid} dispatch=${dispatch_id}"

while kill -0 "${render_pid}" 2>/dev/null && kill -0 "${io_pid}" 2>/dev/null; do
  sleep 2
done

log "child exited renderAlive=$(kill -0 "${render_pid}" 2>/dev/null && echo true || echo false) ioAlive=$(kill -0 "${io_pid}" 2>/dev/null && echo true || echo false)"
exit 1
