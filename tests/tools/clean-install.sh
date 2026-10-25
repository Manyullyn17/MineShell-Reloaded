#!/usr/bin/env bash
# Installs MineShell on a fresh distribution in a Docker container with systemd
# as PID 1, the way docs/DEPLOYMENT.md says (a dedicated account, lingering,
# `machinectl shell`, the installer), and checks what a new user would see.
# Throwaway: containers and images are named mstest-clean-<distro>.
#
#   tests/tools/clean-install.sh run <distro> [archive]   # debian12 ubuntu2404 fedora arch
#   tests/tools/clean-install.sh shell <distro>           # a shell as the mineshell account
#   tests/tools/clean-install.sh rm <distro>              # remove the container and image
#
# Without an archive the installer and release come from GitHub (the latest);
# with one (dist/mineshell-<v>.tar.gz, `npm run build` + scripts/package.sh)
# this checkout's scripts/install.sh installs it. run does, in order:
#  1. the distribution's own Node (if it packages one): the installer must refuse it
#  2. a current Node (NodeSource on Debian/Ubuntu; the distribution's own elsewhere)
#  3. the install, then the owner password, signing in, a vanilla server with Java
#     downloaded, booted to "Done ("
#  4. a container restart: MineShell and the server must come back by themselves
#  5. doctor
# systemd in Docker needs --privileged (with its own cgroup namespace): the
# cgroup filesystem is read-only otherwise and systemd exits at once.
set -euo pipefail
cmd="${1:-}"
distro="${2:-}"
archive="${3:-}"
name="mstest-clean-$distro"
here="$(cd "$(dirname "$0")/../.." && pwd)"

case "$distro" in
debian12) base=debian:12 ;;
ubuntu2404) base=ubuntu:24.04 ;;
fedora) base=fedora:latest ;;
arch) base=archlinux:latest ;;
*) echo "Usage: $0 run|shell|rm debian12|ubuntu2404|fedora|arch [archive]" >&2; exit 1 ;;
esac

image() {
	local dir
	dir=$(mktemp -d)
	case "$distro" in
	debian12 | ubuntu2404)
		cat >"$dir/Dockerfile" <<EOF
FROM $base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv systemd-container dbus dbus-user-session libpam-systemd curl ca-certificates tar sudo procps nodejs && apt-get clean
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF
		;;
	fedora)
		cat >"$dir/Dockerfile" <<EOF
FROM $base
RUN dnf -y install systemd systemd-container curl tar procps-ng shadow-utils util-linux sudo && dnf clean all
# Fedora's /etc/shadow is mode 0000; in this container the user manager's PAM cannot read it
# ("could not obtain user info", user@.service fails), unlike on a real install.
RUN chmod 0400 /etc/shadow
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF
		;;
	arch)
		cat >"$dir/Dockerfile" <<EOF
FROM $base
RUN pacman -Syu --noconfirm systemd curl tar procps-ng sudo && pacman -Scc --noconfirm
STOPSIGNAL SIGRTMIN+3
CMD ["/usr/lib/systemd/systemd"]
EOF
		;;
	esac
	docker build -q -t "$name" "$dir" >/dev/null
	rm -rf "$dir"
}

in_box() { docker exec "$name" "$@"; }
# A login session as the account, as DEPLOYMENT says (machinectl shell); no pager.
as_user() { docker exec "$name" machinectl -q shell mineshell@ /bin/bash -lc "export SYSTEMD_PAGER=cat; $1" 2>&1; }
step() { printf '\n== %s\n' "$*"; }

boot_container() {
	docker rm -f "$name" >/dev/null 2>&1 || true
	docker run -d --name "$name" --hostname "$distro" --privileged --cgroupns=private \
		--tmpfs /run --tmpfs /run/lock "$name" >/dev/null
	for _ in $(seq 30); do
		state=$(in_box systemctl is-system-running 2>/dev/null || true)
		[[ "$state" == running || "$state" == degraded ]] && return 0
		sleep 1
	done
	echo "systemd did not come up in the container: $state" >&2
	exit 1
}

wait_done() {
	as_user "for i in \$(seq 100); do journalctl --user -u mineshell@clean -o cat --no-pager --since \"\$(systemctl --user show mineshell@clean -p ActiveEnterTimestamp --value | xargs -r -I{} date -d {} '+%F %T')\" 2>/dev/null | grep -q 'Done (' && { echo up; exit 0; }; sleep 3; done; echo 'not up after 300 s'; journalctl --user -u mineshell@clean -o cat --no-pager | tail -15; exit 1"
}

install_cmd() {
	if [[ -n "$archive" ]]; then
		echo "MINESHELL_ARCHIVE=/opt/$(basename "$archive") bash /opt/install.sh"
	else
		echo 'curl -fsSL https://github.com/Manyullyn17/MineShell-Reloaded/releases/latest/download/install.sh | bash'
	fi
}

case "$cmd" in
rm)
	docker rm -f "$name" >/dev/null 2>&1 || true
	docker rmi "$name" >/dev/null 2>&1 || true
	echo removed
	;;
shell)
	docker exec -it "$name" machinectl shell mineshell@
	;;
run)
	step "image $base"
	image
	boot_container
	in_box useradd --create-home --shell /bin/bash mineshell
	in_box loginctl enable-linger mineshell
	echo "lingering: $(in_box loginctl show-user mineshell -p Linger --value)"
	if [[ -n "$archive" ]]; then
		docker cp "$archive" "$name:/opt/"
		docker cp "$here/scripts/install.sh" "$name:/opt/install.sh"
		in_box chmod a+r "/opt/$(basename "$archive")" /opt/install.sh
	fi

	step "1. the distribution's Node: $(in_box sh -c 'command -v node >/dev/null && node -v || echo none')"
	as_user "$(install_cmd); echo \"installer exit \$?\"" | sed -E '/^(Connected|Connection)/d' | tail -4

	step "2. a current Node"
	case "$distro" in
	debian12 | ubuntu2404) in_box bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 && apt-get install -y nodejs >/dev/null 2>&1' ;;
	fedora) in_box bash -c 'dnf -y install nodejs >/dev/null 2>&1' ;;
	arch) in_box bash -c 'pacman -S --noconfirm nodejs >/dev/null 2>&1' ;;
	esac
	echo "node $(in_box node -v)"

	step "3. install"
	as_user "$(install_cmd); echo \"installer exit \$?\"" | sed -E '/^(Connected|Connection)/d' | tail -5
	in_box bash -c '
		U=http://127.0.0.1:3000; J=/tmp/cj; H=(-H "origin: $U" -H "x-sveltekit-action: true")
		echo "first visit: $(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" $U/)"
		echo "setup: $(curl -s -c $J -b $J "${H[@]}" -F password=clean-Install-1 -F confirm=clean-Install-1 $U/setup)"
		echo "sign in: $(curl -s -c $J -b $J "${H[@]}" -F username=admin -F password=clean-Install-1 "$U/login?/login")"
		echo "add a server: $(curl -s -b $J "${H[@]}" -F name=Clean -F minecraftVersion=1.21.1 -F modloader=vanilla -F acceptEula=on -F start=on "$U/instances/new?/loader" | head -c 160)"
		echo "with Java downloaded: $(curl -s -b $J "${H[@]}" -F name=Clean -F minecraftVersion=1.21.1 -F modloader=vanilla -F acceptEula=on -F start=on -F downloadJava=temurin "$U/instances/new?/loader")"'
	wait_done

	step "4. container restart"
	docker restart "$name" >/dev/null
	for _ in $(seq 30); do
		state=$(in_box systemctl is-system-running 2>/dev/null || true)
		[[ "$state" == running || "$state" == degraded ]] && break
		sleep 1
	done
	wait_done
	as_user 'systemctl --user is-active mineshell mineshell@clean | paste -sd " "'

	step "5. doctor"
	as_user 'cd ~/mineshell/current && MINESHELL_ENV_FILE=~/.config/mineshell/mineshell.env node scripts/doctor.mjs' | sed -E '/^(Connected|Connection)/d'
	printf '\nLeft running: %s (tests/tools/clean-install.sh shell|rm %s)\n' "$name" "$distro"
	;;
*)
	echo "Usage: $0 run|shell|rm <distro> [archive]" >&2
	exit 1
	;;
esac
