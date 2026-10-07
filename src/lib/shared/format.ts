/** Formatting helpers shared by every view. Pure, no server imports. */

export function formatBytes(bytes: number, digits = 1): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / Math.pow(1024, i);
	return `${i === 0 ? Math.round(value) : value.toFixed(digits)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return '0m';
	const totalMinutes = Math.floor(ms / 60000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

/** A short span to the second: "45s", "2m 31s", "1h 4m". For start times, where minutes are too coarse. */
export function formatSeconds(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total >= 3600) return formatDuration(ms);
	const m = Math.floor(total / 60);
	const s = total % 60;
	return m ? `${m}m ${s}s` : `${s}s`;
}

export function formatRelative(timestamp: number | null | undefined): string {
	if (!timestamp) return 'never';
	const diff = timestamp - Date.now();
	const abs = Math.abs(diff);
	const minutes = Math.round(abs / 60000);
	if (minutes < 1) return diff > 0 ? 'in under a minute' : 'just now';
	if (minutes < 60) return diff > 0 ? `in ${minutes}m` : `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return diff > 0 ? `in ${hours}h` : `${hours}h ago`;
	const days = Math.round(hours / 24);
	return diff > 0 ? `in ${days}d` : `${days}d ago`;
}

export function formatDateTime(timestamp: number | null | undefined): string {
	if (!timestamp) return '-';
	return new Date(timestamp).toLocaleString(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short'
	});
}

/** Turn a systemd ActiveState/SubState pair into something a person can act on. */
/**
 * systemd's own words for "stopped restarting it": the unit crashed more
 * often than StartLimitBurst allows within the window (the server's crash
 * restart limit), so it was left failed.
 */
export function gaveUpAfter(active: string, result: string, limit: number): number | null {
	return active === 'failed' && result === 'start-limit-hit' ? limit : null;
}

export function describeState(active: string, sub: string): {
	label: string;
	tone: 'running' | 'stopped' | 'busy' | 'failed';
} {
	if (active === 'active' && sub === 'running') return { label: 'Running', tone: 'running' };
	if (active === 'activating') return { label: 'Starting', tone: 'busy' };
	if (active === 'deactivating') return { label: 'Stopping', tone: 'busy' };
	if (sub === 'auto-restart') return { label: 'Restarting after a crash', tone: 'busy' };
	if (active === 'failed') return { label: 'Crashed', tone: 'failed' };
	if (active === 'unknown') return { label: 'Unknown', tone: 'failed' };
	return { label: 'Stopped', tone: 'stopped' };
}
