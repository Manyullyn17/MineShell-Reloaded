#!/usr/bin/env bash
# A real machine for what containers cannot show (22.04's systemd 249, 26.04's sudo-rs and
# Rust coreutils, Fedora's SELinux, a kernel of its own: a 24.04 host's AppArmor restriction
# reaches into containers): a libvirt VM per system, picked by OS before the command:
# ms-jammy (22.04, the default), ms-resolute (26.04), ms-fedora (Fedora 45) or ms-arch (Arch's
# latest cloud image, brought up to date). Each has a `mineshell` user (passwordless sudo,
# lingering, this account's SSH key) and Node (24 on Ubuntu, the distribution's own elsewhere:
# Fedora 45's is 22, above MineShell's minimum), kept as the snapshot `fresh`. Needs
# qemu-system-x86, libvirt-daemon-system, virtinst and cloud-image-utils, and this account in
# the libvirt group (a session older than that membership works through `sg libvirt`, which
# this script uses). UBUNTU=26.04 still means OS=26.04.
#
#   tests/tools/vm.sh create                 # the VM and its snapshot `fresh` (a few minutes)
#   tests/tools/vm.sh revert [snapshot]      # back to `fresh` (or another snapshot), running
#   tests/tools/vm.sh snapshot <name>        # keep the state as it is now
#   tests/tools/vm.sh ssh [command...]       # a shell (or a command) as mineshell
#   tests/tools/vm.sh install [archive|tag]  # MineShell through install.sh, the way a user does:
#                                            # a local archive (scripts/package.sh) or a GitHub tag
#   tests/tools/vm.sh tools                  # this checkout's tests/tools into the installed
#                                            # release, with devalue, and MINESHELL_AUTH=off
#   tests/tools/vm.sh ip | destroy
#
# The images (600-700 MB each, checked against their distribution's checksum file) are kept
# in ~/vms; the VMs' disks and seeds are in libvirt's default pool. MineShell in the VM
# listens on <ip>:3000. After `install` and `tools`, the weekly workflow's lifecycle run:
#   vm.sh ssh 'cd ~/mineshell/current && U=http://127.0.0.1:3000 PREFIX=mineshell \
#     DATA=~/.local/share/mineshell APP=~/mineshell/current tests/tools/real-server.sh'
set -euo pipefail
OS="${OS:-${UBUNTU:-22.04}}"
FEDORA=45
# ADMIN: the group cloud-init puts mineshell in; NODE: how Node 24+ gets there (NodeSource on
# Ubuntu, whose own is older; the distribution's own on Fedora and Arch, as clean-install.sh).
case "$OS" in
22.04 | 26.04)
	IMAGE="ubuntu-$OS-server-cloudimg-amd64.img"
	BASE="https://cloud-images.ubuntu.com/releases/$OS/release"
	SUMS=SHA256SUMS ADMIN=sudo
	NODE='curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null 2>&1
		sudo apt-get install -y nodejs >/dev/null 2>&1'
	;;&
22.04) NAME=ms-jammy OS_VARIANT=ubuntu22.04 ;;
# libosinfo has no 26.04 yet; the newest it knows gives the same virtual hardware.
26.04) NAME=ms-resolute OS_VARIANT=ubuntu25.10 ;;
fedora)
	# libosinfo here stops at Fedora 42 (same virtual hardware). Fedora's image names carry a
	# respin number, read from the folder's checksum file.
	NAME=ms-fedora OS_VARIANT=fedora42 ADMIN=wheel
	BASE="https://dl.fedoraproject.org/pub/fedora/linux/releases/$FEDORA/Cloud/x86_64/images"
	IMAGE="fedora-$FEDORA-cloud-generic.qcow2" SUMS=
	NODE='sudo dnf -y install nodejs >/dev/null 2>&1'
	;;
arch)
	NAME=ms-arch OS_VARIANT=archlinux ADMIN=wheel
	BASE=https://geo.mirror.pkgbuild.com/images/latest
	IMAGE=Arch-Linux-x86_64-cloudimg.qcow2 SUMS=
	# A full upgrade with it: Arch does not support installing onto an older system.
	NODE='sudo pacman -Syu --noconfirm nodejs >/dev/null 2>&1'
	;;
*) echo "OS is 22.04, 26.04, fedora or arch." >&2; exit 1 ;;
esac
CACHE="$HOME/vms"
KNOWN="$CACHE/known_hosts-$NAME"
here="$(cd "$(dirname "$0")/../.." && pwd)"
virsh() { sg libvirt -c "virsh -c qemu:///system $(printf '%q ' "$@")"; }
# The address from libvirt's DHCP leases, else from the host's ARP table: a VM back from a
# snapshot keeps the address it had, and after the host restarted (or its lease ran out)
# libvirt has no lease for it, so `revert` waited three minutes and gave up ("No SSH").
ip() {
	local source addr
	for source in lease arp; do
		addr=$(virsh domifaddr "$NAME" --source "$source" 2>/dev/null | awk '/ipv4/ { sub("/.*", "", $4); print $4; exit }')
		[ -n "$addr" ] && break
	done
	echo "$addr"
}
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$KNOWN" -o ConnectTimeout=3)
ssh_vm() { ssh "${SSH_OPTS[@]}" "mineshell@$(ip)" "$@"; }

wait_ssh() {
	for _ in $(seq 60); do
		local addr
		addr=$(ip)
		[ -n "$addr" ] && ssh "${SSH_OPTS[@]}" "mineshell@$addr" true 2>/dev/null && return 0
		sleep 3
	done
	echo "No SSH to $NAME." >&2
	return 1
}

# Downloads the image and checks it against the distribution's published SHA256.
fetch_image() {
	local file="$IMAGE" sum
	case "$OS" in
	22.04 | 26.04)
		curl -fsSL -o "SHA256SUMS-$OS" "$BASE/SHA256SUMS"
		sum=$(awk -v f="$IMAGE" '$2 == f || $2 == "*" f { print $1 }' "SHA256SUMS-$OS")
		;;
	fedora)
		local list
		list=$(curl -fsSL "$BASE/")
		file=$(grep -oE "Fedora-Cloud-Base-Generic-$FEDORA-[0-9.]+\.x86_64\.qcow2" <<< "$list" | head -n 1)
		curl -fsSL -o "CHECKSUM-fedora-$FEDORA" "$BASE/$(grep -oE "Fedora-Cloud-$FEDORA-[0-9.]+-x86_64-CHECKSUM" <<< "$list" | head -n 1)"
		sum=$(awk -v f="($file)" '$1 == "SHA256" && $2 == f { print $4 }' "CHECKSUM-fedora-$FEDORA")
		;;
	arch)
		curl -fsSL -o SHA256-arch "$BASE/$IMAGE.SHA256"
		sum=$(awk '{ print $1 }' SHA256-arch)
		;;
	esac
	[ -n "$sum" ] || { echo "No checksum for $file." >&2; exit 1; }
	curl -fsSL -o "$IMAGE.part" "$BASE/$file"
	echo "$sum  $IMAGE.part" | sha256sum -c --quiet
	mv "$IMAGE.part" "$IMAGE"
}

create() {
	if virsh dominfo "$NAME" >/dev/null 2>&1; then echo "$NAME exists: tests/tools/vm.sh destroy first." >&2; exit 1; fi
	mkdir -p "$CACHE"
	cd "$CACHE"
	[ -f "$IMAGE" ] || fetch_image
	cat > "user-data-$NAME" <<-EOF
		#cloud-config
		hostname: $NAME
		users:
		  - name: mineshell
		    groups: [$ADMIN]
		    shell: /bin/bash
		    sudo: "ALL=(ALL) NOPASSWD:ALL"
		    lock_passwd: true
		    ssh_authorized_keys:
		      - $(cat "$HOME"/.ssh/id_ed25519.pub)
		ssh_pwauth: false
	EOF
	printf 'instance-id: %s-1\nlocal-hostname: %s\n' "$NAME" "$NAME" > "meta-data-$NAME"
	cloud-localds "seed-$NAME.iso" "user-data-$NAME" "meta-data-$NAME"
	if ! virsh pool-info default >/dev/null 2>&1; then
		virsh pool-define-as default dir --target /var/lib/libvirt/images
		virsh pool-build default
		virsh pool-start default
		virsh pool-autostart default
	fi
	# The image's own size: its JSON also lists the file's, under "children".
	virsh vol-create-as default "$NAME.qcow2" "$(qemu-img info --output=json "$IMAGE" | node -p 'JSON.parse(require("fs").readFileSync(0))["virtual-size"]')" --format qcow2
	virsh vol-upload --pool default "$NAME.qcow2" "$IMAGE"
	virsh vol-resize --pool default "$NAME.qcow2" 20G
	virsh vol-create-as default "$NAME-seed.iso" "$(stat -c %s "seed-$NAME.iso")" --format raw
	virsh vol-upload --pool default "$NAME-seed.iso" "seed-$NAME.iso"
	sg libvirt -c "virt-install --connect qemu:///system --name $NAME --memory 8192 --vcpus 2 --cpu host-passthrough \
		--os-variant $OS_VARIANT --import --disk vol=default/$NAME.qcow2,bus=virtio \
		--disk vol=default/$NAME-seed.iso,device=cdrom --network network=default,model=virtio \
		--graphics none --noautoconsole" >/dev/null
	rm -f "$KNOWN"
	wait_ssh
	ssh_vm "cloud-init status --wait >/dev/null
		$NODE
		sudo loginctl enable-linger mineshell
		. /etc/os-release; echo \"\$PRETTY_NAME, \$(systemctl --version | head -n 1), Node \$(node -v)\""
	virsh snapshot-create-as "$NAME" fresh "$OS, Node, user mineshell with lingering; nothing of MineShell" --atomic >/dev/null
	echo "$NAME at $(ip), snapshot fresh taken."
}

install_mineshell() {
	local what="${1:-}"
	if [ -n "$what" ] && [ -f "$what" ]; then
		scp -q "${SSH_OPTS[@]}" "$what" "$here/scripts/install.sh" "mineshell@$(ip):"
		ssh_vm "MINESHELL_ARCHIVE=\$HOME/$(basename "$what") bash \$HOME/install.sh"
	else
		ssh_vm "curl -fsSL https://github.com/Manyullyn17/MineShell-Reloaded/releases/latest/download/install.sh | ${what:+MINESHELL_VERSION=$what }bash"
	fi
}

# act.mjs needs devalue, which the release does not carry, and Arch's Node comes without npm.
tools() {
	tar -C "$here" --transform 's,^node_modules/,tests/tools/node_modules/,' -cf - tests/tools node_modules/devalue |
		ssh_vm 'set -e; cd ~/mineshell/current; rm -rf tests/tools; tar -xf -
			f=~/.config/mineshell/mineshell.env
			grep -q "^MINESHELL_AUTH=" "$f" && sed -i "s/^MINESHELL_AUTH=.*/MINESHELL_AUTH=off/" "$f" || echo MINESHELL_AUTH=off >> "$f"
			systemctl --user restart mineshell
			for _ in $(seq 30); do curl -fs -o /dev/null http://127.0.0.1:3000/ && exit 0; sleep 1; done
			echo "MineShell did not come back." >&2; exit 1'
}

case "${1:-}" in
create) create ;;
revert)
	virsh snapshot-revert "$NAME" "${2:-fresh}" --running
	rm -f "$KNOWN"
	wait_ssh
	# The guest's clock comes back from the snapshot, minutes behind, until NTP catches up; the
	# first Java download after a revert failed ("fetch failed") while it was.
	ssh_vm "sudo date -s @$(date +%s) >/dev/null"
	echo "$NAME back at ${2:-fresh}, $(ip)."
	;;
snapshot) virsh snapshot-create-as "$NAME" "${2:?a name}" --atomic ;;
ssh) shift; ssh_vm "$@" ;;
install) install_mineshell "${2:-}" ;;
tools) tools ;;
ip) ip ;;
destroy)
	virsh destroy "$NAME" >/dev/null 2>&1 || true
	virsh undefine "$NAME" --snapshots-metadata --remove-all-storage
	;;
*) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
