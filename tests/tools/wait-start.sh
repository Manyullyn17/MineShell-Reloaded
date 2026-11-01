#!/usr/bin/env bash
# Waits for a server's unit to finish starting ("Done (" in its journal) or to
# stop, then says which, with the run's last lines on failure.
#
#   tests/tools/wait-start.sh <unit, e.g. mstest@mig> [timeout seconds, default 600]
#
# Only lines after the unit's latest start count. Exit 0 when it is up, 1 when
# it stopped or the time ran out.
set -uo pipefail
unit="$1"
timeout="${2:-600}"
since=$(systemctl --user show "$unit" -p ActiveEnterTimestamp --value)
# As seconds: journalctl cannot read every zone name systemctl prints ("CET").
# Empty when the unit was stopped and systemd unloaded it (called between a stop and the
# start a task does next, such as Forge's answer): its start is still to come, so from now,
# not today - that matched an earlier boot's Done line.
if [ -n "$since" ]; then since="@$(date -d "$since" +%s)"; else since="@$(date +%s)"; fi
deadline=$((SECONDS + timeout))
while ((SECONDS < deadline)); do
	# Not grep -q: it quits at the match, journalctl still writing then dies of
	# SIGPIPE, and pipefail counts the whole check as failed.
	done_line=$(journalctl --user -u "$unit" --since "$since" -o cat --no-pager | grep ']: Done (' | head -n 1)
	if [[ -n "$done_line" ]]; then
		echo "up: $done_line"
		exit 0
	fi
	state=$(systemctl --user is-active "$unit")
	if [[ "$state" != active && "$state" != activating ]]; then
		echo "stopped ($state) before finishing. Last lines:"
		journalctl --user -u "$unit" --since "$since" -o cat --no-pager | tail -25
		exit 1
	fi
	sleep 3
done
echo "still not up after ${timeout}s. Last lines:"
journalctl --user -u "$unit" --since "$since" -o cat --no-pager | tail -15
exit 1
