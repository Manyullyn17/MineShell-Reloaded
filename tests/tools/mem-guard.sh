#!/usr/bin/env bash
# Keeps a big test (a whole pack, a server and a client at once) from taking the machine with it,
# real servers included: the test's Java processes go first when memory runs out.
#
#   tests/tools/mem-guard.sh <min available MiB> <log file> <unit or path>...
#
# Each argument naming a systemd user unit (ends in .service) or a path found on a Java
# process' command line is part of the test. Every 5 s it marks those first in line for the
# kernel's OOM killer, and logs available memory and their size. Under the minimum it stops
# them all and exits 3, so run it in the background and read the log. Ends when they are gone.
set -uo pipefail
min="${1:?usage: mem-guard.sh <min available MiB> <log file> <unit or path>...}"
log="${2:?log file}"
shift 2
started=""

pids() {
	local target pid
	for target in "$@"; do
		if [[ "$target" == *.service ]]; then
			pid="$(systemctl --user show -p MainPID --value "$target" 2>/dev/null)"
			[[ -n "$pid" && "$pid" != 0 ]] && echo "$pid"
		else
			# By process name as well: the pattern is on this script's own command line too.
			for pid in $(pgrep -f -- "$target"); do
				[[ "$(ps -o comm= -p "$pid" 2>/dev/null)" == java ]] && echo "$pid"
			done
		fi
	done
}

while true; do
	found="$(pids "$@" | sort -u)"
	available="$(awk '/^MemAvailable/ { print int($2 / 1024) }' /proc/meminfo)"
	rss=0
	for pid in $found; do
		echo 1000 2>/dev/null >"/proc/$pid/oom_score_adj"
		size="$(ps -o rss= -p "$pid" 2>/dev/null)"
		rss=$((rss + ${size:-0} / 1024))
	done
	echo "$(date +%T) available ${available} MiB, test ${rss} MiB in $(echo "$found" | grep -c .) processes" >>"$log"
	[[ -n "$found" ]] && started=1
	[[ -n "$started" && -z "$found" ]] && exit 0
	if ((available < min)); then
		echo "$(date +%T) under $min MiB: stopping the test" >>"$log"
		for target in "$@"; do
			[[ "$target" == *.service ]] && systemctl --user kill --signal=SIGKILL "$target" 2>/dev/null
		done
		for pid in $found; do kill -9 "$pid" 2>/dev/null; done
		exit 3
	fi
	sleep 5
done
