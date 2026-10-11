import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { operations, serverInstances, type ServerInstance } from './db/schema';

/**
 * Journal of the operation running on an instance, so one interrupted by
 * MineShell itself stopping (crash, restart, power loss) can be put back on
 * the next start (recovery.ts). Failures while MineShell keeps running are
 * rolled back in-process as before; this covers the process going away.
 *
 * The journal lives in the database, not in a marker file, because the
 * commit has to be atomic: an operation's result reaches server_instances
 * in the same transaction that deletes its journal row (commitOperation).
 * A row that still exists therefore always means "not committed", and
 * recovery can never undo a change that went through.
 *
 * What was already moved is not journalled step by step: every move is an
 * atomic rename into the operation's own folder, so recovery reads it from
 * disk. The journal only records what was there before and where things go.
 * Paths are relative to the instance folder.
 */

export type Journal =
	/** First install (pack or bare loader); nothing to restore, only to flag. */
	| { kind: 'create' }
	| {
			kind: 'loader-change';
			/** Folder the previous install is moved into. */
			aside: string;
			/** Loader install entries in the root before anything moved. */
			before: string[];
	  }
	| {
			kind: 'cleanroom-migration';
			/** The Forge backup folder (kept after a successful migration). */
			backup: string;
			before: string[];
	  }
	/** Retry-safe on its own; recovery only flags it for another run. */
	| { kind: 'cleanroom-revert' }
	| {
			/** Mods moved to other versions (modupdates.ts). */
			kind: 'mod-update';
			/** Folder the replaced jars move into. */
			staging: string;
			modsBefore: string[];
			/** The server's instance_mods rows before, written back on rollback. */
			rowsBefore: Record<string, unknown>[];
	  }
	/** A snapshot taken on request; a copy cut short is a `.partial` folder that recovery deletes. */
	| { kind: 'snapshot' }
	/**
	 * A scheduled snapshot (snapshotschedule.ts): `live` paused saving, which
	 * recovery turns back on; `stop` stopped the server, which recovery starts
	 * again (`restart`).
	 */
	| { kind: 'scheduled-snapshot'; mode: 'stopped' | 'live' | 'stop'; restart: boolean }
	| {
			/** Reset, replace or restore the world, or one dimension of it (world.ts). */
			kind: 'world-change';
			action: 'reset' | 'replace' | 'restore' | 'reset-dimension' | 'restore-dimension' | 'prune';
			/** Where the current world folders move: a snapshot being assembled, or a folder deleted afterwards. */
			aside: string;
			/** The snapshot `aside` is renamed to once complete, when one was wanted. */
			keepAs: string | null;
			/** World folders (or one dimension's folders) that existed, all moved aside. */
			worlds: string[];
			/** World folders the change puts in place. */
			placing: string[];
			/** Folder the incoming world is assembled in first. */
			incoming: string | null;
			/** server.properties values the change sets, as they were before. */
			propertiesBefore: Record<string, string> | null;
	  }
	| {
			/** The mod bisect assistant (bisect.ts): what it changes for its test runs, as it was. */
			kind: 'bisect';
			levelName: string;
			/** Jar file names (without .disabled) that were enabled. */
			enabledBefore: string[];
			autoRestartBefore: boolean;
			wantedRunningBefore: boolean;
	  }
	| {
			kind: 'pack-change';
			staging: string;
			oldConfigs: string;
			modsBefore: string[];
			/** Top-level folders the new version ships (moved to old-configs if present). */
			configs: string[];
			configsBefore: string[];
			/** Set just before the loader step starts; null while it has not. */
			loaderBefore: string[] | null;
			/** The world: its datapacks/ folder and what was in it, and world files the change creates. */
			world?: { datapacks: string; datapacksBefore: string[]; added: string[] };
	  }
	| {
			/** A move to another Minecraft version and/or loader (migrate.ts). */
			kind: 'migrate';
			/** Holds `mods/` (replaced and disabled jars) and `loader/` (the previous install). */
			staging: string;
			modsBefore: string[];
			/** The server's instance_mods rows before, written back on rollback. */
			rowsBefore: Record<string, unknown>[];
			/** Set just before the loader step starts; null while it has not. */
			loaderBefore: string[] | null;
	  };

/**
 * Identifies this MineShell process, kept on globalThis so a dev-mode module
 * reload keeps it: recovery must never act on an operation this process is
 * still running.
 */
const globals = globalThis as { __mineshellProcessToken?: string };
export const PROCESS_TOKEN = (globals.__mineshellProcessToken ??= crypto.randomUUID());

export class OperationInProgressError extends Error {}

export function beginOperation(instanceId: string, journal: Journal): void {
	const existing = db.select().from(operations).where(eq(operations.instanceId, instanceId)).get();
	if (existing) {
		throw new OperationInProgressError(`Another operation (${existing.kind}) is still recorded as running on this server.`);
	}
	db.insert(operations)
		.values({
			instanceId,
			kind: journal.kind,
			journal: JSON.stringify(journal),
			process: PROCESS_TOKEN,
			startedAt: Date.now()
		})
		.run();
}

/** Records more of the journal once it is known (the pack change's loader step). */
export function updateOperation(instanceId: string, journal: Journal): void {
	db.update(operations).set({ journal: JSON.stringify(journal) }).where(eq(operations.instanceId, instanceId)).run();
}

/** The operation finished without changing anything that needs committing, or was rolled back. */
export function endOperation(instanceId: string): void {
	db.delete(operations).where(eq(operations.instanceId, instanceId)).run();
}

/** Writes the operation's result and drops its journal in one transaction. */
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** `also` writes what belongs to the result in the same transaction (a pack change's record). */
export function commitOperation(instanceId: string, changes: Partial<ServerInstance>, also?: (tx: Transaction) => void): void {
	db.transaction((tx) => {
		tx.update(serverInstances)
			.set({ ...changes, updatedAt: Date.now() })
			.where(eq(serverInstances.id, instanceId))
			.run();
		also?.(tx);
		tx.delete(operations).where(eq(operations.instanceId, instanceId)).run();
	});
}

export type RecordedOperation = { instanceId: string; journal: Journal; process: string; startedAt: number };

export function listOperations(): RecordedOperation[] {
	return db
		.select()
		.from(operations)
		.all()
		.map((row) => ({
			instanceId: row.instanceId,
			journal: JSON.parse(row.journal) as Journal,
			process: row.process,
			startedAt: row.startedAt
		}));
}
