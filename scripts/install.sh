#!/usr/bin/env bash
# MineShell installer. Installs the latest release as a systemd user service, or
# updates an installed MineShell to it - run it again to update:
#
#   curl -fsSL https://github.com/Manyullyn17/MineShell-Reloaded/releases/latest/download/install.sh | bash
#
# Needs Linux with systemd, Node.js 22.12+, curl, tar and sha256sum. No root: it
# installs for the account that runs it and never changes a file it did not write.
#
# Options (environment variables, all optional):
#   MINESHELL_VERSION   release tag to install, e.g. v0.2.0 (default: the latest)
#   MINESHELL_HOME      where the program goes (default: ~/mineshell)
#   MINESHELL_CONFIG    its settings file (default: ~/.config/mineshell/mineshell.env)
#   MINESHELL_SERVICE   the user service's name (default: mineshell)
#   MINESHELL_NODE      the node binary to run it with (default: `node` on PATH)
#   MINESHELL_ARCHIVE   install this release archive instead of downloading one
# Only for a first install, written into the settings file (which is never
# overwritten - edit it afterwards):
#   MINESHELL_DATA (default ~/.local/share/mineshell), MINESHELL_UNIT_PREFIX
#   (default mineshell), PORT (default 3000)
#
# Layout: $MINESHELL_HOME/releases/<version>/ with `current` pointing at the one
# that runs, so an update swaps one link and the previous two stay for going back.

set -euo pipefail

REPO=Manyullyn17/MineShell-Reloaded
MARKER='# Written by the MineShell installer.'

say() { printf '%s\n' "$*"; }
fail() { printf 'MineShell install: %s\n' "$*" >&2; exit 1; }

main() {
	[ "$(id -u)" -ne 0 ] || fail "run this as the account MineShell should run as, not root (servers run as that account's systemd user units)."
	for tool in curl tar sha256sum systemctl; do
		command -v "$tool" >/dev/null || fail "$tool is missing."
	done
	systemctl --user show-environment >/dev/null 2>&1 ||
		fail "cannot reach your systemd user manager (systemctl --user). Log in normally (not su/sudo), or see docs/DEPLOYMENT.md."

	local home_dir="${MINESHELL_HOME:-$HOME/mineshell}"
	local config="${MINESHELL_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/mineshell/mineshell.env}"
	local service="${MINESHELL_SERVICE:-mineshell}"
	local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
	local unit_file="$unit_dir/$service.service"

	local node="${MINESHELL_NODE:-$(command -v node || true)}"
	[ -n "$node" ] || fail "Node.js not found. Install Node.js 22.12 or newer (https://nodejs.org, NodeSource or nvm), then run this again."
	node=$(readlink -f "$node")
	"$node" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)' ||
		fail "Node.js $("$node" -v) is too old: MineShell needs 22.12 or newer."

	# Everything that could refuse is checked before anything changes.
	if [ -e "$home_dir" ] && [ ! -e "$home_dir/.mineshell-install" ]; then
		[ -d "$home_dir" ] && [ -z "$(ls -A "$home_dir")" ] ||
			fail "$home_dir exists and was not made by this installer. Move it, or pick another folder with MINESHELL_HOME=..."
	fi
	if [ -e "$unit_file" ] && ! grep -qxF "$MARKER" "$unit_file"; then
		fail "$unit_file exists and was not written by this installer. Remove it, or pick another name with MINESHELL_SERVICE=..."
	fi

	# Global, not local: the EXIT trap runs after main has returned.
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT

	local archive
	if [ -n "${MINESHELL_ARCHIVE:-}" ]; then
		archive="$MINESHELL_ARCHIVE"
		[ -f "$archive" ] || fail "$archive does not exist."
	else
		local tag="${MINESHELL_VERSION:-}"
		if [ -z "$tag" ]; then
			# The latest release's page redirects to its tag; no API call (and no rate limit).
			tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")
			tag="${tag##*/}"
			[[ "$tag" == v* ]] || fail "could not find the latest release on github.com/$REPO."
		fi
		local file="mineshell-${tag#v}.tar.gz"
		local base="https://github.com/$REPO/releases/download/$tag"
		say "Downloading MineShell $tag"
		curl -fSL --progress-bar -o "$tmp/$file" "$base/$file" || fail "download failed: $base/$file"
		curl -fsSL -o "$tmp/$file.sha256" "$base/$file.sha256" || fail "download failed: $base/$file.sha256"
		(cd "$tmp" && sha256sum -c --quiet "$file.sha256") || fail "the download does not match its checksum."
		archive="$tmp/$file"
	fi

	mkdir "$tmp/unpacked"
	tar -C "$tmp/unpacked" -xzf "$archive"
	local unpacked
	unpacked=$(find "$tmp/unpacked" -mindepth 1 -maxdepth 1 -type d -name 'mineshell-*' | head -n 1)
	[ -n "$unpacked" ] && [ -f "$unpacked/VERSION" ] && [ -f "$unpacked/build/index.js" ] ||
		fail "$archive is not a MineShell release archive."
	local version
	version=$(cat "$unpacked/VERSION")

	# The program.
	mkdir -p "$home_dir/releases"
	[ -e "$home_dir/.mineshell-install" ] || printf '%s\n' "$MARKER" 'Releases in releases/, the running one is current/. Remove this folder to uninstall.' > "$home_dir/.mineshell-install"
	local release="$home_dir/releases/$version"
	if [ -e "$release" ]; then
		# Reinstalling a version: the running process keeps its open files across the swap.
		rm -rf "$release.old"
		mv "$release" "$release.old"
	fi
	mv "$unpacked" "$release"
	rm -rf "$release.old"

	# Settings: written once, never overwritten.
	local first_config=no
	if [ ! -e "$config" ]; then
		first_config=yes
		mkdir -p "$(dirname "$config")"
		(
			umask 077
			cat > "$config" <<-EOF
				# MineShell settings, read by $service.service. Restart it after a change:
				#   systemctl --user restart $service
				# The variables are described in .env.example ($home_dir/current/.env.example).
				MINESHELL_DATA=${MINESHELL_DATA:-$HOME/.local/share/mineshell}
				MINESHELL_UNIT_PREFIX=${MINESHELL_UNIT_PREFIX:-mineshell}
				MINESHELL_AUTH=on
				CURSEFORGE_API_KEY=
				PORT=${PORT:-3000}
				HOST=0.0.0.0
				# Uploads (mods, packs, worlds) are refused over 512 KB without this.
				BODY_SIZE_LIMIT=Infinity
			EOF
		)
	fi

	# The template unit for the Minecraft servers, and the data folders.
	(cd "$release" && MINESHELL_ENV_FILE="$config" "$node" scripts/setup.mjs >/dev/null) ||
		fail "setting up the server template unit failed; run: cd $release && MINESHELL_ENV_FILE=$config $node scripts/setup.mjs"

	# Switch to the new release in one step.
	ln -sfn "releases/$version" "$home_dir/current.new"
	mv -T "$home_dir/current.new" "$home_dir/current"

	mkdir -p "$unit_dir"
	cat > "$unit_file" <<-EOF
		$MARKER
		# Running the installer again rewrites this file; settings go in $config.
		[Unit]
		Description=MineShell
		After=network-online.target
		Wants=network-online.target

		[Service]
		Type=simple
		WorkingDirectory=$home_dir/current
		EnvironmentFile=$config
		ExecStart="$node" "$home_dir/current/build/index.js"
		Restart=on-failure
		RestartSec=10

		[Install]
		WantedBy=default.target
	EOF

	# User services stop at logout and wait for a login after a reboot without lingering.
	if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]; then
		loginctl enable-linger "$USER" 2>/dev/null ||
			say "Could not turn on lingering; without it MineShell stops when you log out. Run: sudo loginctl enable-linger $USER"
	fi

	systemctl --user daemon-reload
	systemctl --user enable --quiet "$service"
	systemctl --user restart "$service"

	# Old releases: keep the running one and the two before it.
	local old
	for old in $(ls -1t "$home_dir/releases" | tail -n +4); do
		[ "$old" = "$version" ] || rm -rf "${home_dir:?}/releases/$old"
	done

	local port
	port=$(sed -n 's/^PORT=//p' "$config" | tail -n 1)
	port="${port:-3000}"
	local code=000 i
	for i in $(seq 30); do
		code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" || true)
		[ "$code" != 000 ] && break
		sleep 1
	done

	say ""
	if [ "$code" = 000 ]; then
		say "MineShell $version is installed but did not answer on port $port. Its log:"
		say "  journalctl --user -u $service -n 50"
		exit 1
	fi
	say "MineShell $version is running: http://$(hostname 2>/dev/null || echo localhost):$port"
	[ "$first_config" = yes ] && say "First visit: set the admin password there. Settings: $config"
	case "$node" in
		*/.nvm/*) say "Node comes from nvm ($node): run this installer again after removing that Node version." ;;
	esac
	say "Log: journalctl --user -u $service -f    Update: run this installer again."
}

main "$@"
