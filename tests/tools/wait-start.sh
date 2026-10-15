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
deadline=$((SECONDS + timeout))
while ((SECONDS < deadline)); do
	if journalctl --user -u "$unit" --since "${since:-today}" -o cat --no-pager | grep -q ']: Done ('; then
		echo "up: $(journalctl --user -u "$unit" --since "${since:-today}" -o cat --no-pager | grep -m1 ']: Done (')"
		exit 0
	fi
	state=$(systemctl --user is-active "$unit")
	if [[ "$state" != active && "$state" != activating ]]; then
		echo "stopped ($state) before finishing. Last lines:"
		journalctl --user -u "$unit" --since "${since:-today}" -o cat --no-pager | tail -25
		exit 1
	fi
	sleep 3
done
echo "still not up after ${timeout}s. Last lines:"
journalctl --user -u "$unit" --since "${since:-today}" -o cat --no-pager | tail -15
exit 1
