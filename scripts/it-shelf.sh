#!/usr/bin/env bash
# Integration-test shelf: create an isolated hypatia shelf, run a command
# against it, then tear it down.
#
# Every hypatia invocation inside a test MUST go through `hyp`, which pins
# --shelf. The developer's own `default` shelf holds real memories; a command
# that forgets the flag would write into it.
#
#   scripts/it-shelf.sh <script-to-run>
#
# The inner script receives IT_SHELF (name) and IT_DIR (path), and should call
# the exported `hyp` wrapper rather than `hypatia` directly.
set -euo pipefail

IT_SHELF="dsh-auto-memory-it-$$"
IT_DIR="${TMPDIR:-/tmp}/hypatia-it-$$"
export IT_SHELF IT_DIR

cleanup() {
  hypatia disconnect "$IT_SHELF" >/dev/null 2>&1 || true
  rm -rf "$IT_DIR"
}
trap cleanup EXIT

mkdir -p "$IT_DIR"
hypatia connect "$IT_DIR" -n "$IT_SHELF" >/dev/null

# shellcheck disable=SC2317
hyp() { hypatia "$@" --shelf "$IT_SHELF"; }
export -f hyp

bash "$@"
