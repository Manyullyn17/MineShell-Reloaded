#!/usr/bin/env bash
# A real Ubuntu 22.04 machine for what containers cannot show (systemd 249, a kernel of its
# own: a 24.04 host's AppArmor restriction reaches into containers): a libvirt VM named
# ms-jammy with a `mineshell` user (passwordless sudo, lingering, this account's SSH key) and
# Node 24, kept as the snapshot `fresh`. Needs qemu-system-x86, libvirt-daemon-system,
# virtinst and cloud-image-utils, and this account in the libvirt group (a session older than
# that membership works through `sg libvirt`, which this script uses).
#
#   tests/tools/vm.sh create                 # the VM and its snapshot `fresh` (about 3 minutes)
#   tests/tools/vm.sh revert [snapshot]      # back to `fresh` (or another snapshot), running
#   tests/tools/vm.sh snapshot <name>        # keep the state as it is now
#   tests/tools/vm.sh ssh [command...]       # a shell (or a command) as mineshell
#   tests/tools/vm.sh install [archive|tag]  # MineShell through install.sh, the way a user does:
#                                            # a local archive (scripts/package.sh) or a GitHub tag
#   tests/tools/vm.sh ip | destroy
#
# The image (~700 MB, checked against Ubuntu's SHA256SUMS) is kept in ~/vms; the VM's disk and
# seed are in libvirt's default pool. MineShell in the VM listens on <ip>:3000. To drive it
# with act.mjs and real-server.sh, put them in its release folder with devalue beside them
# (`npm i devalue` in that tests/tools) and set MINESHELL_AUTH=off in its settings file.
set -euo pipefail
NAME=ms-jammy
CACHE="$HOME/vms"
IMAGE=jammy-server-cloudimg-amd64.img
here="$(cd "$(dirname "$0")/../.." && pwd)"
virsh() { sg libvirt -c "virsh -c qemu:///system $(printf '%q ' "$@")"; }
ip() { virsh domifaddr "$NAME" | awk '/ipv4/ { sub("/.*", "", $4); print $4 }'; }
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$CACHE/known_hosts" -o ConnectTimeout=3)
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
		curl -fsSLO https://cloud-images.ubuntu.com/releases/22.04/release/SHA256SUMS
		curl -fsSL -o "$IMAGE" https://cloud-images.ubuntu.com/releases/22.04/release/ubuntu-22.04-server-cloudimg-amd64.img
		grep 'ubuntu-22.04-server-cloudimg-amd64.img$' SHA256SUMS | awk -v f="$IMAGE" '{ print $1 "  " f }' | sha256sum -c --quiet
	fi
	cat > user-data <<-EOF
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
	printf 'instance-id: %s-1\nlocal-hostname: %s\n' "$NAME" "$NAME" > meta-data
	cloud-localds seed.iso user-data meta-data
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
	virsh vol-create-as default "$NAME-seed.iso" "$(stat -c %s seed.iso)" --format raw
	virsh vol-upload --pool default "$NAME-seed.iso" seed.iso
	sg libvirt -c "virt-install --connect qemu:///system --name $NAME --memory 8192 --vcpus 2 --cpu host-passthrough \
		--os-variant ubuntu22.04 --import --disk vol=default/$NAME.qcow2,bus=virtio \
		--disk vol=default/$NAME-seed.iso,device=cdrom --network network=default,model=virtio \
		--graphics none --noautoconsole" >/dev/null
	rm -f "$CACHE/known_hosts"
	wait_ssh
	ssh_vm 'cloud-init status --wait >/dev/null
		curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null 2>&1
		sudo apt-get install -y nodejs >/dev/null 2>&1
		sudo loginctl enable-linger mineshell
		echo "$(lsb_release -ds), $(systemctl --version | head -n 1), Node $(node -v)"'
	virsh snapshot-create-as "$NAME" fresh "Ubuntu 22.04, Node 24, user mineshell with lingering; nothing of MineShell" --atomic >/dev/null
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
	rm -f "$CACHE/known_hosts"
	wait_ssh
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
*) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
