import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db';
import { instanceMods, type ServerInstance } from './db/schema';
import {
	bestVersion,
	installModVersion,
	listInstanceMods,
	modsDir,
	setModEnabled,
	setModLocked,
	type ModRow,
	type ProjectVersion
} from './mods';
import {
	compatibleVersions,
	disableStaged,
	eachLimited,
	filterFor,
	resolveDependencies,
	restoreModUpdate,
	trackable,
	type DependencyPlan,
	type ResolvedDependency
} from './modupdates';
import { getLoader, type ModloaderId } from './modloaders';
import { compareVersions, resolveJava } from './java';
import { snapshotStep } from './snapshots';
import { startTask } from './tasks';
import {
	beginOperation,
	commitOperation,
	endOperation,
	OperationInProgressError,
	updateOperation,
	type Journal
} from './operations';
import {
	audit,
	InstanceError,
	isLoaderInstallEntry,
	javaTarget,
	listEntries,
	obtainJava,
	planJava,
	requireInstance,
	requireStopped,
	restoreAside,
	setStatus,
	syncUnit
} from './instances';
import type { JavaVendor } from './javadownload';

/**
 * Moving a server to another Minecraft version and/or loader (1.20.1 Forge
 * to 1.21.1 NeoForge), which before only relabelled it. A pack server moves
 * with its pack instead (packchange.ts): this is for servers whose mods are
 * the user's own.
 *
 * - The loader is reinstalled for the target, its previous install moved aside.
 * - Every mod MineShell can look up (Modrinth, CurseForge) moves to its best
 *   build for the target, with required dependencies the new builds bring.
 *   Mods with no build for the target, and jars it cannot look up, are
 *   disabled (the user's call: listed in the preview, re-enabled by hand).
 * - Configs, the world and server.properties are left alone. Only upgrades:
 *   a world opened by a newer Minecraft does not load in an older one.
 * - Journalled (`migrate`): a failure or a crash puts mods, records and the
 *   loader back as they were.
 */

export type MigrationJournal = Extract<Journal, { kind: 'migrate' }>;

export type MigrationTarget = { minecraft: string; loader: ModloaderId; loaderVersion: string | null };

export type MigrationModPlan = {
	fileName: string;
	name: string;
	from: string | null;
	action: 'update' | 'keep' | 'disable';
	/** The version moved to, for `update`. */
	to: string | null;
	/** Why it is disabled. */
	reason: string | null;
	/** Disabled already: updated when there is a build, otherwise left as it is. */
	disabled: boolean;
};

export type MigrationPlan = {
	current: { minecraft: string; loader: string; loaderVersion: string | null };
	target: MigrationTarget;
	minecraftChange: boolean;
	mods: MigrationModPlan[];
	dependencies: DependencyPlan;
	requiredJava: number;
};

type Prepared = {
	plan: MigrationPlan;
	updates: Map<string, { row: ModRow; version: ProjectVersion }>;
	disable: string[];
	dependencies: ResolvedDependency[];
};

/** Looking up every mod takes a while; the preview is kept for the apply that follows. */
const prepared = new Map<string, { key: string; at: number; result: Prepared }>();
const PREPARED_TTL = 15 * 60_000;

const keyOf = (target: MigrationTarget) => `${target.minecraft}|${target.loader}|${target.loaderVersion ?? ''}`;

function validate(instance: ServerInstance, target: MigrationTarget): void {
	if (instance.packProjectId || instance.packSource) {
		throw new InstanceError(
			'This server was installed from a pack: move it with the pack (Modpack version), so its mods and configs come from the pack version for that Minecraft.'
		);
	}
	const loader = getLoader(target.loader);
	if (target.loader === 'cleanroom' || instance.modloader === 'cleanroom') {
		throw new InstanceError('Cleanroom has its own migration (Settings, Cleanroom), and exists only for Minecraft 1.12.2.');
	}
	if (loader.onlyGameVersions && !loader.onlyGameVersions.includes(target.minecraft)) {
		throw new InstanceError(`${loader.label} exists only for Minecraft ${loader.onlyGameVersions.join(', ')}.`);
	}
	if (compareVersions(target.minecraft, instance.minecraftVersion) < 0) {
		throw new InstanceError(
			`Minecraft ${target.minecraft} is older than ${instance.minecraftVersion}. A world opened by a newer version does not load in an older one, so MineShell only moves servers up.`
		);
	}
	if (
		target.minecraft === instance.minecraftVersion &&
		target.loader === instance.modloader &&
		(target.loaderVersion === null || target.loaderVersion === instance.modloaderVersion)
	) {
		throw new InstanceError('That is what this server runs already.');
	}
}

async function prepare(instance: ServerInstance, target: MigrationTarget): Promise<Prepared> {
	validate(instance, target);
	const hit = prepared.get(instance.id);
	if (hit && hit.key === keyOf(target) && Date.now() - hit.at < PREPARED_TTL) return hit.result;

	const vanilla = target.loader === 'vanilla';
	const filter = filterFor({ modloader: target.loader, minecraftVersion: target.minecraft });
	const rows = (await listInstanceMods(instance)).filter((r) => !r.missing);
	const mods: MigrationModPlan[] = [];
	const updates = new Map<string, { row: ModRow; version: ProjectVersion }>();
	const disable: string[] = [];
	const loaderLabel = getLoader(target.loader).label;

	await eachLimited(rows, async (row) => {
		const base = { fileName: row.fileName, name: row.name, from: row.version, disabled: !row.enabled };
		const off = (reason: string) => {
			// One already off stays off; nothing to do.
			if (row.enabled) disable.push(row.fileName);
			mods.push({ ...base, action: row.enabled ? 'disable' : 'keep', to: null, reason });
		};
		if (vanilla) return off('Vanilla loads no mods.');
		if (!trackable(row)) return off('Not from Modrinth or CurseForge, so MineShell cannot tell whether it runs there.');
		try {
			const versions = await compatibleVersions(row.source, row.slug!, filter);
			const best = bestVersion(versions.filter((v) => v.channel === 'release')) ?? bestVersion(versions);
			if (!best) return off(`No build for ${loaderLabel} ${target.minecraft}.`);
			if (best.id === row.versionId) {
				mods.push({ ...base, action: 'keep', to: null, reason: null });
				return;
			}
			updates.set(row.fileName, { row, version: best });
			mods.push({ ...base, action: 'update', to: best.versionNumber, reason: null });
		} catch (err) {
			off(`Could not be looked up: ${err instanceof Error ? err.message : 'lookup failed'}.`);
		}
	});

	const deps = updates.size
		? await resolveDependencies(
				instance,
				[...updates.values()].map(({ row, version }) => ({ source: row.source, name: row.name, slug: row.slug!, version })),
				{ filter, ignore: new Set(disable) }
			)
		: { plan: { install: [], unresolved: [], conflicts: [], unneeded: [] }, resolved: [] };

	const order = { disable: 0, update: 1, keep: 2 };
	mods.sort((a, b) => order[a.action] - order[b.action] || a.name.localeCompare(b.name));
	const result: Prepared = {
		plan: {
			current: { minecraft: instance.minecraftVersion, loader: instance.modloader, loaderVersion: instance.modloaderVersion },
			target,
			minecraftChange: target.minecraft !== instance.minecraftVersion,
			mods,
			dependencies: deps.plan,
			requiredJava: resolveJava({ minecraftVersion: target.minecraft, modloader: target.loader, modloaderVersion: target.loaderVersion }).requiredMajor
		},
		updates,
		disable,
		dependencies: deps.resolved
	};
	prepared.set(instance.id, { key: keyOf(target), at: Date.now(), result });
	return result;
}

/** Preview: every mod's fate and what gets installed, touching nothing. */
export async function planMigration(instance: ServerInstance, target: MigrationTarget): Promise<MigrationPlan> {
	return (await prepare(instance, target)).plan;
}

/**
 * Puts a server back as it was before a migration, from its journal: the
 * previous loader install, the mods (staged originals return, new files go)
 * and their records. Shared by the in-process rollback and recovery.
 */
export async function restoreMigration(instanceId: string, root: string, journal: MigrationJournal): Promise<void> {
	const staging = path.join(root, journal.staging);
	if (journal.loaderBefore) await restoreAside(root, path.join(staging, 'loader'), journal.loaderBefore, isLoaderInstallEntry);
	await restoreModUpdate(instanceId, root, {
		kind: 'mod-update',
		staging: path.join(journal.staging, 'mods'),
		modsBefore: journal.modsBefore,
		rowsBefore: journal.rowsBefore
	});
	await fs.rm(staging, { recursive: true, force: true });
}

export async function applyMigration(
	instance: ServerInstance,
	target: MigrationTarget,
	opts: { confirmMinecraftChange: boolean; snapshot?: boolean; downloadJava?: JavaVendor }
): Promise<string> {
	await requireStopped(instance);
	const { plan, updates, disable, dependencies } = await prepare(instance, target);
	if (plan.minecraftChange && !opts.confirmMinecraftChange) {
		throw new InstanceError(`This moves Minecraft from ${plan.current.minecraft} to ${target.minecraft}. Confirm the warning to continue.`);
	}
	const loader = getLoader(target.loader);
	const java = javaTarget({ ...instance, minecraftVersion: target.minecraft, modloader: target.loader, modloaderVersion: target.loaderVersion });
	const javaPlan = await planJava(java, opts.downloadJava);
	// A pin to the wrong Java is the person's to change, not something to download around.
	const pinnedWarning = instance.javaPath ? resolveJava(java).warning : null;
	if (pinnedWarning) throw new InstanceError(`${pinnedWarning} Set Java back to "Match automatically" first.`);

	const root = instance.path;
	const mods = modsDir(root);
	const journal: MigrationJournal = {
		kind: 'migrate',
		staging: path.join('.mineshell', `migrate-${Date.now()}`),
		modsBefore: await fs.readdir(mods).catch(() => [] as string[]),
		rowsBefore: db.select().from(instanceMods).where(eq(instanceMods.instanceId, instance.id)).all(),
		loaderBefore: null
	};
	try {
		beginOperation(instance.id, journal);
	} catch (err) {
		if (err instanceof OperationInProgressError) throw new InstanceError(err.message);
		throw err;
	}
	const label = `${loader.label} ${target.loaderVersion ?? '(latest)'} on Minecraft ${target.minecraft}`;
	const from = `${getLoader(instance.modloader).label} ${instance.modloaderVersion ?? ''} on Minecraft ${instance.minecraftVersion}`.replace('  ', ' ');
	setStatus(instance.id, 'provisioning', `Moving to ${label}`);
	return startTask({ label: `Move ${instance.name} to ${label}`, instanceId: instance.id }, async (task) => {
		const staging = path.join(root, journal.staging);
		const done: string[] = [];
		try {
			const javaPath = await obtainJava(javaPlan, java, task);
			if (opts.snapshot) await snapshotStep(instance, { reason: 'migrate', label: `Before moving from ${from} to ${label}` }, task);
			await fs.mkdir(path.join(staging, 'mods'), { recursive: true });

			// 1. Mods without a build for the target: off, the original staged so a
			// rollback can only ever delete the copy.
			for (const fileName of disable) {
				await disableStaged(instance, path.join(staging, 'mods'), fileName);
				done.push(`Disabled ${fileName}`);
			}

			// 2. Mods with a build for the target move to it, keeping enabled/locked.
			let n = 0;
			for (const { row, version } of updates.values()) {
				task.setProgress(Math.round((n++ / Math.max(1, updates.size)) * 100), `${row.name} ${version.versionNumber}`);
				await fs.rename(path.join(mods, row.fileName), path.join(staging, 'mods', row.fileName));
				const recorded = [row.fileName, row.fileName.replace(/\.disabled$/, '')].map((f) => path.join('mods', f));
				db.delete(instanceMods)
					.where(and(eq(instanceMods.instanceId, instance.id), inArray(instanceMods.filePath, recorded)))
					.run();
				const installed = await installModVersion(
					instance,
					row.source as 'modrinth' | 'curseforge',
					{ id: row.slug!, slug: row.slug!, name: row.name, projectUrl: row.projectUrl, iconUrl: row.iconUrl },
					version
				);
				if (row.locked) setModLocked(instance, path.join('mods', installed), true);
				if (!row.enabled) await setModEnabled(instance, installed, false);
				done.push(`${row.name} ${row.version ?? '?'} -> ${version.versionNumber}`);
			}
			for (const dep of dependencies) {
				task.setProgress(null, `Installing ${dep.project.name}`);
				await installModVersion(instance, dep.source as 'modrinth' | 'curseforge', dep.project, dep.version);
				done.push(`Installed ${dep.project.name} ${dep.version.versionNumber}, needed by ${dep.neededBy.join(', ')}`);
			}

			// 3. The loader. Journalled before anything moves, so a restart
			// mid-move knows which loader files were the originals.
			journal.loaderBefore = await listEntries(root, isLoaderInstallEntry);
			updateOperation(instance.id, journal);
			await fs.mkdir(path.join(staging, 'loader'), { recursive: true });
			for (const name of journal.loaderBefore) await fs.rename(path.join(root, name), path.join(staging, 'loader', name));
			task.setProgress(null, `Installing ${label}`);
			const result = await loader.install({ dir: root, minecraftVersion: target.minecraft, loaderVersion: target.loaderVersion, javaPath, task });

			commitOperation(instance.id, {
				minecraftVersion: target.minecraft,
				modloader: target.loader,
				modloaderVersion: result.loaderVersion,
				launchArgs: result.launchArgs
			});
		} catch (err) {
			task.log('The move failed; putting everything back.');
			await restoreMigration(instance.id, root, journal);
			endOperation(instance.id);
			setStatus(instance.id, 'ready', `Moving to ${label} failed and the server was put back: ${err instanceof Error ? err.message : 'unknown error'}`);
			throw err;
		}

		// Committed.
		await fs.rm(staging, { recursive: true, force: true });
		prepared.delete(instance.id);
		for (const line of done) task.log(line);
		const problems: string[] = [];
		if (disable.length) problems.push(`Disabled ${disable.length} mod(s) with no build for it: ${disable.join(', ')}.`);
		for (const u of plan.dependencies.unresolved) {
			problems.push(`${u.name} (needed by ${u.neededBy.join(', ')}) could not be installed: ${u.reason}.`);
		}
		await syncUnit(requireInstance(instance.id)).catch(() => undefined);
		setStatus(instance.id, 'ready', problems.length ? problems.join(' ') : null);
		audit('instance.migrated', { instanceId: instance.id, detail: `${from} -> ${label}` });
		task.setProgress(100, 'Ready');
	});
}
