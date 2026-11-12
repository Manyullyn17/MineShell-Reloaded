#!/usr/bin/env bash
# What a running server's sandbox lets it see, read from outside through /proc: whether it
# has the sandbox drop-in, a mount namespace of its own, its AppArmor label (systemd-userns
# alone, never stacked with Ubuntu's unprivileged_userns, which cuts a shim profile's network:
# Launchpad #2168612; Fedora's SELinux label instead), its seccomp mode, and what of the
# account's files it can list.
#
#   tests/tools/sandbox-check.sh <unit, e.g. mstest@fabric> [path to try]...
#
# Reading only; safe on a real install. Paths default to $HOME, the server's own folder and
# its data directory's units/ (other servers' env files, which it must not see).
set -uo pipefail
unit="$1"; shift
pid=$(systemctl --user show -p MainPID --value "$unit")
[[ -z "$pid" || "$pid" == 0 ]] && { echo "$unit is not running"; exit 1; }
dir=$(systemctl --user show -p WorkingDirectory --value "$unit")
dropin=$(systemctl --user show -p DropInPaths --value "$unit" | tr ' ' '\n' | grep sandbox.conf)
own=$( [[ "$(readlink /proc/$pid/ns/mnt)" != "$(readlink /proc/self/ns/mnt)" ]] && echo own || echo "SHARED with this shell" )
echo "$unit (pid $pid)"
echo "  sandbox.conf:    ${dropin:-none}"
echo "  mount namespace: $own"
# The label of whichever of AppArmor (Ubuntu) and SELinux (Fedora) runs; Arch has neither.
# SELinux ends its label with a NUL.
lsm=$(cat /sys/kernel/security/lsm 2>/dev/null)
if [[ ",$lsm," == *,apparmor,* ]]; then echo "  AppArmor label:  $(cat /proc/$pid/attr/current)"
elif [[ ",$lsm," == *,selinux,* ]]; then echo "  SELinux label:   $(tr -d '\0' < /proc/$pid/attr/current) ($(getenforce 2>/dev/null))"
else echo "  label:           none (neither AppArmor nor SELinux runs)"; fi
echo "  seccomp:         $(awk '/^Seccomp:/{print $2}' /proc/$pid/status) (2 = filtered)"
paths=("$@")
(( ${#paths[@]} )) || paths=("$HOME" "$dir" "$(dirname "$(dirname "$dir")")/units")
for p in "${paths[@]}"; do
	echo "  sees $p: $(ls -A "/proc/$pid/root$p" 2>&1 | head -5 | tr '\n' ' ')"
done
