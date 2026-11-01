#!/usr/bin/env bash
# scripts/caddy.sh against fakes: sudo, caddy, systemctl, getent and curl are stand-ins on
# PATH, the Caddyfile and the settings file throwaway ones, so nothing on the machine changes.
# Runs each case and says what went wrong, if anything:
#
#   tests/tools/caddy-check.sh
#
# The cases: the distribution's default Caddyfile is replaced (and kept), a rerun with
# another name replaces only the script's own, a Caddyfile of someone else's is left alone
# until it has the site, MINESHELL_AUTH=off and a name that does not resolve are refused,
# and --remove puts both files back.
set -uo pipefail
script="$(cd "$(dirname "$0")/../.." && pwd)/scripts/caddy.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/etc/caddy"
log="$work/calls"

fake() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$work/bin/$1"; chmod +x "$work/bin/$1"; }
fake sudo 'echo "sudo $*" >> '"$log"'; "$@"'
fake caddy 'exit 0'
fake systemctl 'echo "systemctl $*" >> '"$log"
fake getent '[ "$2" = nowhere.example ] && exit 2; echo "203.0.113.7 STREAM $2"'
fake curl 'exit 0'
fake sleep 'exit 0'

failures=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi; }
run() {
	PATH="$work/bin:$PATH" MINESHELL_CONFIG="$work/mineshell.env" CADDYFILE="$work/etc/caddy/Caddyfile" \
		bash "$script" "$@" > "$work/out" 2>&1
}
reset() {
	: > "$log"
	printf 'MINESHELL_AUTH=on\nPORT=3123\nHOST=0.0.0.0\n' > "$work/mineshell.env"
	chmod 600 "$work/mineshell.env"
	printf '# The Caddyfile is an easy way to configure your Caddy web server.\n:80 {\n\t# Set this path to your site'"'"'s directory.\n\troot * /usr/share/caddy\n\n\t# Enable the static file server.\n\tfile_server\n}\n' > "$work/etc/caddy/Caddyfile"
	rm -f "$work/etc/caddy/Caddyfile.before-mineshell"
}

reset
run panel.example.com
check 'replaces the default Caddyfile' 'grep -q "^panel.example.com {" "$work/etc/caddy/Caddyfile" && grep -q "reverse_proxy 127.0.0.1:3123" "$work/etc/caddy/Caddyfile"'
check 'keeps the default one' 'grep -q file_server "$work/etc/caddy/Caddyfile.before-mineshell"'
check 'binds MineShell to this machine, after its own HOST line' '[ "$(sed -n "s/^HOST=//p" "$work/mineshell.env" | tail -n 1)" = 127.0.0.1 ] && grep -qx ADDRESS_HEADER=X-Forwarded-For "$work/mineshell.env" && grep -qx XFF_DEPTH=1 "$work/mineshell.env"'
check 'keeps the settings file private' '[ "$(stat -c %a "$work/mineshell.env")" = 600 ]'
check 'reloads Caddy and restarts MineShell' 'grep -q "systemctl reload-or-restart caddy" "$log" && grep -q "systemctl --user restart mineshell" "$log"'

run other.example.com
check 'a rerun replaces only its own site and block' '! grep -q panel.example.com "$work/etc/caddy/Caddyfile" && grep -q "^other.example.com {" "$work/etc/caddy/Caddyfile" && [ "$(grep -c "^HOST=127.0.0.1" "$work/mineshell.env")" = 1 ] && grep -q file_server "$work/etc/caddy/Caddyfile.before-mineshell"'

run --remove
check '--remove puts the Caddyfile back' 'grep -q file_server "$work/etc/caddy/Caddyfile" && [ ! -e "$work/etc/caddy/Caddyfile.before-mineshell" ]'
check '--remove takes the block out' '! grep -q caddy.sh "$work/mineshell.env" && grep -qx HOST=0.0.0.0 "$work/mineshell.env" && [ "$(stat -c %a "$work/mineshell.env")" = 600 ]'

reset
printf 'files.example.com {\n\tfile_server\n}\n' > "$work/etc/caddy/Caddyfile"
run panel.example.com; code=$?
check "leaves someone else's Caddyfile alone, printing the site" '[ $code -ne 0 ] && grep -q "reverse_proxy 127.0.0.1:3123" "$work/out" && ! grep -q panel "$work/etc/caddy/Caddyfile" && ! grep -q caddy.sh "$work/mineshell.env"'
printf 'panel.example.com {\n\treverse_proxy 127.0.0.1:3123\n}\n' >> "$work/etc/caddy/Caddyfile"
run panel.example.com; code=$?
check 'and goes on once it has the site' '[ $code -eq 0 ] && grep -q files.example.com "$work/etc/caddy/Caddyfile" && grep -qx HOST=127.0.0.1 "$work/mineshell.env"'
run --remove
check "--remove leaves someone else's Caddyfile" 'grep -q files.example.com "$work/etc/caddy/Caddyfile" && ! grep -q caddy.sh "$work/mineshell.env"'

reset
printf 'MINESHELL_AUTH=off\n' >> "$work/mineshell.env"
run panel.example.com; code=$?
check 'refuses with sign-in off, changing nothing' '[ $code -ne 0 ] && grep -q MINESHELL_AUTH "$work/out" && grep -q file_server "$work/etc/caddy/Caddyfile" && ! grep -q caddy.sh "$work/mineshell.env"'

reset
run nowhere.example; code=$?
check 'refuses a name that does not resolve' '[ $code -ne 0 ] && grep -q "does not resolve" "$work/out" && grep -q file_server "$work/etc/caddy/Caddyfile"'
run 'http://panel.example.com:443'; code=$?
check 'refuses what is not a domain name' '[ $code -ne 0 ] && grep -q "not a domain name" "$work/out"'

[ "$failures" -eq 0 ] && echo "all passed" || { echo "$failures failed; the last output:"; cat "$work/out"; exit 1; }
