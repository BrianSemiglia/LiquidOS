#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
dispatch_id="${1:?missing dispatch id}"
runtime_dir="../../data/.runtime/${dispatch_id}"
log_path="${runtime_dir}/component.log"
mkdir -p "${runtime_dir}"
exec node render.js "${log_path}"
