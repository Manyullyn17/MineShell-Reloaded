/**
 * A time as `systemctl show --timestamp=us+utc` prints it, the way unitState reads a unit's
 * ActiveEnterTimestamp= and ExecMainStartTimestamp=: "Wed 2026-11-11 21:10:05.029405 UTC".
 */
export function systemdStamp(ms: number): string {
	const us = Math.round(ms * 1000);
	const iso = new Date(Math.floor(us / 1000)).toISOString();
	return `Wed ${iso.slice(0, 10)} ${iso.slice(11, 19)}.${String(us % 1_000_000).padStart(6, '0')} UTC`;
}

/** A pretend boot a day ago, for tests that count a unit's start from it. */
export const BOOT_MS = Date.now() - 24 * 3_600_000;

/** systemd's stamp for `us` microseconds after BOOT_MS (as the monotonic stamps count). */
export const sinceBoot = (us: number): string => systemdStamp(BOOT_MS + us / 1000);
