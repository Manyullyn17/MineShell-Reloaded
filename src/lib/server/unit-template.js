/**
 * The systemd template unit every server runs as, in one place. Plain
 * JavaScript with no imports, so scripts/setup.mjs (plain Node, outside
 * SvelteKit) writes exactly what the app writes; systemd.ts fills the paths
 * from config.ts. setup.mjs used to keep its own copy, which drifted (it
 * lacked SuccessExitStatus=143 until MineShell's next start replaced it).
 */

/** Stands for the Restart= value; the settings page's preview shows it filled. */
export const RESTART_PLACEHOLDER = '${MS_RESTART_POLICY}';

/**
 * @param {{ prefix: string; instancesDir: string; unitsDir: string }} paths
 * @returns {string} the template, with Restart= still the placeholder
 */
export function renderTemplateUnit({ prefix, instancesDir, unitsDir }) {
	return `# Managed by MineShell. Regenerate from Settings > systemd, or \`npm run setup\`.
# One instance per Minecraft server: ${prefix}@<instance-id>.service
[Unit]
Description=Minecraft server (%i) managed by MineShell
After=network-online.target
Wants=network-online.target
# Crash-loop brake. MineShell writes these defaults; per-instance values set in
# the UI go into a drop-in next to this file, ${prefix}@<id>.service.d/restart.conf
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${instancesDir}/%i
EnvironmentFile=${unitsDir}/%i.env

# exec so systemd tracks the JVM directly. A wrapper that forks would break
# restart detection and resource accounting. <id>.once holds JVM arguments for
# one start only (answering a Forge startup question); the start deletes it.
ExecStart=/bin/sh -c 'f="${unitsDir}/%i.once"; a=; if [ -f "$f" ]; then a=$(cat "$f"); rm -f "$f"; fi; exec "$MS_JAVA" $MS_JVM_ARGS $a $MS_LAUNCH_ARGS'

# Minecraft installs a shutdown hook, so SIGTERM saves and exits cleanly.
# MineShell still prefers an RCON "stop" first and only falls back to this.
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=180
# The JVM exits 143 (128 + SIGTERM) when stopped that way, after saving. Only a
# stop asked for sends SIGTERM, so 143 is never a crash.
SuccessExitStatus=143

Restart=\${MS_RESTART_POLICY}
RestartSec=15

CPUAccounting=yes
MemoryAccounting=yes

StandardOutput=journal
StandardError=journal
SyslogIdentifier=${prefix}-%i

# Modest hardening. Instances still need write access to their own directory.
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=default.target
`;
}

/**
 * The template as installed: Restart= filled, so it is valid without a
 * per-instance drop-in.
 * @param {{ prefix: string; instancesDir: string; unitsDir: string }} paths
 */
export function installedTemplateUnit(paths) {
	return renderTemplateUnit(paths).replace(RESTART_PLACEHOLDER, 'on-failure');
}
