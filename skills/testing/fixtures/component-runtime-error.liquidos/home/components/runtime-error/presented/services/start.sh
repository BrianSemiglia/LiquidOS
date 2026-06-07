#!/usr/bin/env bash
# Minimal no-op service that just stays alive. The fixture needs a
# services/ folder so the probe can edit a file inside and exercise the
# documented "edits inside presented/services/ restart the service"
# trigger. We don't actually need a working service for the test.
exec sleep 86400
