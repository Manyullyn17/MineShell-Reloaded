import fs from 'node:fs/promises';
import path from 'node:path';
import { restoreBisect } from './bisect';
import type { ServerInstance } from './db/schema';
import {
	audit,
	getInstance,
	isCleanroomInstallEntry,
	isLoaderInstallEntry,
	listInstances,
	restoreAside,
	setStatus,
	syncUnit
} from './instances';
import { restorePackChange } from './packchange';
import { removePartialSnapshots } from './snapshots';
import { restoreWorldChange } from './world';
import { restoreModUpdate } from './modupdates';
import { syncMods } from './mods';
import { endOperation, listOperations, PROCESS_TOKEN, type Journal, type RecordedOperation } from './operations';

/**
 * Runs once when MineShell starts: puts back every operation that a previous
 * MineShell process left unfinished (see operations.ts), and releases servers
 * a restart left marked as busy.
 *
 * - A journalled operation that never committed is rolled back from disk,
 *   the same way it is when it fails while MineShell keeps running.
 * - A first install that never finished is marked failed: there is nothing
 *   to go back to, and a half-installed server should not look usable.
 * - A server still marked busy without a journal had committed; only the
 *   steps after the commit (mod checks, unit sync) were cut short.
 * - Folders left over from committed operations are removed.
 *
 * Operations started by this process are never touched, which matters in dev
 * where a module reload can run startup code again.
 */

export type RecoveryOutcome = { instanceId: string; kind: Journal['kind'] | 'finish' | 'cleanup'; message: string };

const MESSAGES: Record<Journal['kind'], string> = {
	create:
		'Setup was interrupted when MineShell stopped, so this server is incomplete. Delete it and add it again.',
	'loader-change': 'MineShell stopped while changing the loader version; the previous version was put back.',
	'cleanroom-migration': 'MineShell stopped while moving this server to Cleanroom; it was put back on Forge.',
	'cleanroom-revert':
		'MineShell stopped while reverting to Forge. Run "Revert to Forge" again; it continues where it stopped.',
	'pack-change': 'MineShell stopped while changing the pack version; the server was put back as it was.',
	snapshot: 'MineShell stopped while snapshotting the world; the unfinished snapshot was removed.',
	'world-change': 'MineShell stopped while changing the world; the previous world was put back.',
	'mod-update': 'MineShell stopped while updating mods; the previous versions were put back.',
	bisect: 'MineShell stopped while searching for the mod behind a crash; the mods, world and configs were put back.'
};

async function restore(instance: ServerInstance, journal: Journal): Promise<void> {
	const root = instance.path;
	switch (journal.kind) {
		case 'loader-change':
			await restoreAside(root, path.join(root, journal.aside), journal.before, isLoaderInstallEntry);
			break;
		case 'cleanroom-migration':
			await restoreAside(root, path.join(root, journal.backup), journal.before, isCleanroomInstallEntry);
			break;
		case 'pack-change':
			await restorePackChange(root, journal);
			await syncMods(instance).catch(() => undefined);
			break;
		case 'world-change':
			await restoreWorldChange(root, journal);
			break;
		case 'mod-update':
			await restoreModUpdate(instance.id, root, journal);
			break;
		case 'bisect':
			await restoreBisect(instance, journal);
			break;
		case 'create':
		case 'cleanroom-revert':
		case 'snapshot':
			// Nothing to restore: an incomplete install, a revert that is safe
			// to rerun, a snapshot whose partial copy is removed below.
			break;
	}
}

const FAILED_STATUS: Journal['kind'][] = ['create', 'cleanroom-revert'];

async function recoverOne(instance: ServerInstance, op: RecordedOperation): Promise<RecoveryOutcome> {
	const { journal } = op;
	try {
		await restore(instance, journal);
	} catch (err) {
		// The journal stays, so the next start tries again.
		const message = `MineShell stopped during an operation (${journal.kind}) and putting it back failed: ${err instanceof Error ? err.message : 'unknown error'}. It is retried on the next start.`;
		setStatus(instance.id, 'failed', message);
		return { instanceId: instance.id, kind: journal.kind, message };
	}
	endOperation(instance.id);
	const message = MESSAGES[journal.kind];
	setStatus(instance.id, FAILED_STATUS.includes(journal.kind) ? 'failed' : 'ready', message);
	await syncUnit(instance).catch(() => undefined);
	audit('instance.recovered', { instanceId: instance.id, detail: journal.kind, actor: 'system' });
	return { instanceId: instance.id, kind: journal.kind, message };
}

/**
 * What an operation would have deleted had it got that far: the staging
 * folders of a committed one, and loader installers (and their logs and
 * partial downloads) of an install that died.
 */
async function removeLeftovers(instance: ServerInstance): Promise<boolean> {
	const internal = path.join(instance.path, '.mineshell');
	let removed = false;
	for (const name of await fs.readdir(internal).catch(() => [] as string[])) {
		if (
			/^(pack-change|loader-previous|world-previous|world-incoming|mod-update)-\d+$/.test(name) ||
			/installer\.jar(\.log|\.part)?$/.test(name)
		) {
			await fs.rm(path.join(internal, name), { recursive: true, force: true });
			removed = true;
		}
	}
	// A snapshot copy cut short.
	if (await removePartialSnapshots(instance.path)) removed = true;
	// A revert that committed has already moved every Forge file back; only
	// the manifest is left. A real backup (on Cleanroom) is never touched.
	if (instance.modloader !== 'cleanroom') {
		const backup = path.join(internal, 'forge-backup');
		const entries = await fs.readdir(backup).catch(() => null);
		if (entries && entries.every((n) => n === 'manifest.json')) {
			await fs.rm(backup, { recursive: true, force: true });
			removed = true;
		}
	}
	return removed;
}

export async function recoverInterruptedOperations(): Promise<RecoveryOutcome[]> {
	const outcomes: RecoveryOutcome[] = [];
	const operations = listOperations();
	const busy = new Set(operations.map((op) => op.instanceId));
	const ours = new Set(operations.filter((op) => op.process === PROCESS_TOKEN).map((op) => op.instanceId));

	for (const op of operations) {
		if (op.process === PROCESS_TOKEN) continue;
		const instance = getInstance(op.instanceId);
		if (!instance) {
			endOperation(op.instanceId);
			continue;
		}
		const outcome = await recoverOne(instance, op);
		outcomes.push(outcome);
		console.warn(`[mineshell] ${instance.id}: ${outcome.message}`);
	}

	// A recovery that failed keeps its journal, and its originals are still in
	// the folders cleanup would otherwise delete.
	const unrecovered = new Set(listOperations().map((op) => op.instanceId));
	for (const instance of listInstances()) {
		if (ours.has(instance.id)) continue;
		if (!busy.has(instance.id) && instance.status === 'provisioning') {
			const message =
				'MineShell stopped while finishing the last change. The change itself went through; if mods look wrong, use Sync on the Mods page.';
			setStatus(instance.id, 'ready', message);
			await syncUnit(instance).catch(() => undefined);
			outcomes.push({ instanceId: instance.id, kind: 'finish', message });
		}
		if (!unrecovered.has(instance.id) && (await removeLeftovers(instance).catch(() => false))) {
			outcomes.push({ instanceId: instance.id, kind: 'cleanup', message: 'Removed folders left by an interrupted operation.' });
		}
	}
	return outcomes;
}
