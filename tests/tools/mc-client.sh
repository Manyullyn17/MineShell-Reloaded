#!/usr/bin/env bash
# A real Minecraft client without a screen (HeadlessMC), for what needs a player online on a
# test server: game mode, teleport, the online-player refusal, whether a modded client gets in.
#
#   tests/tools/mc-client.sh start <player> <loader> <version> [--mods dir] [--server host:port] [--heap 4G] [--build n]
#   tests/tools/mc-client.sh cmd <player> <command...>     # prints what the client answers
#   tests/tools/mc-client.sh stop <player>
#   tests/tools/mc-client.sh clean
#
# loader is fabric, forge or neoforge, on versions hmc-specifics covers (1.7.10 to 26.x; it
# adds the commands). start returns once the game has loaded, not once it has joined: look for
# "joined the game" in the server's log. --server joins through the game's quick play, which old
# versions lack (1.12.2 stayed at the menu): there use `cmd <player> connect <host> <port>`.
# --mods copies that folder's jars in: a modded server refuses a client without its mods
# ("Server Mod rejections"). A Forge client joins a Cleanroom server (HeadlessMC has no
# Cleanroom client), as long as no mod needs Cleanroom itself.
#
# Useful commands: `metrics player.position player.gamemode player.dead world.dimension --json`,
# `gui`, `respawn now`, `msg <text>`, `/<command>`, `disconnect`, `quit`; the hmc-specifics README
# lists them all. The server needs online-mode=false: these are offline accounts, which
# HeadlessMC allows for headless launches only. A dead player stays on the respawn screen and a
# teleport then answers "Teleported" and does nothing, so test in creative or check player.dead.
#
# Headless means LWJGL is stubbed, and every image loads blank: small modded setups are fine, but
# a mod that reads pixels while loading crashes the client. All the Mods 10 (458 mods) did, first
# Supplementaries ("has too few colors"), and without it 20 more, texture work on stubs. A pack
# like that needs a real display (Xvfb), which HeadlessMC only allows with a Microsoft account.
# --build is the loader's last number (251 for NeoForge 21.1.251, `version ls -r neoforge 1.21.1`).
# A pack's client also needs its config and kubejs folders in run/<player>/game. With big ones,
# run mem-guard.sh too: that test took 12.7 GB (5 GB heaps) on top of everything else.
#
# Everything lives under $MC_CLIENT_DIR (default ~/.cache/mineshell-mc-client, about 600 MB per
# Minecraft version, once): Java ignores $HOME, so without -Duser.home the launcher writes
# ~/.minecraft and its own folders into the real home. Nothing else is touched.
set -uo pipefail
root="${MC_CLIENT_DIR:-$HOME/.cache/mineshell-mc-client}"
version="3.0.0-RC8"
specifics_version="3.0.1"
jar="$root/headlessmc-$version.jar"
home="$root/home"
cmd="${1:-}"
player="${2:-}"

hmc() {
	HOME="$home" XDG_CONFIG_HOME="$home/.config" XDG_CACHE_HOME="$home/.cache" XDG_DATA_HOME="$home/.local/share" \
		XDG_STATE_HOME="$home/.local/state" java -Duser.home="$home" -jar "$jar" "$@"
}

# The prompts read a line each and lose whatever else is waiting, so a pipe has to go slowly.
account() {
	if ! hmc account ls 2>/dev/null | grep -q "^$1 "; then
		(echo "$1"; sleep 2; echo; sleep 2; echo; sleep 2; echo; sleep 2) | hmc account -p offline login >/dev/null 2>&1
	fi
	hmc account -p offline select "$1" >/dev/null 2>&1
}

running() { [[ -f "$1/pid" ]] && kill -0 "$(cat "$1/pid")" 2>/dev/null; }

case "$cmd" in
start)
	loader="${3:-}"
	mc="${4:-}"
	[[ -n "$player" && -n "$loader" && -n "$mc" ]] || { echo "usage: $0 start <player> <loader> <version> [--mods dir] [--server host:port] [--heap 4G] [--build n]" >&2; exit 2; }
	shift 4
	mods="" server="" heap="" build=""
	while (($#)); do
		case "$1" in
		--mods) mods="$2"; shift 2 ;;
		--server) server="$2"; shift 2 ;;
		--heap) heap="$2"; shift 2 ;;
		--build) build="$2"; shift 2 ;;
		*) echo "unknown option $1" >&2; exit 2 ;;
		esac
	done
	run="$root/run/$player"
	# A release asset: GitHub's download host answered 504 for an hour while the API (gh) worked.
	fetch() { curl -fsSL -o "$1" "https://github.com/$2/releases/download/$3/$4" || { command -v gh >/dev/null && gh release download "$3" -R "$2" -p "$4" -O "$1" --clobber; }; }
	if running "$run"; then echo "$player is running already"; exit 1; fi
	mkdir -p "$run/game/mods" "$home/.config/headlessmc"
	if [[ ! -f "$jar" ]]; then
		fetch "$jar" headlesshq/headlessmc "$version" headlessmc.jar || { echo "could not download HeadlessMC" >&2; exit 1; }
	fi
	[[ -n "$mods" ]] && cp "$mods"/*.jar "$run/game/mods/"
	kind="$loader"
	[[ "$loader" == forge ]] && kind=lexforge
	specifics="hmc-specifics-$mc-$specifics_version-$kind-release.jar"
	if [[ ! -f "$run/game/mods/$specifics" ]]; then
		fetch "$run/game/mods/$specifics" headlesshq/hmc-specifics "$specifics_version" "$specifics" || { echo "no $specifics: hmc-specifics has no build for that version" >&2; exit 1; }
	fi
	# The first-launch accessibility screen would hold up quick play.
	[[ -f "$run/game/options.txt" ]] || printf 'pauseOnLostFocus:false\nonboardAccessibility:false\nnarrator:0\n' >"$run/game/options.txt"
	cat >"$home/.config/headlessmc/config.properties" <<-END
		hmc.jline.enabled=false
		hmc.files.game=$run/game
		hmc.files.game-for-each-version=false
	END
	account "$player"
	rm -f "$run/in" "$run/out"
	mkfifo "$run/in"
	: >"$run/out"
	args=(launch "$loader" "$mc" ${build:+"$build"} --headless -j "-Duser.home=$home${heap:+ -Xmx$heap}")
	[[ -n "$server" ]] && args+=(--server "$server")
	# tail keeps stdin open, so it goes with the launcher (kill 0) or a launcher that exits goes
	# unnoticed. Its own session, so stop can end the game with the launcher.
	HOME="$home" XDG_CONFIG_HOME="$home/.config" XDG_CACHE_HOME="$home/.cache" XDG_DATA_HOME="$home/.local/share" XDG_STATE_HOME="$home/.local/state" \
		setsid bash -c 'echo $$ >"$1/pid"; shift; tail -f "$0" | { java "$@"; kill 0; }' "$run/in" "$run" -Duser.home="$home" -jar "$jar" "${args[@]}" >"$run/out" 2>&1 </dev/null &
	# Up to several minutes on a first launch, for the downloads.
	for _ in $(seq 600); do
		if grep -qE 'Created: [0-9]+x[0-9]+|Forge Mod Loader has successfully loaded' "$run/out"; then
			sleep 3
			echo "$player is up (log $run/out)"
			exit 0
		fi
		if [[ -f "$run/pid" ]] && ! running "$run"; then
			echo "$player exited during start; see $run/out" >&2
			exit 1
		fi
		sleep 1
	done
	echo "$player did not come up within 10 minutes; see $run/out" >&2
	exit 1
	;;
cmd)
	run="$root/run/$player"
	running "$run" || { echo "$player is not running" >&2; exit 1; }
	shift 2
	before="$(wc -l <"$run/out")"
	echo "$*" >"$run/in"
	sleep "${MC_CLIENT_WAIT:-2}"
	tail -n "+$((before + 1))" "$run/out"
	;;
stop)
	run="$root/run/$player"
	if ! running "$run"; then
		echo "$player is not running"
		exit 0
	fi
	echo quit >"$run/in"
	sleep 5
	# Only the client's session: what quit left behind, tail at least.
	running "$run" && kill -- "-$(cat "$run/pid")" 2>/dev/null
	rm -f "$run/pid"
	echo "stopped"
	;;
clean)
	shopt -s nullglob
	for pidfile in "$root"/run/*/pid; do
		kill -- "-$(cat "$pidfile")" 2>/dev/null
	done
	rm -rf -- "$root"
	echo "removed $root"
	;;
*)
	echo "usage: $0 start|cmd|stop|clean ..." >&2
	exit 2
	;;
esac
