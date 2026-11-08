import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db';
import { instanceDatapacks, instanceMods, type ServerInstance } from './db/schema';
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
	datapackBuilds,
	disableStaged,
	eachLimited,
	filterFor,
	resolveDependencies,
	restoreModUpdate,
	trackable,
	type DependencyPlan,
	type ResolvedDependency
} from './modupdates';
import { getLoader, instanceLoader, loaderLabel, type ModloaderId } from './modloaders';
import { datapacksDir, installDatapackVersion, listDatapacks, trackedDatapacks } from './mods/datapacks';
import { copyLostDatapacks, lostDatapackLoaders, type LostDatapackLoader } from './datapackloaders';
import { compareVersions, resolveJava } from './java';
import { snapshotStep } from './snapshots';
import { createWorld, deleteWorld, switchWorld, worldSeed } from './world';
import { serverWorldName } from './packworld';
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
	dropLoaderCaches,
	obtainJava,
	planJava,
	requireInstance,
	requireStopped,
	restoreAside,
	setStatus,
	syncUnit
} from './instances';
import type { JavaVendor } from './javadownload';
import { plural } from '#lib/shared/format.js';

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
 * - Data packs from the mod browser move to their build for the target, into the world
 *   moved to (the new one when going down with a new world, else in place of the old
 *   build), after the move is committed: a failed download leaves the old build and is
 *   logged. Ones without a build, and ones added by hand, stay where they are.
 * - Configs, the world and server.properties are left alone. Going down is
 *   possible, not supported (a world a newer Minecraft opened can lose chunks or
 *   not load): the panel warns and by default starts a new world for the older
 *   version (`newWorld`), the old one kept beside it under Worlds.
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

export type MigrationDatapackPlan = {
	fileName: string;
	name: string;
	from: string | null;
	/**
	 * `update`: its build for the target goes in. `keep`: this build is listed for the target
	 * too (copied into a new world). `stay`: no build for the target, or added by hand, so not
	 * looked up: left where it is (in a new world's case, with the old world).
	 */
	action: 'update' | 'keep' | 'stay';
	to: string | null;
	/** Why it stays. */
	reason: string | null;
	/** A data pack loader's folder it is in (read for every world, so never copied), or null for the world's. */
	folder: string | null;
};

export type MigrationPlan = {
	current: { minecraft: string; loader: string; loaderVersion: string | null };
	target: MigrationTarget;
	minecraftChange: boolean;
	/** To an older Minecraft than the server's. */
	downgrade: boolean;
	mods: MigrationModPlan[];
	/** The active world's data packs, and the browser's in a data pack loader's folders. */
	datapacks: MigrationDatapackPlan[];
	/**
	 * Data pack loaders the move disables, or moves to a build reading other folders, whose
	 * folders hold data packs (datapackloaders.ts, as the pack change warns).
	 */
	lostLoaders: LostDatapackLoader[];
	/** The active world's folder (level-name). */
	world: string;
	dependencies: DependencyPlan;
	requiredJava: number;
};

type Prepared = {
	plan: MigrationPlan;
	/** Data packs to install, by file name in the current world. */
	datapackUpdates: Map<string, ProjectVersion>;
	updates: Map<string, { row: ModRow; version: ProjectVersion }>;
	disable: string[];
	dependencies: ResolvedDependency[];
};

/** Looking up every mod takes a while; the preview is kept for the apply that follows. */
const prepared = new Map<string, { key: string; at: number; result: Prepared }>();
const PREPARED_TTL = 15 * 60_000;

const keyOf = (target: MigrationTarget) => `${target.minecraft}|${target.loader}|${target.loaderVersion ?? ''}`;

function validate(instance: ServerInstance, target: MigrationTarget): void {
	instanceLoader(instance);
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

	// The active world's data packs and the browser's in a data pack loader's folders: the
	// browser's are looked up for the target, as the data pack update check does; ones put
	// there by hand or by a pack are not.
	const datapacks: MigrationDatapackPlan[] = [];
	const datapackUpdates = new Map<string, ProjectVersion>();
	const tracked = new Map(db.select().from(instanceDatapacks).where(eq(instanceDatapacks.instanceId, instance.id)).all().map((r) => [r.fileName, r]));
	const onTarget = { minecraftVersion: target.minecraft, modloader: target.loader };
	const listed = [
		...(await listDatapacks(instance)).packs.map((p) => ({ fileName: p.fileName, name: p.name, version: p.version, folder: null as string | null })),
		...(await trackedDatapacks(instance)).filter((t) => t.row.folder).map(({ row }) => ({ fileName: row.fileName, name: row.name, version: row.version, folder: row.folder }))
	];
	await eachLimited(listed, async (pack) => {
		const base = { fileName: pack.fileName, name: pack.name, from: pack.version, folder: pack.folder };
		const row = tracked.get(pack.fileName);
		if (!row) return void datapacks.push({ ...base, action: 'stay', to: null, reason: 'Not added from the mod browser, so MineShell cannot look it up.' });
		try {
			const builds = await datapackBuilds(row.source, row.projectId, onTarget);
			const best = bestVersion(builds.filter((v) => v.channel === 'release')) ?? bestVersion(builds);
			if (!best) return void datapacks.push({ ...base, action: 'stay', to: null, reason: `No build for Minecraft ${target.minecraft}.` });
			if (best.id === row.versionId) return void datapacks.push({ ...base, action: 'keep', to: null, reason: null });
			datapackUpdates.set(pack.fileName, best);
			datapacks.push({ ...base, action: 'update', to: best.versionNumber, reason: null });
		} catch (err) {
			datapacks.push({ ...base, action: 'stay', to: null, reason: `Could not be looked up: ${err instanceof Error ? err.message : 'lookup failed'}.` });
		}
	});
	const packOrder = { update: 0, keep: 1, stay: 2 };
	datapacks.sort((a, b) => packOrder[a.action] - packOrder[b.action] || a.name.localeCompare(b.name));
	// A data pack loader leaving: disabled with no build, or its new build reading other folders
	// (Open Loader 20 to 21 on 1.20.1 to 1.21.1). Nothing here was shipped by a pack, so all count.
	const primaryFile = (v: ProjectVersion) => (v.files.find((f) => f.primary) ?? v.files[0])?.filename;
	const lostLoaders = await lostDatapackLoaders(
		instance.path,
		[...disable, ...updates.keys()],
		[...[...updates.values()].map((u) => primaryFile(u.version)), ...deps.resolved.map((d) => primaryFile(d.version))].filter((n): n is string => !!n),
		null
	);
	const result: Prepared = {
		plan: {
			current: { minecraft: instance.minecraftVersion, loader: instance.modloader, loaderVersion: instance.modloaderVersion },
			target,
			minecraftChange: target.minecraft !== instance.minecraftVersion,
			downgrade: compareVersions(target.minecraft, instance.minecraftVersion) < 0,
			mods,
			datapacks,
			lostLoaders,
			world: await serverWorldName(instance.path),
			dependencies: deps.plan,
			requiredJava: resolveJava({ minecraftVersion: target.minecraft, modloader: target.loader, modloaderVersion: target.loaderVersion }).requiredMajor
		},
		datapackUpdates,
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
	/** `newWorld`: going down, start a new world for the older version first (the old one stays under Worlds). */
	opts: { confirmMinecraftChange: boolean; snapshot?: boolean; newWorld?: boolean; downloadJava?: JavaVendor; copyLostDatapacks?: boolean }
): Promise<string> {
	await requireStopped(instance);
	const { plan, updates, disable, dependencies, datapackUpdates } = await prepare(instance, target);
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
	// Before the move, so the old world is recorded as last run on the newer version and
	// switching back to it asks first. Its own operation, so not inside the move's.
	const leftWorld = plan.downgrade && opts.newWorld ? await serverWorldName(root) : null;
	// Where the data packs are now; a new world's own folder is found after it is made.
	const packsFrom = (await datapacksDir(root)).dir;
	const newWorld = leftWorld
		? await createWorld(instance, { name: `New world for ${target.minecraft}`, seed: await worldSeed(root), copyDatapacks: false, keepMap: true })
		: null;
	const mods = modsDir(root);
	const journal: MigrationJournal = {
		kind: 'migrate',
		staging: path.join('.mineshell', `migrate-${Date.now()}`),
		modsBefore: await fs.readdir(mods).catch(() => [] as string[]),
		rowsBefore: db.select().from(instanceMods).where(eq(instanceMods.instanceId, instance.id)).all(),
		loaderBefore: null
	};
	/** A failed move puts the old world back as the active one, best effort. */
	const backToOldWorld = async (log: (line: string) => void) => {
		if (!leftWorld || !newWorld) return;
		try {
			await switchWorld(requireInstance(instance.id), leftWorld, { keepMap: true, force: true });
			await deleteWorld(requireInstance(instance.id), newWorld, { snapshots: false });
		} catch (err) {
			log(`The new world stays active: ${err instanceof Error ? err.message : 'switching back failed'}. Switch back under World > Worlds.`);
		}
	};
	try {
		beginOperation(instance.id, journal);
	} catch (err) {
		await backToOldWorld(() => undefined);
		if (err instanceof OperationInProgressError) throw new InstanceError(err.message);
		throw err;
	}
	const label = `${loader.label} ${target.loaderVersion ?? '(latest)'} on Minecraft ${target.minecraft}`;
	const from = `${loaderLabel(instance.modloader)} ${instance.modloaderVersion ?? ''} on Minecraft ${instance.minecraftVersion}`.replace('  ', ' ');
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
			await backToOldWorld((line) => task.log(line));
			throw err;
		}

		// Committed.
		await fs.rm(staging, { recursive: true, force: true });
		await dropLoaderCaches(root);
		prepared.delete(instance.id);
		const problems: string[] = [];

		// 4. Data packs into the world moved to. After the commit: installDatapackVersion
		// downloads before it replaces anything, so one that fails keeps its old build. First
		// a lost loader's packs to where the one taking over reads, ticked as in a pack change:
		// the browser's moved with their rows, so their updates below land there.
		if (opts.copyLostDatapacks && plan.lostLoaders.length) {
			try {
				const { copied, moved, skipped } = await copyLostDatapacks(root, plan.lostLoaders, requireInstance(instance.id));
				for (const to of copied) done.push(`Data pack copied to ${to}`);
				for (const to of moved) done.push(`Data pack moved to ${to}`);
				if (skipped.length) problems.push(`${plural(skipped.length, 'data pack')} not copied, as one of the same name is there already: ${skipped.join(', ')}.`);
			} catch (err) {
				problems.push(`Data packs were not copied to the new folder: ${err instanceof Error ? err.message : 'unknown error'}.`);
			}
		}
		const packsTo = (await datapacksDir(root)).dir;
		const rows = new Map(db.select().from(instanceDatapacks).where(eq(instanceDatapacks.instanceId, instance.id)).all().map((r) => [r.fileName, r]));
		for (const pack of plan.datapacks) {
			const row = rows.get(pack.fileName);
			const version = datapackUpdates.get(pack.fileName);
			try {
				if (pack.action === 'update' && row && version) {
					task.setProgress(null, `Data pack ${pack.name} ${version.versionNumber}`);
					const project = { id: row.projectId, slug: row.slug, name: row.name, projectUrl: row.projectUrl, iconUrl: row.iconUrl };
					await installDatapackVersion(instance, row.source as Parameters<typeof installDatapackVersion>[1], project, version, row.folder);
					done.push(`Data pack ${pack.name} ${pack.from ?? '?'} -> ${version.versionNumber}`);
				} else if (pack.action === 'keep' && !pack.folder && packsTo !== packsFrom) {
					await fs.mkdir(packsTo, { recursive: true });
					await fs.cp(path.join(packsFrom, pack.fileName), path.join(packsTo, pack.fileName), { recursive: true, preserveTimestamps: true });
					done.push(`Data pack ${pack.name} copied into the new world`);
				}
			} catch (err) {
				problems.push(`Data pack ${pack.name} was not moved to its build for ${target.minecraft}: ${err instanceof Error ? err.message : 'unknown error'}.`);
			}
		}

		for (const line of done) task.log(line);
		if (newWorld) task.log(`Started a new world for Minecraft ${target.minecraft}; ${leftWorld} is kept under World > Worlds.`);
		if (disable.length) problems.push(`Disabled ${plural(disable.length, 'mod')} with no build for it: ${disable.join(', ')}.`);
		for (const u of plan.dependencies.unresolved) {
			problems.push(`${u.name} (needed by ${u.neededBy.join(', ')}) could not be installed: ${u.reason}.`);
		}
		await syncUnit(requireInstance(instance.id)).catch(() => undefined);
		setStatus(instance.id, 'ready', problems.length ? problems.join(' ') : null);
		audit('instance.migrated', { instanceId: instance.id, detail: `${from} -> ${label}` });
		task.setProgress(100, 'Ready');
	});
}
