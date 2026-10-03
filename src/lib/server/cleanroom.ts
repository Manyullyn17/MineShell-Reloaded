import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { ServerInstance } from './db/schema';
import type { TaskHandle } from './tasks';
import {
	bestVersion,
	DISABLED_SUFFIX,
	getModProvider,
	installModVersion,
	modsDir,
	setModEnabled,
	type ProjectVersion,
	type SourceId
} from './mods';
import { CLEANROOM_MINECRAFT, cleanroomJavaMajor } from '$lib/shared/cleanroom';
import { compareVersions } from './java';

/**
 * Moving a Forge 1.12.2 pack onto Cleanroom, following Cleanroom's own
 * "preparing your modpack" guide. Only two kinds of change are ever applied
 * automatically: adding the mods Cleanroom needs (Fugue, Scalar Legacy) and
 * disabling mods the guide says are broken or redundant on Cleanroom *and*
 * that add no world content, so disabling one can never strip blocks or
 * items out of a save. Everything else in the guide ("replace X with its
 * maintained fork") is reported, never applied.
 *
 * Mods are identified from mcmod.info rather than the mods table, because
 * pack jars are often untracked or tracked as "manual". mcmod.info alone is
 * not reliable either - Born in a Barn ships modid "examplemod", Relictium
 * claims Vintagium's "vintagium", coremods like MixinBootstrap have no
 * mcmod.info at all - so each rule can also match on the declared name or
 * the filename, and modids are only used where they are distinctive.
 */

type Matcher = {
	modids?: string[];
	/** Exact mcmod.info names, case-insensitive. */
	names?: string[];
	/** Tested against the jar filename without the .disabled suffix. */
	file?: RegExp;
	/** Forks often keep the original modid; these names mean it is already the fork. */
	unlessName?: RegExp;
};

type Rule = Matcher & {
	label: string;
	reason: string;
	replacement?: string;
};

/** Broken or redundant under Cleanroom, and safe to disable: no blocks, items or worldgen. */
const DISABLE_RULES: Rule[] = [
	{ label: 'MixinBootstrap', reason: 'Not needed with the MixinBooter Cleanroom bundles.', file: /mixinbootstrap/i },
	{ label: 'Mixin 0.7-0.8 Compatibility', reason: 'Not needed with the MixinBooter Cleanroom bundles.', modids: ['mixincompat'], file: /mixincompat/i },
	{ label: 'SerializationIsBad', reason: 'Redundant on modern Java.', modids: ['serializationisbad'], file: /serializationisbad/i },
	{ label: 'Raw Input', reason: 'Already included in Cleanroom.', modids: ['rawinput'] },
	{ label: 'Phosphor', reason: 'Incompatible with Cleanroom.', replacement: 'Alfheim Lighting Engine or Hesperus', modids: ['phosphor-lighting'], file: /^phosphor-(forge-)?(mc)?1\.12/i },
	{ label: 'Born in a Barn', reason: 'The fix is already in Forge/Cleanroom.', file: /born ?in ?a ?barn/i },
	{ label: 'Bed Patch', reason: 'The fix is already in Forge/Cleanroom.', names: ['Bed Patch'], file: /bed[-_ ]?patch/i },
	{ label: 'SmoothFont', reason: 'Breaks other mods.', modids: ['smoothfont'], file: /smoothfont/i },
	{ label: 'AdvancedShader', reason: 'Binary patching is incompatible with Cleanroom.', file: /advancedshader/i },
	{ label: 'Custom Mob Spawner', reason: 'Breaks mob spawns across mods.', names: ['Custom Mob Spawner'], file: /custom[-_ ]?mob[-_ ]?spawner/i },
	{ label: 'NormalASM', reason: 'Outdated fork; superseded on Cleanroom.', modids: ['normalasm'] },
	{ label: 'Neonium', reason: 'Outdated Vintagium fork.', names: ['Neonium'], file: /neonium/i },
	{ label: 'Relictium', reason: 'Outdated Vintagium fork.', names: ['Relictium'], file: /relictium/i },
	{ label: 'Better Foliage / RLFoliage', reason: 'Heavy and incompatible with Cleanroom.', modids: ['betterfoliage'] },
	{ label: 'BetterFPS', reason: 'Fake performance mod.', modids: ['betterfps'], file: /betterfps/i },
	{ label: 'FPS Boost', reason: 'Fake performance mod.', file: /fps[-_ ]?boost/i },
	{ label: 'Performant', reason: 'Fake performance mod.', modids: ['performant'], file: /^performant/i },
	{ label: 'Redirectionor', reason: 'Fake performance mod.', file: /redirectionor/i },
	{ label: 'Multithreaded Noise', reason: 'Fake performance mod.', file: /multithreaded[-_ ]?noise/i },
	{ label: 'Farsight', reason: 'Fake performance mod.', file: /^farsight/i },
	{ label: 'GPU Tape', reason: 'Fake performance mod.', file: /gpu[-_ ]?tape/i },
	{ label: 'Pigium', reason: 'Fake performance mod.', file: /pigium/i },
	{ label: 'Better Biome Blend', reason: 'Fake performance mod.', file: /better(er)?[-_ ]?biome[-_ ]?blend/i }
];

/** Suggested replacements from Cleanroom's guide. Reported only - some swap content mods with world data. */
const ADVISE_RULES: Rule[] = [
	{ label: 'FoamFix', reason: 'Outdated.', replacement: 'VintageFix', modids: ['foamfix'] },
	{ label: 'VanillaFix', reason: 'Merged into a better mod.', replacement: 'Chibi', modids: ['vanillafix'] },
	{ label: 'TexFix', reason: 'Merged into a better mod.', replacement: 'Chibi', modids: ['texfix'] },
	{ label: 'FastFurnace', reason: 'Merged into a better mod.', replacement: 'Chibi', modids: ['fastfurnace'] },
	{ label: 'FastWorkbench', reason: 'Merged into a better mod.', replacement: 'Universal Tweaks', modids: ['fastbench'] },
	{ label: 'RandomPatches', reason: 'Crash issues.', replacement: 'Universal Tweaks', modids: ['randompatches'] },
	{ label: 'RandomTweaks', reason: 'Crash issues.', replacement: 'Universal Tweaks', modids: ['randomtweaks'] },
	{ label: 'Surge', reason: 'No performance benefit.', replacement: 'Universal Tweaks', modids: ['surge'] },
	{ label: 'AttributeFix', reason: 'Merged into a better mod.', replacement: 'Universal Tweaks', modids: ['attributefix'] },
	{ label: 'NetherPortalFix', reason: 'Rewritten elsewhere.', replacement: 'Universal Tweaks', modids: ['netherportalfix'] },
	{ label: 'DupeFix Project', reason: 'Incompatible with MixinBooter.', replacement: 'Universal Tweaks', file: /dupefix/i },
	{ label: 'Clumps', reason: 'Outdated.', replacement: 'Fixeroo', modids: ['clumps'] },
	{ label: 'Spark', reason: 'Better features elsewhere.', replacement: 'Flare', modids: ['spark'] },
	{ label: 'Just Enough Items', reason: 'Outdated.', replacement: 'HadEnoughItems (HEI)', modids: ['jei'], unlessName: /had ?enough/i },
	{ label: 'JustEnoughIDs / NotEnoughIDs', reason: 'Outdated.', replacement: 'RoughlyEnoughIDs (REID)', modids: ['jeid', 'neid'] },
	{ label: 'The One Probe', reason: 'Unmaintained.', replacement: 'The One Probe Community Edition', modids: ['theoneprobe'], unlessName: /community/i },
	{ label: 'Baubles', reason: 'Unmaintained.', replacement: 'BaublesEX or Bubbles', modids: ['baubles'], unlessName: /baublesex|bubbles/i },
	{ label: "Shadowfacts' Forgelin", reason: 'Unmaintained.', replacement: 'Forgelin-Continuous', modids: ['forgelin'] },
	{ label: 'AppleSkin', reason: 'Outdated.', replacement: 'LemonSkin', modids: ['appleskin'] },
	{ label: 'Applied Energistics 2', reason: 'Outdated.', replacement: 'AE2 Unofficial Extended Life', file: /^appliedenergistics2-rv/i },
	{ label: "Tinkers' Construct", reason: 'Outdated.', replacement: "Tinkers' Antique", file: /^tconstruct-1\.12/i },
	{ label: 'OpenModsLib', reason: 'Merged.', replacement: 'OpenBlocks Reopened', modids: ['openmods'] },
	{ label: 'GeckoLib 3', reason: 'Outdated; Cleanroom-only fork available.', replacement: 'SauriaLib', modids: ['geckolib3'] },
	{ label: 'Random Things', reason: 'Outdated.', replacement: 'Quantum Things', modids: ['randomthings'] },
	{ label: "Oh The Biomes You'll Go", reason: 'MCreator-based with extensive bugs.', modids: ['biomesyougo'] }
];

/** Fugue's first build compiled for Java 25 (measured from the release jars). */
export const FUGUE_JAVA25_FROM = '0.23.4';

type RequiredMod = {
	label: string;
	reason: string;
	source: SourceId;
	projectId: string;
	modids: string[];
	file: RegExp;
	/**
	 * First version compiled for Java 25. Older Cleanroom (<= 0.4.x) runs on
	 * Java 21 and cannot load these, so it gets the newest version before.
	 */
	java25From?: string;
};

/** Cleanroom's guide: add both; neither loads on plain Forge, so they are harmless after a revert. */
const REQUIRED_MODS: RequiredMod[] = [
	{
		label: 'Fugue',
		reason: 'Patches Forge-era mods to run on Cleanroom.',
		source: 'modrinth',
		projectId: 'fugue',
		modids: ['fugue'],
		file: /fugue/i,
		// Measured from the release jars' class-file versions (and a failed
		// boot of 0.24.4 on Cleanroom 0.4.4 / Java 21).
		java25From: FUGUE_JAVA25_FROM
	},
	{
		label: 'Scalar Legacy',
		reason: 'Provides the Scala 2.11 libraries Forge bundled and Cleanroom removed.',
		source: 'curseforge',
		projectId: '1235372',
		modids: ['scalar'],
		file: /^scalar/i
	}
];

/** True for Fugue/Scalar Legacy jars, which MineShell manages for Cleanroom instances itself. */
export function isCleanroomRequiredJar(fileName: string): boolean {
	return REQUIRED_MODS.some((mod) => mod.file.test(fileName));
}

// ------------------------------------------------------------------ scanning ---

export type JarInfo = {
	/** As on disk, including any .disabled suffix. */
	fileName: string;
	enabled: boolean;
	modids: string[];
	names: string[];
};

/**
 * Reading mcmod.info means opening every jar, which adm-zip does by loading
 * the whole file; caching by size + mtime keeps repeat page loads cheap.
 */
const jarCache = new Map<string, { key: string; modids: string[]; names: string[] }>();

function readMcmodInfo(file: string): { modids: string[]; names: string[] } {
	try {
		const zip = new AdmZip(file);
		const entry = zip.getEntry('mcmod.info');
		if (!entry) return { modids: [], names: [] };
		// Plenty of mcmod.info files are not valid JSON (raw newlines in
		// descriptions), so pull the two fields out directly.
		const text = entry.getData().toString('utf8');
		return {
			modids: [...text.matchAll(/"modid"\s*:\s*"([^"]+)"/g)].map((m) => m[1].toLowerCase()),
			names: [...text.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1])
		};
	} catch {
		return { modids: [], names: [] };
	}
}

export async function scanModJars(instancePath: string): Promise<JarInfo[]> {
	const dir = modsDir(instancePath);
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return [];
	}
	const jars: JarInfo[] = [];
	for (const fileName of entries) {
		const enabled = fileName.toLowerCase().endsWith('.jar');
		if (!enabled && !fileName.toLowerCase().endsWith(`.jar${DISABLED_SUFFIX}`)) continue;
		const full = path.join(dir, fileName);
		const stat = await fs.stat(full).catch(() => null);
		if (!stat?.isFile()) continue;
		const key = `${stat.size}:${stat.mtimeMs}`;
		let info = jarCache.get(full);
		if (!info || info.key !== key) {
			info = { key, ...readMcmodInfo(full) };
			jarCache.set(full, info);
		}
		jars.push({ fileName, enabled, modids: info.modids, names: info.names });
	}
	return jars;
}

function baseName(fileName: string): string {
	return fileName.endsWith(DISABLED_SUFFIX) ? fileName.slice(0, -DISABLED_SUFFIX.length) : fileName;
}

function matches(jar: JarInfo, m: Matcher): boolean {
	if (m.unlessName && jar.names.some((n) => m.unlessName!.test(n))) return false;
	if (m.modids?.some((id) => jar.modids.includes(id))) return true;
	if (m.names?.some((n) => jar.names.some((j) => j.toLowerCase() === n.toLowerCase()))) return true;
	return !!m.file?.test(baseName(jar.fileName));
}

// -------------------------------------------------------------------- report ---

export type CleanroomFinding = {
	fileName: string;
	label: string;
	reason: string;
	replacement: string | null;
};

export type CleanroomReport = {
	/** Enabled jars that will be (or should be) disabled. */
	disable: CleanroomFinding[];
	/** Enabled jars the guide suggests replacing; never acted on. */
	advise: CleanroomFinding[];
	required: { label: string; reason: string; present: boolean }[];
};

export async function cleanroomReport(instancePath: string): Promise<CleanroomReport> {
	const jars = await scanModJars(instancePath);
	const enabled = jars.filter((j) => j.enabled);
	const finding = (jar: JarInfo, rule: Rule): CleanroomFinding => ({
		fileName: jar.fileName,
		label: rule.label,
		reason: rule.reason,
		replacement: rule.replacement ?? null
	});

	const disable: CleanroomFinding[] = [];
	const advise: CleanroomFinding[] = [];
	for (const jar of enabled) {
		const off = DISABLE_RULES.find((r) => matches(jar, r));
		if (off) {
			disable.push(finding(jar, off));
			continue;
		}
		const hint = ADVISE_RULES.find((r) => matches(jar, r));
		if (hint) advise.push(finding(jar, hint));
	}

	return {
		disable,
		advise,
		required: REQUIRED_MODS.map((mod) => ({
			label: mod.label,
			reason: mod.reason,
			present: enabled.some((j) => matches(j, mod))
		}))
	};
}

// --------------------------------------------------------------- applying ---

/**
 * The newest suitable build of a required mod for the Cleanroom generation in
 * use: builds from `java25From` on need Java 25, which a Java 21 Cleanroom
 * (<= 0.4.x) cannot load.
 */
export function pickVersionForJava(
	versions: ProjectVersion[],
	java25From: string | undefined,
	java: number
): ProjectVersion | null {
	const usable =
		java25From && java < 25 ? versions.filter((v) => compareVersions(v.versionNumber, java25From) < 0) : versions;
	return bestVersion(usable);
}

async function installRequiredMod(instance: ServerInstance, mod: RequiredMod): Promise<string> {
	const provider = getModProvider(mod.source);
	const [project, all] = await Promise.all([
		provider.getProject(mod.projectId),
		provider.listVersions(mod.projectId, { minecraftVersion: CLEANROOM_MINECRAFT, loader: 'forge' })
	]);
	const java = cleanroomJavaMajor(instance.modloaderVersion);
	const version = pickVersionForJava(all, mod.java25From, java);
	if (!version) throw new Error(`no ${CLEANROOM_MINECRAFT} build for Java ${java} found`);

	return installModVersion(
		instance,
		mod.source,
		{
			id: project.id,
			slug: project.slug,
			name: project.name,
			projectUrl: project.projectUrl,
			iconUrl: project.iconUrl
		},
		version
	);
}

export type CleanroomFixResult = {
	/** Filenames as they were before disabling (without .disabled). */
	disabled: string[];
	/** Filenames of mods that were downloaded. */
	added: string[];
	/** Human-readable problems that did not stop the switch. */
	failures: string[];
	advise: CleanroomFinding[];
};

/**
 * Applies the automatic part of the guide and logs the rest. Failures to add
 * a required mod are reported rather than thrown: the server may still boot,
 * and the mod can be added by hand.
 */
export async function applyCleanroomModFixes(
	instance: ServerInstance,
	task?: TaskHandle
): Promise<CleanroomFixResult> {
	const report = await cleanroomReport(instance.path);
	const result: CleanroomFixResult = { disabled: [], added: [], failures: [], advise: report.advise };

	for (const item of report.disable) {
		await setModEnabled(instance, item.fileName, false);
		result.disabled.push(item.fileName);
		task?.log(`Disabled ${item.fileName} (${item.label}): ${item.reason}`);
	}

	for (const mod of REQUIRED_MODS) {
		if (report.required.find((r) => r.label === mod.label)?.present) continue;
		try {
			task?.log(`Adding ${mod.label}`);
			result.added.push(await installRequiredMod(instance, mod));
		} catch (err) {
			const message = `Could not add ${mod.label}: ${err instanceof Error ? err.message : 'unknown error'}. Add it by hand.`;
			result.failures.push(message);
			task?.log(message);
		}
	}

	if (report.advise.length) {
		task?.log(
			`Cleanroom's guide suggests replacing ${report.advise.length} more mod(s); nothing was changed for these:`
		);
		for (const item of report.advise) {
			task?.log(
				`  ${item.fileName} (${item.label})${item.replacement ? ` -> ${item.replacement}` : ''}: ${item.reason}`
			);
		}
	}
	return result;
}
