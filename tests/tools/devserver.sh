#!/usr/bin/env bash
# Starts or stops a throwaway MineShell dev server (CLAUDE.md, "Trying things
# against real loaders"), by port, never by command line:
#
#   tests/tools/devserver.sh start [port, default 5199] [data dir, default /tmp/ms-test]
#   tests/tools/devserver.sh stop [port]
#   tests/tools/devserver.sh status [port]
#   tests/tools/devserver.sh clean [port] [data dir]
#
# start returns once the server answers (log in <data dir>/devserver-<port>.log).
# MINESHELL_UNIT_PREFIX in the environment replaces the default mstest.
# stop ends the process listening on the port, with its process group.
# clean stops it, stops and removes the prefix's units (template, drop-ins, the
# playit agent, the servers' slice) from ~/.config/systemd/user, and deletes the
# data dir and the dev server's .svelte-kit-<hash> folder. Only a data dir under
# /tmp, and never the prefixes minecraft or mineshell.
# `pkill -f 'vite dev --port 5199'` also matched the shell running it (its own
# command line holds that text), which killed the rest of that command.
set -uo pipefail
cmd="${1:-}"
port="${2:-5199}"
data="${3:-/tmp/ms-test}"

listener() {
	ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | head -n 1 | cut -d= -f2
}

case "$cmd" in
start)
	if [[ -n "$(listener)" ]]; then
		echo "already running on port $port (pid $(listener))"
		exit 0
	fi
	mkdir -p "$data"
	log="$data/devserver-$port.log"
	cd "$(dirname "$0")/../.." || exit 1
	# Its own session, so stop can end vite and anything it started together.
	MINESHELL_DATA="$data" MINESHELL_AUTH=off MINESHELL_UNIT_PREFIX="${MINESHELL_UNIT_PREFIX:-mstest}" \
		setsid npx vite dev --port "$port" --strictPort >"$log" 2>&1 </dev/null &
	for _ in $(seq 60); do
		if curl -s -o /dev/null "http://localhost:$port/"; then
			echo "running on http://localhost:$port (data $data, log $log)"
			exit 0
		fi
		sleep 1
	done
	echo "did not answer within 60 s; see $log" >&2
	exit 1
	;;
stop)
	pid="$(listener)"
	if [[ -z "$pid" ]]; then
		echo "nothing listens on port $port"
		exit 0
	fi
	pgid="$(ps -o pgid= -p "$pid" | tr -d ' ')"
	# The group only when it is vite's own session, never this shell's.
	if [[ -n "$pgid" && "$pgid" != "$(ps -o pgid= -p $$ | tr -d ' ')" ]]; then
		kill -- "-$pgid" 2>/dev/null
	else
		kill "$pid" 2>/dev/null
	fi
	for _ in $(seq 20); do
		[[ -z "$(listener)" ]] && { echo "stopped"; exit 0; }
		sleep 0.5
	done
	echo "still listening on port $port (pid $(listener))" >&2
	exit 1
	;;
clean)
	prefix="${MINESHELL_UNIT_PREFIX:-mstest}"
	resolved="$(realpath -ms "$data")"
	case "$prefix" in minecraft | mineshell | '')
		echo "refusing to clean units of prefix '$prefix'" >&2
		exit 1
		;;
	esac
	if [[ "$resolved" != /tmp/?* ]]; then
		echo "refusing to delete $resolved: only a data dir under /tmp" >&2
		exit 1
	fi
	"$0" stop "$port" || exit 1
	units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
	systemctl --user stop "$prefix@*" "$prefix-playit.service" 2>/dev/null
	shopt -s nullglob
	for f in "$units/$prefix@"* "$units/$prefix-playit.service" "$units/app-$prefix.slice"*; do
		# The playit name has no wildcard, so nullglob keeps it whether or not it exists.
		[[ -e "$f" ]] || continue
		echo "removing $f"
		rm -rf -- "$f"
	done
	systemctl --user daemon-reload
	systemctl --user reset-failed "$prefix@*" "$prefix-playit.service" 2>/dev/null
	# vite.config.ts names a dev server's output folder after its data dir.
	repo="$(cd "$(dirname "$0")/../.." && pwd)"
	kit="$repo/.svelte-kit-$(printf '%s' "$resolved" | sha256sum | cut -c1-8)"
	for d in "$resolved" "$kit"; do
		[[ -e "$d" ]] && { echo "removing $d ($(du -sh "$d" | cut -f1))"; rm -rf -- "$d"; }
	done
	echo "clean"
	;;
status)
	pid="$(listener)"
	[[ -n "$pid" ]] && echo "running on port $port (pid $pid)" || echo "not running on port $port"
	;;
*)
	echo "usage: $0 start|stop|status|clean [port] [data dir]" >&2
	exit 2
	;;
esac
