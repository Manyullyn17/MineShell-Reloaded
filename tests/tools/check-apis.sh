#!/usr/bin/env bash
# Runs every test file that replays recorded API responses (useRecordedHttp)
# against the live APIs instead, recording into a temporary folder, so the
# fixtures in tests/fixtures/http stay as they are. A failure is either an API
# that changed shape (fix the code, then re-record that file for real) or a test
# pinning data that moved on (a newer release, a file past the mirror's newest
# 50): re-recording that file with RECORD_HTTP=1 and updating its expectation is
# the fix. Run it before a release, or when a provider is suspected of changing.
#
#   tests/tools/check-apis.sh [file filter...] [--vitest-option...]
#
# A filter keeps the files whose path contains it (curseforge, modloaders.test);
# options go to vitest as they are (write -t=pattern, not -t pattern).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
out="$(mktemp -d "${TMPDIR:-/tmp}/mineshell-apis-XXXXXX")"
trap 'rm -rf -- "$out"' EXIT
# CurseForge's official API needs a key: the one saved in the dev MineShell's Settings, unless
# one is given. Without it that file is skipped.
if [[ -z "${CURSEFORGE_API_KEY:-}" ]]; then
	data="$(sed -n 's/^MINESHELL_DATA=//p' .env 2>/dev/null)"
	CURSEFORGE_API_KEY="$(node tests/tools/curseforge-key.mjs "${data:-$HOME/mineshell-data}" 2>/dev/null)" || CURSEFORGE_API_KEY=''
	export CURSEFORGE_API_KEY
	[[ -n "$CURSEFORGE_API_KEY" ]] || echo "No CurseForge key found: the official API's tests are skipped." >&2
fi
# useRecordedHttp('none') files have only stand-ins: nothing of theirs goes live.
mapfile -t files < <(grep -rlP "useRecordedHttp\('(?!none')" src tests --include='*.test.ts' | sort)
filters=()
options=()
for arg in "$@"; do
	if [[ "$arg" == -* ]]; then options+=("$arg"); else filters+=("$arg"); fi
done
if ((${#filters[@]})); then
	kept=()
	for file in "${files[@]}"; do
		for filter in "${filters[@]}"; do
			if [[ "$file" == *"$filter"* ]]; then kept+=("$file"); break; fi
		done
	done
	files=("${kept[@]}")
	if ((${#files[@]} == 0)); then
		echo "No recorded-API test file matches: ${filters[*]}" >&2
		exit 1
	fi
fi
RECORD_HTTP=1 RECORD_HTTP_DIR="$out" npx vitest run "${files[@]}" "${options[@]}"
