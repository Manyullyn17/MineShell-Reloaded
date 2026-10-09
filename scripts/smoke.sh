#!/usr/bin/env bash
# Starts a release archive (scripts/package.sh) on a throwaway data directory and
# checks that it serves the first-visit setup page: what install.sh unpacks has
# to run with nothing but its own files and Node.
#
#   scripts/smoke.sh dist/mineshell-<version>.tar.gz
set -euo pipefail

archive=$(readlink -f "$1")
tmp=$(mktemp -d)
pid=
cleanup() {
	[ -n "$pid" ] && kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null
	rm -rf "$tmp"
}
trap cleanup EXIT

tar -C "$tmp" -xzf "$archive"
cd "$tmp"/mineshell-*/
port=$((20000 + RANDOM % 10000))
MINESHELL_DATA="$tmp/data" MINESHELL_UNIT_PREFIX=mineshell-smoke MINESHELL_AUTH=on PORT=$port HOST=127.0.0.1 \
	node build/index.js > "$tmp/log" 2>&1 &
pid=$!

code=000
for _ in $(seq 30); do
	code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/setup" || true)
	[ "$code" != 000 ] && break
	kill -0 "$pid" 2>/dev/null || break
	sleep 1
done
if [ "$code" != 200 ]; then
	echo "The packed MineShell did not serve /setup (HTTP $code). Its output:" >&2
	cat "$tmp/log" >&2
	exit 1
fi
echo "Smoke test passed: $(basename "$archive") serves /setup."
