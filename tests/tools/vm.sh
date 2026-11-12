#!/usr/bin/env bash
# A real Ubuntu machine for what containers cannot show (22.04's systemd 249, 26.04's sudo-rs
# and Rust coreutils, a kernel of its own: a 24.04 host's AppArmor restriction reaches into
# containers): a libvirt VM per release, ms-jammy (22.04, the default) or ms-resolute
# (UBUNTU=26.04 before the command), with a `mineshell` user (passwordless sudo, lingering,
# this account's SSH key) and Node 24, kept as the snapshot `fresh`. Needs qemu-system-x86,
# libvirt-daemon-system, virtinst and cloud-image-utils, and this account in the libvirt group
# (a session older than that membership works through `sg libvirt`, which this script uses).
#
#   tests/tools/vm.sh create                 # the VM and its snapshot `fresh` (about 3 minutes)
#   tests/tools/vm.sh revert [snapshot]      # back to `fresh` (or another snapshot), running
#   tests/tools/vm.sh snapshot <name>        # keep the state as it is now
#   tests/tools/vm.sh ssh [command...]       # a shell (or a command) as mineshell
#   tests/tools/vm.sh install [archive|tag]  # MineShell through install.sh, the way a user does:
#                                            # a local archive (scripts/package.sh) or a GitHub tag
#   tests/tools/vm.sh ip | destroy
#
# The images (~700 MB each, checked against Ubuntu's SHA256SUMS) are kept in ~/vms; the VMs'
# disks and seeds are in libvirt's default pool. MineShell in the VM listens on <ip>:3000. To drive it
# with act.mjs and real-server.sh, put them in its release folder with devalue beside them
# (`npm i devalue` in that tests/tools) and set MINESHELL_AUTH=off in its settings file.
set -euo pipefail
UBUNTU="${UBUNTU:-22.04}"
case "$UBUNTU" in
22.04) NAME=ms-jammy OS_VARIANT=ubuntu22.04 ;;
# libosinfo has no 26.04 yet; the newest it knows gives the same virtual hardware.
26.04) NAME=ms-resolute OS_VARIANT=ubuntu25.10 ;;
*) echo "UBUNTU is 22.04 or 26.04." >&2; exit 1 ;;
esac
CACHE="$HOME/vms"
IMAGE="ubuntu-$UBUNTU-server-cloudimg-amd64.img"
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

create() {
	if virsh dominfo "$NAME" >/dev/null 2>&1; then echo "$NAME exists: tests/tools/vm.sh destroy first." >&2; exit 1; fi
	mkdir -p "$CACHE"
	cd "$CACHE"
	if [ ! -f "$IMAGE" ]; then
		curl -fsSL -o "SHA256SUMS-$UBUNTU" "https://cloud-images.ubuntu.com/releases/$UBUNTU/release/SHA256SUMS"
		curl -fsSL -o "$IMAGE.part" "https://cloud-images.ubuntu.com/releases/$UBUNTU/release/$IMAGE"
		grep " \\*\\{0,1\\}$IMAGE\$" "SHA256SUMS-$UBUNTU" | awk -v f="$IMAGE.part" '{ print $1 "  " f }' | sha256sum -c --quiet
		mv "$IMAGE.part" "$IMAGE"
	fi
	cat > "user-data-$NAME" <<-EOF
		#cloud-config
		hostname: $NAME
		users:
		  - name: mineshell
		    groups: [sudo]
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
	ssh_vm 'cloud-init status --wait >/dev/null
		curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null 2>&1
		sudo apt-get install -y nodejs >/dev/null 2>&1
		sudo loginctl enable-linger mineshell
		echo "$(lsb_release -ds), $(systemctl --version | head -n 1), Node $(node -v)"'
	virsh snapshot-create-as "$NAME" fresh "Ubuntu $UBUNTU, Node 24, user mineshell with lingering; nothing of MineShell" --atomic >/dev/null
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
ip) ip ;;
destroy)
	virsh destroy "$NAME" >/dev/null 2>&1 || true
	virsh undefine "$NAME" --snapshots-metadata --remove-all-storage
	;;
*) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
