#!/usr/bin/env bash
# Real servers that end up in a state to try by hand, on the throwaway dev server (CLAUDE.md,
# "Trying things against real loaders"; tests/tools/devserver.sh start first). Each is built
# through MineShell's own form actions, booted where it needs to be, and left stopped: start it
# from the page and see what MineShell makes of it.
#
#   tests/tools/scenarios.sh <scenario>...    (all of them without one)
#
#   forge-question  Forge 1.12.2 that booted once with Biomes O' Plenty, which is then removed:
#                   the next start asks about the missing registry entries on the console
#                   (forgequery.ts), answered from the overview.
#   watchdog        Vanilla 1.21.1 with max-tick-time=1: the watchdog ends it right after
#                   "Done (" (crash diagnosis names it and offers a longer limit).
#   missing-dep     Fabric 1.20.1 with Chunky uploaded as a jar but no Fabric API, which it
#                   requires: the loader refuses to start (crash diagnosis names the mod).
#
# About 5 minutes, mostly the Forge install and its first boot. Servers get a 3 GB heap.
set -uo pipefail
cd "$(dirname "$0")/../.."
U=${U:-http://127.0.0.1:5199}
DATA=${MINESHELL_DATA:-/tmp/ms-test}
act() { node tests/tools/act.mjs "$@" | grep -o '"message": *"[^"]*"' | head -1; }
waittasks() { while curl -s "$U/api/tasks" | grep -q '"state":"running"'; do sleep 5; done; }
create() { # name id minecraft loader
	if [[ -d "$DATA/instances/$2" ]]; then echo "$2 is there already: delete it first to make it again"; return 1; fi
	act "$U/instances/new?/loader" name="$1" minecraftVersion="$3" modloader="$4" downloadJava=temurin acceptEula=on memoryMaxMb=3072 memoryMinMb=1024
	waittasks
	[[ -d "$DATA/instances/$2" ]] || { echo "creating $2 failed"; return 1; }
}
stopped() { until [[ $(systemctl --user is-active "mstest@$1") =~ ^(inactive|failed)$ ]]; do sleep 2; done; }

forge_question() {
	echo "== forge-question"
	create "Forge Question" forge-question 1.12.2 forge || return
	# Biomes O' Plenty 7.0.1.2445 for 1.12.2 (Modrinth): hundreds of blocks and items in the world's registry.
	act "$U/instances/forge-question/mods?/install" source=modrinth projectId=HXF82T3G versionId=e5wgKLKS
	waittasks
	act "$U/instances/forge-question?/power" verb=start
	sleep 3
	tests/tools/wait-start.sh mstest@forge-question 900 >/dev/null || { echo "its first boot failed"; return 1; }
	act "$U/instances/forge-question?/power" verb=stop
	stopped forge-question
	jar=$(ls "$DATA/instances/forge-question/mods" | grep -i biomesoplenty | head -1)
	act "$U/instances/forge-question/mods?/remove" fileName="$jar"
	echo "ready: start Forge Question; it waits on the missing-entries question"
}

watchdog() {
	echo "== watchdog"
	create "Watchdog" watchdog 1.21.1 vanilla || return
	sed -i 's/^max-tick-time=.*/max-tick-time=1/' "$DATA/instances/watchdog/server.properties"
	grep -q '^max-tick-time=1$' "$DATA/instances/watchdog/server.properties" || echo 'max-tick-time=1' >> "$DATA/instances/watchdog/server.properties"
	echo "ready: start Watchdog; it ends a tick after Done"
}

missing_dep() {
	echo "== missing-dep"
	create "Missing Dep" missing-dep 1.20.1 fabric || return
	# A download of its own, in a folder of its own: an upload as from a person's disk.
	local dir; dir=$(mktemp -d)
	curl -fsSL -o "$dir/Chunky-1.3.146.jar" https://cdn.modrinth.com/data/fALzjamp/versions/NHWYq9at/Chunky-1.3.146.jar
	act "$U/instances/missing-dep/mods?/upload" jars=@"$dir/Chunky-1.3.146.jar"
	rm -rf "$dir"
	echo "ready: start Missing Dep; Fabric refuses Chunky without Fabric API"
}

curl -fs "$U/" >/dev/null || { echo "No dev server at $U: tests/tools/devserver.sh start"; exit 1; }
(( $# )) || set -- forge-question watchdog missing-dep
for s in "$@"; do
	case "$s" in
		forge-question) forge_question ;;
		watchdog) watchdog ;;
		missing-dep) missing_dep ;;
		*) echo "unknown scenario: $s" ;;
	esac
done
