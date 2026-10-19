#!/usr/bin/env bash
# Starts or stops a throwaway MineShell dev server (CLAUDE.md, "Trying things
# against real loaders"), by port, never by command line:
#
#   tests/tools/devserver.sh start [port, default 5199] [data dir, default /tmp/ms-test]
#   tests/tools/devserver.sh stop [port]
#   tests/tools/devserver.sh status [port]
#
# start returns once the server answers (log in <data dir>/devserver-<port>.log).
# MINESHELL_UNIT_PREFIX in the environment replaces the default mstest.
# stop ends the process listening on the port, with its process group.
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
status)
	pid="$(listener)"
	[[ -n "$pid" ]] && echo "running on port $port (pid $pid)" || echo "not running on port $port"
	;;
*)
	echo "usage: $0 start|stop|status [port] [data dir]" >&2
	exit 2
	;;
esac
