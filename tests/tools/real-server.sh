#!/usr/bin/env bash
# A real vanilla server through a running MineShell on real systemd: created with Java
# downloaded, booted, a console command, Restart, Stop, Force stop, and a crash (the Java process
# killed from outside, as the OOM killer would) that systemd restarts by itself; then the runs
# MineShell recorded are checked: the asked-for stops are not crashes, the kill is one, and
# Restart's stop went over RCON (exit 0, no SIGTERM's 143).
# Mocked tests cannot catch what only a real unit does (`--kill-whom=all` passed its test and
# failed on a user unit; the RCON deadlock took a real server). The Scheduled CI workflow runs
# it weekly on an installed MineShell; by hand, on the throwaway dev server:
#
#   tests/tools/devserver.sh start && tests/tools/real-server.sh && tests/tools/devserver.sh clean
#
# MineShell has to run with MINESHELL_AUTH=off. Environment, all optional:
#   U       its address (default http://127.0.0.1:5199, the throwaway dev server)
#   PREFIX  its MINESHELL_UNIT_PREFIX (default mstest)
#   DATA    its MINESHELL_DATA (default /tmp/ms-test)
#   APP     a folder whose node_modules has better-sqlite3, to read its database (default
#           this checkout; an installed MineShell's release folder works too)
# About 3 minutes, most of it the first boot. Leaves the server stopped; exit 1 on the
# first step that fails, with the server's last lines.
set -uo pipefail
tools="$(cd "$(dirname "$0")" && pwd)"
U=${U:-http://127.0.0.1:5199}
PREFIX=${PREFIX:-mstest}
DATA=${DATA:-/tmp/ms-test}
APP=${APP:-$(cd "$tools/../.." && pwd)}
id=lifecycle
unit="$PREFIX@$id"

fail() {
	echo "FAIL: $*" >&2
	journalctl --user -u "$unit" -n 40 -o cat --no-pager >&2
	exit 1
}
step() { echo "== $*"; }
act() { local out; out=$(node "$tools/act.mjs" "$@" 2>&1) || { echo "$out" >&2; return 1; }; }
waittasks() { while curl -s "$U/api/tasks" | grep -q '"state":"running"'; do sleep 5; done; }
state() { systemctl --user is-active "$unit"; }
# Inactive or failed for a few checks in a row, not between a crash and systemd's restart.
stopped() {
	local deadline=$((SECONDS + ${1:-120}))
	until [[ $(state) =~ ^(inactive|failed)$ ]]; do
		((SECONDS < deadline)) || return 1
		sleep 2
	done
}
mainpid() { systemctl --user show "$unit" -p MainPID --value; }
runs() { # one line per run: crashed|exit status|reached Done
	node -e '
		const db = new (require(process.argv[1] + "/node_modules/better-sqlite3"))(process.argv[2] + "/mineshell.db", { readonly: true });
		for (const r of db.prepare("select * from server_runs where instance_id = ? and ended_at is not null order by started_at").all(process.argv[3]))
			console.log([r.crashed ? "crashed" : "ok", r.exit_status ?? "-", r.done_at ? "done" : "never"].join("|"));
	' "$APP" "$DATA" "$id"
}

# What the history had to go on, for a run check that failed on a machine not at hand (CI).
diagnose_runs() {
	echo "-- every server_runs row, and where the history got to:"
	node -e '
		const db = new (require(process.argv[1] + "/node_modules/better-sqlite3"))(process.argv[2] + "/mineshell.db", { readonly: true });
		console.log(db.prepare("select * from server_runs where instance_id = ?").all(process.argv[3]));
		console.log(db.prepare("select created_at, history_cursor from server_instances where id = ?").get(process.argv[3]));
	' "$APP" "$DATA" "$id"
	echo "-- systemd $(systemctl --version | head -n 1); the unit's systemd lines with their ids:"
	journalctl --user --user-unit="$unit.service" -o json --no-pager | node -e '
		for (const line of require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean)) {
			const e = JSON.parse(line);
			if (e.SYSLOG_IDENTIFIER !== "systemd") continue;
			console.log(JSON.stringify({ m: String(e.MESSAGE).slice(0, 60), t: e.__REALTIME_TIMESTAMP, uinv: e.USER_INVOCATION_ID, sinv: e._SYSTEMD_INVOCATION_ID, inv: e.INVOCATION_ID, uunit: e.USER_UNIT, sunit: e._SYSTEMD_USER_UNIT }));
		}'
	local cursor
	cursor=$(node -e '
		const db = new (require(process.argv[1] + "/node_modules/better-sqlite3"))(process.argv[2] + "/mineshell.db", { readonly: true });
		console.log(db.prepare("select history_cursor from server_instances where id = ?").get(process.argv[3])?.history_cursor ?? "");
	' "$APP" "$DATA" "$id")
	echo "-- after the stored cursor (what the history reads next), its exit status and errors:"
	journalctl --user --user-unit="$unit.service" "--after-cursor=$cursor" -o cat --no-pager 2>&1 | head -5; echo "exit ${PIPESTATUS[0]}"
	echo "-- the cursors journalctl gives (s= is the file's sequence id):"
	journalctl --user --user-unit="$unit.service" -o json --no-pager | node -e '
		for (const line of require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean)) console.log(JSON.parse(line).__CURSOR.split(";")[0]);' | sort | uniq -c | sort -rn | head -5
	journalctl --header --user --no-pager 2>&1 | grep -E "File path|Seqnum ID|State" | head -12
	echo "-- journalctl processes still running (a history read that never ended):"
	pgrep -a journalctl || echo none
	local grep='^Started |Main process exited|Failed with result|service: Consumed |\]: Done \('
	echo "-- the history's next read as it makes it (--after-cursor, -g, JSON), 20 s at most:"
	timeout 20 journalctl --user --user-unit="$unit.service" "--after-cursor=$cursor" -o json -g "$grep" --no-pager | wc -l; echo "exit ${PIPESTATUS[0]} (124: timed out)"
	echo "-- the same from a time instead of the cursor:"
	timeout 20 journalctl --user --user-unit="$unit.service" "--since=@$(( $(date +%s) - 600 ))" -o json -g "$grep" --no-pager | wc -l; echo "exit ${PIPESTATUS[0]}"
	echo "-- the history's own read (newest entry, then the pattern search):"
	journalctl --user --user-unit="$unit.service" -n 1 -o json --no-pager | head -c 400; echo
	journalctl --user --user-unit="$unit.service" -o cat -g '^Started |Main process exited|Failed with result|service: Consumed |\]: Done \(' --no-pager | head -20
}

curl -fs -o /dev/null "$U/" || { echo "No MineShell at $U (tests/tools/devserver.sh start)." >&2; exit 1; }
[[ -d "$DATA/instances/$id" ]] && { echo "$DATA/instances/$id is there already: delete that server first." >&2; exit 1; }

# The installer writes the template unit; a dev server has it installed from Settings.
if ! systemctl --user cat "$PREFIX@.service" >/dev/null 2>&1; then
	step "install the template unit"
	act "$U/settings?/installUnit" || fail "installing the template unit"
fi

step "create a vanilla 1.21.1 server, Java downloaded"
act "$U/instances/new?/loader" name=Lifecycle minecraftVersion=1.21.1 modloader=vanilla downloadJava=temurin acceptEula=on memoryMaxMb=2048 memoryMinMb=512 ||
	fail "creating it was refused"
waittasks
[[ -f "$DATA/instances/$id/server.properties" || -f "$DATA/instances/$id/eula.txt" ]] || fail "no server folder after creating it"

step "start, wait for Done"
act "$U/instances/$id?/power" verb=start || fail "start refused"
sleep 3
"$tools/wait-start.sh" "$unit" 600 || fail "first boot"

step "a console command"
answer=$(curl -s -X POST -H 'content-type: application/json' -H "origin: $U" -d '{"command":"list"}' "$U/api/instances/$id/command")
grep -q 'players online' <<<"$answer" || fail "list answered: $answer"

step "Restart: saved and stopped over RCON, then started by MineShell"
pid=$(mainpid)
act "$U/instances/$id?/power" verb=restart || fail "restart refused"
deadline=$((SECONDS + 120))
until [[ $(mainpid) -gt 0 && $(mainpid) != "$pid" ]]; do
	((SECONDS < deadline)) || fail "no new process 2 minutes after Restart ($(state))"
	sleep 2
done
"$tools/wait-start.sh" "$unit" 300 || fail "boot after Restart"

step "Stop"
act "$U/instances/$id?/power" verb=stop || fail "stop refused"
stopped 120 || fail "still $(state) 2 minutes after Stop"
[[ $(state) == inactive ]] || fail "Stop left the unit $(state)"

step "start again, Force stop"
act "$U/instances/$id?/power" verb=start || fail "second start refused"
sleep 3
"$tools/wait-start.sh" "$unit" 300 || fail "second boot"
act "$U/instances/$id?/power" verb=kill || fail "Force stop refused"
stopped 30 || fail "still $(state) 30 s after Force stop"
[[ $(state) == inactive ]] || fail "Force stop left the unit $(state)"

step "start again, kill Java from outside: systemd restarts it"
act "$U/instances/$id?/power" verb=start || fail "third start refused"
sleep 3
"$tools/wait-start.sh" "$unit" 300 || fail "third boot"
pid=$(mainpid)
[[ "$pid" -gt 0 ]] || fail "no main process"
kill -KILL "$pid"
# RestartSec=15, then a boot.
deadline=$((SECONDS + 60))
until [[ $(mainpid) -gt 0 && $(mainpid) != "$pid" ]]; do
	((SECONDS < deadline)) || fail "not restarted a minute after the crash ($(state))"
	sleep 2
done
"$tools/wait-start.sh" "$unit" 300 || fail "boot after the crash"
act "$U/instances/$id?/power" verb=stop || fail "last stop refused"
stopped 120 || fail "still $(state) 2 minutes after the last Stop"

step "the runs MineShell recorded"
# history.ts reads the journal every 30 s.
# Force stop's SIGKILL follows a stop job, whose SIGTERM can end Java first (it saves and exits
# in under a second): then systemd logs no exit status for that run (GitHub's 22.04 runners).
want=$'ok|-|done\nok|-|done\nok|9 or -|done\ncrashed|9|done\nok|-|done'
want_re=$'^ok\\|-\\|done\nok\\|-\\|done\nok\\|(9|-)\\|done\ncrashed\\|9\\|done\nok\\|-\\|done$'
deadline=$((SECONDS + 90))
until [[ "$(runs)" =~ $want_re ]]; do
	if ((SECONDS >= deadline)); then
		printf 'Expected (crashed|exit status|reached Done):\n%s\nRecorded:\n%s\n' "$want" "$(runs)" >&2
		diagnose_runs >&2
		fail "the recorded runs"
	fi
	sleep 5
done
echo "Passed: boot, console, Restart, Stop, Force stop, a crash restarted by systemd, all recorded as such."
