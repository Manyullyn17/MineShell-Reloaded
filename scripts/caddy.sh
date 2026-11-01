#!/usr/bin/env bash
# MineShell on a public address, with https: puts Caddy in front of it.
#
#   scripts/caddy.sh panel.example.com     set up, or change the name
#   scripts/caddy.sh --remove              undo both parts
#
# Not the recommended way in: Tailscale keeps MineShell off the internet altogether
# (MineShell settings > System, "Remote access"; docs/DEPLOYMENT.md). For a public address
# you need a domain name pointing at this machine and ports 80 and 443 forwarded to it.
#
# Run it as the account MineShell runs as. It changes two things, each only as far as it
# wrote them itself:
#   - /etc/caddy/Caddyfile (with sudo): written only when it is the distribution's default
#     (kept as Caddyfile.before-mineshell) or this script's; otherwise the lines to add are
#     printed. Caddy gets the certificate and renews it by itself.
#   - MineShell's settings file: a block at its end making MineShell answer only on this
#     machine (HOST=127.0.0.1, so Caddy is the only way in from outside) and read each
#     client's address from Caddy's X-Forwarded-For (ADDRESS_HEADER, XFF_DEPTH=1), so the
#     sign-in throttle counts per client, not everyone as 127.0.0.1. Then MineShell restarts.
#
# Needs Caddy from your distribution (Debian/Ubuntu: sudo apt install caddy), which runs it
# as a system service. Options (environment variables): MINESHELL_CONFIG (default
# ~/.config/mineshell/mineshell.env), MINESHELL_SERVICE (default mineshell), CADDYFILE
# (default /etc/caddy/Caddyfile).

set -euo pipefail

CADDY_MARKER="# Written by MineShell's caddy.sh: run it again to change this, or with --remove."
BLOCK_START='# >>> caddy.sh: MineShell behind Caddy (scripts/caddy.sh --remove takes this out)'
BLOCK_END='# <<< caddy.sh'

say() { printf '%s\n' "$*"; }
fail() { printf 'caddy.sh: %s\n' "$*" >&2; exit 1; }

config="${MINESHELL_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/mineshell/mineshell.env}"
service="${MINESHELL_SERVICE:-mineshell}"
caddyfile="${CADDYFILE:-/etc/caddy/Caddyfile}"

# The last value a settings file gives a variable (later lines win, as for systemd).
setting() { sed -n "s/^$1=//p" "$config" | tail -n 1; }

# The settings file without this script's block.
without_block() { awk -v s="$BLOCK_START" -v e="$BLOCK_END" '$0 == s { skip = 1; next } $0 == e { skip = 0; next } !skip' "$config"; }

# Whether the Caddyfile is the one the distribution's package ships: a file server on :80.
is_default_caddyfile() {
	local plain
	plain=$(sed -e 's/#.*//' -e 's/[[:space:]]\+/ /g' -e 's/^ //' -e 's/ $//' "$caddyfile" | grep -v '^$' | tr '\n' ';')
	[ "$plain" = ':80 {;root * /usr/share/caddy;file_server;};' ]
}

restart_mineshell() {
	systemctl --user restart "$service" || fail "could not restart $service: journalctl --user -u $service -n 50"
}

remove() {
	if [ -f "$caddyfile" ] && grep -qxF "$CADDY_MARKER" "$caddyfile"; then
		if [ -f "$caddyfile.before-mineshell" ]; then
			sudo mv "$caddyfile.before-mineshell" "$caddyfile"
			say "Put back the Caddyfile from before ($caddyfile)."
		else
			sudo rm -f "$caddyfile"
			say "Removed $caddyfile."
		fi
		sudo systemctl reload-or-restart caddy || say "Caddy did not reload: sudo systemctl status caddy"
	else
		say "$caddyfile was not written by this script: left as it is."
	fi
	if grep -qxF "$BLOCK_START" "$config"; then
		without_block > "$config.new" && chmod --reference="$config" "$config.new" && mv "$config.new" "$config"
		say "Took the Caddy block out of $config; MineShell answers on the network again."
		restart_mineshell
	fi
}

main() {
	[ "$(id -u)" -ne 0 ] || fail "run this as the account MineShell runs as, not root (it uses sudo for Caddy only)."
	[ -f "$config" ] || fail "no MineShell settings file at $config (MINESHELL_CONFIG=... picks another)."
	if [ "${1:-}" = --remove ]; then
		remove
		return
	fi
	local domain="${1:-}"
	[ -n "$domain" ] || fail "usage: scripts/caddy.sh <domain name>   or   scripts/caddy.sh --remove"
	domain=$(printf '%s' "$domain" | tr 'A-Z' 'a-z')
	[[ "$domain" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] ||
		fail "$domain is not a domain name (a name such as panel.example.com, no http:// and no port)."

	# Everything that could refuse is checked before anything changes.
	[ "$(setting MINESHELL_AUTH | tr 'A-Z' 'a-z')" != off ] ||
		fail "MINESHELL_AUTH=off in $config: on a public address anyone could run your servers. Turn sign-in on first."
	command -v caddy >/dev/null && [ -d "$(dirname "$caddyfile")" ] ||
		fail "Caddy is not installed. Debian/Ubuntu: sudo apt install caddy (Fedora: sudo dnf install caddy), then run this again."
	local port
	port=$(setting PORT)
	port="${port:-3000}"

	local addresses
	addresses=$(getent ahosts "$domain" | awk '{ print $1 }' | sort -u | tr '\n' ' ' || true)
	[ -n "$addresses" ] || fail "$domain does not resolve to an address yet: point it at this machine's public address first."
	if printf '%s\n' $addresses | grep -qE '^(10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|169\.254\.|::1$|f[cd]|fe80)'; then
		say "Note: $domain resolves to $addresses, which includes a private address. Let's Encrypt has to reach the name from the internet on port 80 or 443 for a certificate."
	fi

	# Global, not local: the EXIT trap runs after main has returned.
	site=$(mktemp)
	trap 'rm -f "$site"' EXIT
	cat > "$site" <<-EOF
		$CADDY_MARKER
		# MineShell at https://$domain. Caddy passes X-Forwarded-For/-Proto/-Host on by itself
		# and streams the console's events through as they come.
		$domain {
		    reverse_proxy 127.0.0.1:$port
		}
	EOF
	caddy validate --adapter caddyfile --config "$site" >/dev/null 2>&1 || fail "Caddy refused the configuration it was given: caddy validate --adapter caddyfile --config $site"

	if [ -f "$caddyfile" ] && ! grep -qxF "$CADDY_MARKER" "$caddyfile" && ! is_default_caddyfile; then
		# A Caddyfile of someone else's: once it has a site for this name, that is taken as MineShell's.
		if ! grep -qE "^[[:space:]]*(https://)?${domain//./\\.}[[:space:]]*\{" "$caddyfile"; then
			say "$caddyfile has a configuration of its own, so it is left as it is. Add this to it, then run: sudo systemctl reload caddy"
			say ""
			sed -n '2,$p' "$site"
			say ""
			say "Then run this script again: it then makes MineShell answer only through Caddy."
			exit 1
		fi
		say "$caddyfile has a site for $domain already: left as it is."
	else
		say "Writing $caddyfile (sudo)."
		if [ -f "$caddyfile" ] && ! grep -qxF "$CADDY_MARKER" "$caddyfile"; then
			sudo cp -p "$caddyfile" "$caddyfile.before-mineshell"
		fi
		sudo install -m 644 "$site" "$caddyfile"
		sudo systemctl enable --quiet caddy 2>/dev/null || true
		sudo systemctl reload-or-restart caddy || fail "Caddy did not start: sudo journalctl -u caddy -n 50"
	fi

	{
		without_block
		printf '%s\n' "$BLOCK_START" "# https://$domain. Only this machine reaches MineShell's port; Caddy is the way in." \
			HOST=127.0.0.1 ADDRESS_HEADER=X-Forwarded-For XFF_DEPTH=1 "$BLOCK_END"
	} > "$config.new"
	chmod --reference="$config" "$config.new"
	mv "$config.new" "$config"
	say "MineShell now answers only on this machine ($config), and restarts."
	restart_mineshell

	say "Waiting for https://$domain (Caddy asks Let's Encrypt for the certificate the first time)."
	local i
	for i in $(seq 1 30); do
		if curl -fsS -o /dev/null --max-time 5 "https://$domain/login"; then
			say "MineShell is at https://$domain"
			say "Keep ports 80 and 443 open to this machine, and never MineShell's own port ($port)."
			return
		fi
		sleep 2
	done
	say "https://$domain does not answer yet. Check that the name points at this machine's public address, that ports 80"
	say "and 443 are forwarded to it, and what Caddy says: sudo journalctl -u caddy -n 50"
}

main "$@"
