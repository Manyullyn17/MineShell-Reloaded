import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { serverInstances, type ServerInstance } from './db/schema';
import {
	bestVersion,
	DISABLED_SUFFIX,
	getProvider,
	installModVersion,
	listInstanceMods,
	modsDir,
	setModEnabled,
	syncMods,
	type ModRow,
	type ProjectVersion
} from './mods';
import { applyOverrides, downloadPackFiles, loadOverridesArchive, type ParsedPack } from './packs';
import { resolveProviderPack } from './packs/resolve';
import { getLoader, type ModloaderId } from './modloaders';
import { resolveJava } from './java';
import { startTask, type TaskHandle } from './tasks';
import { applyCleanroomModFixes, isCleanroomRequiredJar } from './cleanroom';
import { canUseCleanroom } from '$lib/shared/cleanroom';
import {
	audit,
	InstanceError,
	isLoaderInstallEntry,
	listEntries,
	removeEntries,
	requireInstance,
	requireStopped,
	setStatus,
	syncUnit
} from './instances';

/**
 * Moving an installed pack to another version of itself - up, down, or the
 * same version again to restore the pack's own files.
 *
 * What changes and what never does:
 * - Pack mods (tracked fromPack) are diffed by filename: gone ones are
 *   removed, new ones downloaded, unchanged ones left alone (keeping their
 *   enabled/disabled state). Mods the user added are never removed.
 * - Every top-level folder or file the new pack ships (config/, scripts/,
 *   resources/ ...) is moved to old-configs/<date>-<old version>/ first and
 *   then written fresh, so configs are never silently merged or lost.
 * - server.properties, the world, player lists and logs are never moved or
 *   overwritten, even when the pack ships its own copy.
 * - Everything is reversible until the database is updated: a failure puts
 *   configs, mods and the loader back exactly as they were.
 */

/** Never moved to old-configs and never overwritten by a pack's overrides. */
const PROTECTED = new Set([
	'mods',
	'server.properties',
	'eula.txt',
	'ops.json',
	'whitelist.json',
	'banned-players.json',
	'banned-ips.json',
	'usercache.json',
	'logs',
	'crash-reports',
	'old-configs',
	'.mineshell'
]);

// ---------------------------------------------------------------- preparing ---

/**
 * Resolving a CurseForge version means downloading its overrides.zip (MeatballCraft:
 * 154MB), so the preview keeps the result for the apply that usually follows.
 */
const prepared = new Map<string, { key: string; pack: ParsedPack; at: number }>();
const PREPARED_TTL = 30 * 60_000;

function packRef(instance: ServerInstance): { source: string; projectId: string } {
	if (!instance.packSource || !instance.packProjectId) {
		throw new InstanceError(
			'This server was not installed from a pack MineShell can look up (uploaded archives have no project to fetch other versions from).'
		);
	}
	return { source: instance.packSource, projectId: instance.packProjectId };
}

async function preparePack(instance: ServerInstance, versionId: string, task?: TaskHandle): Promise<ParsedPack> {
	const { source, projectId } = packRef(instance);
	const key = `${source}:${projectId}:${versionId}`;
	const hit = prepared.get(instance.id);
	if (hit && hit.key === key && Date.now() - hit.at < PREPARED_TTL) return hit.pack;
	const { pack } = await resolveProviderPack(source, projectId, versionId);
	await loadOverridesArchive(pack, task);
	prepared.set(instance.id, { key, pack, at: Date.now() });
	return pack;
}

// ----------------------------------------------------------------- planning ---

function baseName(fileName: string): string {
	return fileName.endsWith(DISABLED_SUFFIX) ? fileName.slice(0, -DISABLED_SUFFIX.length) : fileName;
}

function overrideRelative(entry: string): string {
	return entry.replace(/^(server-overrides|overrides)\//, '');
}

/** Jar names the target version installs into mods/, from downloads and bundled overrides. */
function targetModNames(pack: ParsedPack): Set<string> {
	const names = new Set<string>();
	for (const d of pack.downloads) {
		const dir = path.posix.dirname(d.target);
		if (dir === 'mods') names.add(path.posix.basename(d.target));
	}
	for (const e of pack.overrideEntries) {
		const rel = overrideRelative(e);
		if (path.posix.dirname(rel) === 'mods') names.add(path.posix.basename(rel));
	}
	return names;
}

/** Top-level entries the target version writes, other than mods and protected files. */
function packTopLevel(pack: ParsedPack): string[] {
	const tops = new Set<string>();
	for (const e of pack.overrideEntries) tops.add(overrideRelative(e).split('/')[0]);
	for (const d of pack.downloads) if (d.target.includes('/')) tops.add(d.target.split('/')[0]);
	return [...tops].filter((t) => t && !PROTECTED.has(t) && !isLoaderInstallEntry(t)).sort();
}

function targetLoaderFor(
	instance: ServerInstance,
	pack: ParsedPack
): { loader: ModloaderId; version: string | null } {
	// A Forge 1.12.2 pack installed onto Cleanroom stays on Cleanroom.
	if (instance.modloader === 'cleanroom' && canUseCleanroom(pack.modloader, pack.minecraftVersion)) {
		return { loader: 'cleanroom', version: instance.modloaderVersion };
	}
	return {
		loader: pack.modloader,
		version:
			pack.modloaderVersion ??
			(pack.modloader === instance.modloader && pack.minecraftVersion === instance.minecraftVersion
				? instance.modloaderVersion
				: null)
	};
}

export type ManualModCheck = {
	fileName: string;
	name: string;
	source: string;
	currentVersion: string | null;
	status: 'update' | 'current' | 'unavailable' | 'unknown';
	targetVersion: string | null;
	/** Shown as an error when the mod probably will not work after the change. */
	blocking: boolean;
	message: string | null;
};

export type PackChangePlan = {
	versionId: string;
	sameVersion: boolean;
	current: { minecraft: string; loader: string; loaderVersion: string | null };
	target: { name: string; version: string | null; minecraft: string; loader: string; loaderVersion: string | null };
	minecraftChange: boolean;
	loaderChange: boolean;
	mods: { add: string[]; remove: string[]; keep: number };
	configs: string[];
	manual: ManualModCheck[];
	/** Reached into while applying; not sent to the client. */
	updates?: Map<string, { source: string; project: { id: string; slug: string; name: string; projectUrl: string | null; iconUrl: string | null }; version: ProjectVersion }>;
};

async function checkManualMod(
	row: ModRow,
	target: { minecraft: string; loader: ModloaderId },
	breaking: boolean
): Promise<{ check: ManualModCheck; update?: NonNullable<PackChangePlan['updates']> extends Map<string, infer V> ? V : never }> {
	const base = {
		fileName: row.fileName,
		name: row.name,
		source: row.source,
		currentVersion: row.version,
		targetVersion: null
	};
	if ((row.source !== 'modrinth' && row.source !== 'curseforge') || !row.slug) {
		return {
			check: {
				...base,
				status: 'unknown',
				blocking: breaking,
				message: breaking
					? `Not from a known source, so MineShell cannot find a build for ${target.loader} ${target.minecraft}. Replace it by hand or it will likely fail to load.`
					: 'Not from a known source, so updates cannot be checked.'
			}
		};
	}
	const catalogLoader = getLoader(target.loader).catalogLoader ?? target.loader;
	try {
		const provider = getProvider(row.source);
		const [project, versions] = await Promise.all([
			provider.getProject(row.slug),
			provider.listVersions(row.slug, { minecraftVersion: target.minecraft, loader: catalogLoader })
		]);
		const best = bestVersion(versions);
		if (!best) {
			return {
				check: {
					...base,
					status: 'unavailable',
					blocking: true,
					message: `No version for ${catalogLoader} ${target.minecraft}. It will stay as it is and will probably fail to load; disable or replace it.`
				}
			};
		}
		if (best.versionNumber === row.version) {
			return { check: { ...base, status: 'current', targetVersion: best.versionNumber, blocking: false, message: null } };
		}
		return {
			check: { ...base, status: 'update', targetVersion: best.versionNumber, blocking: false, message: null },
			update: {
				source: row.source,
				project: {
					id: project.id,
					slug: project.slug,
					name: project.name,
					projectUrl: project.projectUrl,
					iconUrl: project.iconUrl
				},
				version: best
			}
		};
	} catch (err) {
		return {
			check: {
				...base,
				status: 'unknown',
				blocking: breaking,
				message: `Could not check for a compatible version: ${err instanceof Error ? err.message : 'lookup failed'}.`
			}
		};
	}
}

async function buildPlan(instance: ServerInstance, versionId: string, pack: ParsedPack): Promise<PackChangePlan> {
	const target = targetLoaderFor(instance, pack);
	const minecraftChange = pack.minecraftVersion !== instance.minecraftVersion;
	const loaderChange =
		minecraftChange ||
		target.loader !== instance.modloader ||
		(target.version !== null && target.version !== instance.modloaderVersion);

	const rows = (await listInstanceMods(instance)).filter((r) => !r.missing);
	const wanted = targetModNames(pack);
	const present = new Set(rows.map((r) => baseName(r.fileName)));
	const packRows = rows.filter((r) => r.fromPack);
	const remove = packRows.filter((r) => !wanted.has(baseName(r.fileName))).map((r) => r.fileName);
	const add = [...wanted].filter((n) => !present.has(n)).sort();

	// A Minecraft or loader-family change is when a user mod is likely to break.
	const breaking = minecraftChange || target.loader !== instance.modloader;
	const manualRows = rows.filter(
		(r) => !r.fromPack && !(target.loader === 'cleanroom' && isCleanroomRequiredJar(baseName(r.fileName)))
	);
	const checks = await Promise.all(
		manualRows.map((r) => checkManualMod(r, { minecraft: pack.minecraftVersion, loader: target.loader }, breaking))
	);

	const updates: NonNullable<PackChangePlan['updates']> = new Map();
	for (const c of checks) if (c.update) updates.set(c.check.fileName, c.update);

	return {
		versionId,
		sameVersion: versionId === instance.packVersionId,
		current: {
			minecraft: instance.minecraftVersion,
			loader: instance.modloader,
			loaderVersion: instance.modloaderVersion
		},
		target: {
			name: pack.name,
			version: pack.version,
			minecraft: pack.minecraftVersion,
			loader: target.loader,
			loaderVersion: target.version
		},
		minecraftChange,
		loaderChange,
		mods: { add, remove, keep: packRows.length - remove.length },
		configs: packTopLevel(pack),
		manual: checks.map((c) => c.check),
		updates
	};
}

/** Preview: resolve the target version and work out every change, touching nothing. */
export async function planPackChange(instance: ServerInstance, versionId: string): Promise<PackChangePlan> {
	const pack = await preparePack(instance, versionId);
	const plan = await buildPlan(instance, versionId, pack);
	delete plan.updates;
	return plan;
}

// ----------------------------------------------------------------- applying ---

function stampFor(label: string | null): string {
	const date = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
	const version = (label ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
	return `${date}-${version}`;
}

async function exists(p: string): Promise<boolean> {
	return fs.access(p).then(
		() => true,
		() => false
	);
}

export async function applyPackChange(
	instance: ServerInstance,
	versionId: string,
	opts: { updateMods: string[]; confirmMinecraftChange: boolean }
): Promise<string> {
	await requireStopped(instance);
	const pack = await preparePack(instance, versionId);
	const plan = await buildPlan(instance, versionId, pack);

	if (plan.minecraftChange && !opts.confirmMinecraftChange) {
		throw new InstanceError(
			`This changes Minecraft from ${plan.current.minecraft} to ${plan.target.minecraft}. Confirm the warning to continue.`
		);
	}
	const loader = getLoader(plan.target.loader);
	let javaPath: string | null = null;
	if (plan.loaderChange) {
		const java = resolveJava({
			...instance,
			minecraftVersion: plan.target.minecraft,
			modloader: plan.target.loader,
			modloaderVersion: plan.target.loaderVersion
		});
		if (!java.path || (instance.javaPath && java.warning)) {
			throw new InstanceError(java.warning ?? `The new version needs Java ${java.requiredMajor}, which was not found.`);
		}
		javaPath = java.path;
	}

	const label = `${plan.target.name} ${plan.target.version ?? versionId}`;
	setStatus(instance.id, 'provisioning', `Changing pack to ${label}`);
	const taskId = startTask({ label: `Change ${instance.name} to ${label}`, instanceId: instance.id }, async (task) => {
		const root = instance.path;
		const mods = modsDir(root);
		const staging = path.join(root, '.mineshell', `pack-change-${Date.now()}`);
		const oldConfigs = path.join(root, 'old-configs', stampFor(instance.packVersionId));
		const modsBefore = new Set(await fs.readdir(mods).catch(() => [] as string[]));
		const configsBefore = new Set<string>();
		for (const name of plan.configs) if (await exists(path.join(root, name))) configsBefore.add(name);
		const movedConfigs: string[] = [];
		const stagedMods: string[] = [];
		let loaderBefore: string[] = [];
		const movedLoader: string[] = [];
		let downloadFailures: { file: string; error: string }[] = [];
		const problems: string[] = [];

		try {
			await fs.mkdir(path.join(staging, 'mods'), { recursive: true });

			// 1. Configs and other pack-shipped folders go to old-configs, whole.
			task.setProgress(null, 'Moving current configs to old-configs');
			for (const name of configsBefore) {
				await fs.mkdir(oldConfigs, { recursive: true });
				await fs.rename(path.join(root, name), path.join(oldConfigs, name));
				movedConfigs.push(name);
			}
			if (movedConfigs.length) {
				task.log(`Moved ${movedConfigs.join(', ')} to ${path.relative(root, oldConfigs)}/.`);
			}

			// 2. Pack mods the new version no longer has.
			for (const fileName of plan.mods.remove) {
				await fs.rename(path.join(mods, fileName), path.join(staging, 'mods', fileName));
				stagedMods.push(fileName);
				task.log(`Removed ${fileName}`);
			}

			// 3. New pack files: mods not already present, plus everything outside mods/.
			const present = new Set([...modsBefore].map(baseName));
			const toDownload = pack.downloads.filter((d) => {
				const dir = d.target ? path.posix.dirname(d.target) : 'mods';
				if (PROTECTED.has(d.target.split('/')[0]) && dir !== 'mods') return false;
				return dir !== 'mods' || !present.has(path.posix.basename(d.target));
			});
			task.setProgress(0, 'Downloading pack files');
			({ failures: downloadFailures } = await downloadPackFiles({ ...pack, downloads: toDownload }, root, task));

			// 4. Overrides, minus protected files and jars that are already there.
			const overrideEntries = pack.overrideEntries.filter((e) => {
				const rel = overrideRelative(e);
				const top = rel.split('/')[0];
				if (top === 'mods') return path.posix.dirname(rel) === 'mods' && !present.has(path.posix.basename(rel));
				return !PROTECTED.has(top) && !isLoaderInstallEntry(top);
			});
			task.setProgress(null, 'Unpacking pack overrides');
			const copied = await applyOverrides({ ...pack, overrideEntries }, root);
			if (copied) task.log(`Copied ${copied} files from the pack's overrides.`);

			// 5. User mods the user chose to update.
			for (const fileName of opts.updateMods) {
				const update = plan.updates?.get(fileName);
				if (!update) continue;
				task.log(`Updating ${update.project.name} to ${update.version.versionNumber}`);
				// The old jar is staged first so a rollback can restore it even
				// when the new file has the same name.
				await fs.rename(path.join(mods, fileName), path.join(staging, 'mods', fileName));
				stagedMods.push(fileName);
				const installed = await installModVersion(
					instance,
					update.source as 'modrinth' | 'curseforge',
					update.project,
					update.version
				);
				if (fileName.endsWith(DISABLED_SUFFIX)) await setModEnabled(instance, installed, false);
			}

			// 6. The loader, when the pack's loader or Minecraft version moved.
			let launchArgs = instance.launchArgs;
			let loaderVersion = instance.modloaderVersion;
			if (plan.loaderChange && javaPath) {
				task.setProgress(null, `Installing ${loader.label} ${plan.target.loaderVersion ?? '(latest)'}`);
				await fs.mkdir(path.join(staging, 'loader'), { recursive: true });
				loaderBefore = await listEntries(root, isLoaderInstallEntry);
				for (const name of loaderBefore) {
					await fs.rename(path.join(root, name), path.join(staging, 'loader', name));
					movedLoader.push(name);
				}
				const result = await loader.install({
					dir: root,
					minecraftVersion: plan.target.minecraft,
					loaderVersion: plan.target.loaderVersion,
					javaPath,
					task
				});
				launchArgs = result.launchArgs;
				loaderVersion = result.loaderVersion;
			}

			db.update(serverInstances)
				.set({
					minecraftVersion: plan.target.minecraft,
					modloader: plan.target.loader,
					modloaderVersion: loaderVersion,
					launchArgs,
					packVersionId: versionId,
					updatedAt: Date.now()
				})
				.where(eq(serverInstances.id, instance.id))
				.run();
		} catch (err) {
			task.log('The change failed; putting everything back.');
			await rollback({
				root,
				mods,
				staging,
				oldConfigs,
				modsBefore,
				stagedMods,
				configs: plan.configs,
				configsBefore,
				movedConfigs,
				loaderBefore,
				movedLoader
			});
			await syncMods(requireInstance(instance.id)).catch(() => undefined);
			await fs.rm(staging, { recursive: true, force: true });
			setStatus(
				instance.id,
				'ready',
				`Changing the pack version failed and the server was restored: ${err instanceof Error ? err.message : 'unknown error'}`
			);
			throw err;
		}

		// Committed. Tidy up and re-track; problems here are reported, not rolled back.
		await fs.rm(staging, { recursive: true, force: true });
		prepared.delete(instance.id);
		if (downloadFailures.length) {
			problems.push(`${downloadFailures.length} pack file(s) could not be downloaded; see the task log.`);
		}
		const blocking = plan.manual.filter((m) => m.blocking && !opts.updateMods.includes(m.fileName));
		if (blocking.length) {
			problems.push(`${blocking.length} of your own mod(s) have no compatible version: ${blocking.map((m) => m.name).join(', ')}.`);
		}
		try {
			task.setProgress(null, 'Identifying mods');
			await syncMods(requireInstance(instance.id), { fromPack: true });
			if (plan.target.loader === 'cleanroom') {
				const fixes = await applyCleanroomModFixes(requireInstance(instance.id), task);
				problems.push(...fixes.failures);
			}
		} catch (err) {
			problems.push(`Re-tracking mods failed: ${err instanceof Error ? err.message : 'unknown error'}. Use Sync on the mods page.`);
		} finally {
			await syncUnit(requireInstance(instance.id));
		}
		setStatus(instance.id, 'ready', problems.length ? problems.join(' ') : null);
		audit('instance.pack_changed', {
			instanceId: instance.id,
			detail: `${instance.packVersionId ?? '?'} -> ${versionId}`
		});
		task.setProgress(100, 'Ready');
	});
	return taskId;
}

async function rollback(s: {
	root: string;
	mods: string;
	staging: string;
	oldConfigs: string;
	modsBefore: Set<string>;
	stagedMods: string[];
	configs: string[];
	configsBefore: Set<string>;
	movedConfigs: string[];
	loaderBefore: string[];
	movedLoader: string[];
}): Promise<void> {
	// Loader: drop whatever the new install left, bring the old one back.
	// Originals that were never moved are left exactly where they are.
	if (s.loaderBefore.length || s.movedLoader.length) {
		const untouched = new Set(s.loaderBefore.filter((n) => !s.movedLoader.includes(n)));
		await removeEntries(s.root, isLoaderInstallEntry, untouched);
		for (const name of s.movedLoader) {
			await fs.rename(path.join(s.staging, 'loader', name), path.join(s.root, name));
		}
	}
	// Mods: anything new goes, staged ones return.
	for (const name of await fs.readdir(s.mods).catch(() => [] as string[])) {
		if (!s.modsBefore.has(name)) await fs.rm(path.join(s.mods, name), { force: true });
	}
	for (const name of s.stagedMods) {
		await fs.rename(path.join(s.staging, 'mods', name), path.join(s.mods, name));
	}
	// Configs: the fresh copies go, the moved originals return. An original
	// that was never moved is still the real one and is left alone.
	for (const name of s.configs) {
		if (s.configsBefore.has(name) && !s.movedConfigs.includes(name)) continue;
		await fs.rm(path.join(s.root, name), { recursive: true, force: true });
	}
	for (const name of s.movedConfigs) {
		await fs.rename(path.join(s.oldConfigs, name), path.join(s.root, name));
	}
	await fs.rm(s.oldConfigs, { recursive: true, force: true });
	await fs.rmdir(path.dirname(s.oldConfigs)).catch(() => undefined);
}
