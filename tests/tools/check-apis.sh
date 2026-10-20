#!/usr/bin/env bash
# Runs every test file that replays recorded API responses (useRecordedHttp)
# against the live APIs instead, recording into a temporary folder, so the
# fixtures in tests/fixtures/http stay as they are. A failure is either an API
# that changed shape (fix the code, then re-record that file for real) or a test
# pinning data that moved on (a newer release, a file past the mirror's newest
# 50): re-recording that file with RECORD_HTTP=1 and updating its expectation is
# the fix. Run it before a release, or when a provider is suspected of changing.
#
#   tests/tools/check-apis.sh [vitest args, e.g. a file filter]
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
out="$(mktemp -d "${TMPDIR:-/tmp}/mineshell-apis-XXXXXX")"
trap 'rm -rf -- "$out"' EXIT
mapfile -t files < <(grep -rl 'useRecordedHttp(' src tests --include='*.test.ts' | sort)
RECORD_HTTP=1 RECORD_HTTP_DIR="$out" npx vitest run "${files[@]}" "$@"
