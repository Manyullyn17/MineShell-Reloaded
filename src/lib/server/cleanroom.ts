import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TMP_DIR } from './config';
import type { ServerInstance } from './db/schema';
import { downloadFile } from './download';
import type { TaskHandle } from './tasks';
import {
	bestVersion,
	compareVersionPriority,
	DISABLED_SUFFIX,
	getModProvider,
	installModVersion,
	modsDir,
	setModEnabled,
	type ProjectVersion,
	type SourceId
} from './mods';
import { CLEANROOM_MINECRAFT, cleanroomJavaMajor } from '#lib/shared/cleanroom.js';
import { compareVersions } from './java';
import { openZipFile } from './zip';

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

// ---------------------------------------------------------- Fugue's fit ---

/**
 * What a Fugue jar says about the Cleanroom it runs on, read from its classes:
 * the range its @Mod annotation requires (`cleanroom@[0.5.14-alpha,)`; Modrinth
 * has no such field) and whether it rewrites mods' getURLs() calls into
 * Cleanroom's ReflectionHackery.getURL, which Cleanroom 0.5.3 removed. Fugue
 * up to 0.23.2 does that and still declares a range that 0.5.3+ satisfies,
 * so the range alone misses it; the crash then shows only the patched mod.
 * Measured on the release jars, 2026-10-11: 0.24.x needs 0.6.10, 0.23.6-0.23.7
 * 0.5.14, 0.23.4 0.5.7, 0.23.3 0.4.4 (the only build for 0.5.3-0.5.6).
 */
export type FugueJarInfo = { range: string | null; callsGetUrl: boolean };

const HACKERY = 'com/cleanroommc/hackery/ReflectionHackery';

export async function inspectFugueJar(file: string): Promise<FugueJarInfo> {
	const info: FugueJarInfo = { range: null, callsGetUrl: false };
	const zip = await openZipFile(file).catch(() => null);
	if (!zip) return info;
	for (const entry of zip.entries) {
		if (!entry.name.endsWith('.class')) continue;
		// Constant pool strings are plain bytes in the class file.
		const text = (await zip.read(entry)).toString('latin1');
		info.range ??= text.match(/cleanroom@([[(][^\])]*[\])])/)?.[1] ?? null;
		if (text.includes(HACKERY) && text.includes('getURL')) info.callsGetUrl = true;
	}
	return info;
}

/** Whether `version` is inside a Maven-style range like `[0.5.7-alpha,)`; an unreadable range does not exclude. */
export function inVersionRange(version: string, range: string): boolean {
	const m = range.match(/^([[(])\s*([^,]*?)\s*,\s*([^\])]*?)\s*([\])])$/);
	if (!m) return true;
	const [, open, low, high, close] = m;
	if (low && (open === '[' ? compareVersions(version, low) < 0 : compareVersions(version, low) <= 0)) return false;
	if (high && (close === ']' ? compareVersions(version, high) > 0 : compareVersions(version, high) >= 0)) return false;
	return true;
}

/**
 * Whether the server's Cleanroom still has ReflectionHackery.getURL: read from
 * its jar, else from the version it was removed in.
 */
export async function cleanroomHasGetUrl(instancePath: string, cleanroomVersion: string): Promise<boolean> {
	const zip = await openZipFile(path.join(instancePath, `cleanroom-${cleanroomVersion}.jar`)).catch(() => null);
	const entry = zip?.entries.find((e) => e.name === `${HACKERY}.class`);
	if (!zip || !entry) return compareVersions(cleanroomVersion, '0.5.3') < 0;
	return (await zip.read(entry)).toString('latin1').includes('getURL');
}

/** Why a Fugue does not run on this Cleanroom, or null when nothing says it will not. */
export function fugueMismatch(info: FugueJarInfo, cleanroomVersion: string, hasGetUrl: boolean): string | null {
	if (info.range && !inVersionRange(cleanroomVersion, info.range)) return `It needs Cleanroom ${info.range}.`;
	if (info.callsGetUrl && !hasGetUrl) {
		return 'It patches mods to call ReflectionHackery.getURL, which this Cleanroom no longer has (removed in 0.5.3).';
	}
	return null;
}

/** Fugue builds' jar info by version id: checking a candidate means downloading it. */
const fugueInfoCache = new Map<string, FugueJarInfo>();

async function fugueVersionInfo(version: ProjectVersion): Promise<FugueJarInfo> {
	const cached = fugueInfoCache.get(version.id);
	if (cached) return cached;
	const file = version.files.find((f) => f.primary) ?? version.files[0];
	if (!file) return { range: null, callsGetUrl: false };
	const temp = path.join(TMP_DIR, `fugue-${crypto.randomUUID()}.jar`);
	try {
		await downloadFile(file.url, temp, { hash: file.hash });
		const info = await inspectFugueJar(temp);
		fugueInfoCache.set(version.id, info);
		return info;
	} finally {
		await fs.rm(temp, { force: true });
	}
}

/** Candidates checked before giving up: each one is a download. */
const FUGUE_CANDIDATES = 12;

/**
 * The best Fugue build that runs on this Cleanroom: release first, newest
 * first, skipping builds whose jar rules this Cleanroom out (newest Fugue
 * needs Cleanroom 0.6.10, so "newest" alone broke every 0.5.x server).
 */
export async function pickFugue(
	versions: ProjectVersion[],
	cleanroomVersion: string,
	hasGetUrl: boolean,
	info: (version: ProjectVersion) => Promise<FugueJarInfo> = fugueVersionInfo
): Promise<ProjectVersion | null> {
	const java = cleanroomJavaMajor(cleanroomVersion);
	const candidates = [...usableForJava(versions, FUGUE_JAVA25_FROM, java)].sort(compareVersionPriority);
	for (const version of candidates.slice(0, FUGUE_CANDIDATES)) {
		if (!fugueMismatch(await info(version), cleanroomVersion, hasGetUrl)) return version;
	}
	return null;
}

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
 * Reading mcmod.info means opening every jar (its central directory and that
 * one entry); caching by size + mtime keeps repeat page loads cheap.
 */
const jarCache = new Map<string, { key: string; modids: string[]; names: string[] }>();

async function readMcmodInfo(file: string): Promise<{ modids: string[]; names: string[] }> {
	try {
		const zip = await openZipFile(file);
		const entry = zip?.entries.find((e) => e.name === 'mcmod.info');
		if (!zip || !entry) return { modids: [], names: [] };
		// Plenty of mcmod.info files are not valid JSON (raw newlines in
		// descriptions), so pull the two fields out directly.
		const text = (await zip.read(entry)).toString('utf8');
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
			info = { key, ...(await readMcmodInfo(full)) };
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
	/** Enabled Fugue jars that do not run on the Cleanroom version given; replaced by a build that does. */
	replace: CleanroomFinding[];
};

/** `cleanroomVersion`: the Cleanroom installed (or about to be), to check Fugue against; none skips that check. */
export async function cleanroomReport(instancePath: string, cleanroomVersion?: string | null): Promise<CleanroomReport> {
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

	const replace: CleanroomFinding[] = [];
	if (cleanroomVersion) {
		const fugue = REQUIRED_MODS.find((m) => m.label === 'Fugue')!;
		const hasGetUrl = await cleanroomHasGetUrl(instancePath, cleanroomVersion);
		for (const jar of enabled.filter((j) => matches(j, fugue))) {
			const info = await inspectFugueJar(path.join(modsDir(instancePath), jar.fileName));
			const reason = fugueMismatch(info, cleanroomVersion, hasGetUrl);
			if (reason) replace.push({ fileName: jar.fileName, label: fugue.label, reason, replacement: null });
		}
	}

	return {
		disable,
		advise,
		// A Fugue that does not fit counts as missing: the replacement is added like a missing one.
		required: REQUIRED_MODS.map((mod) => ({
			label: mod.label,
			reason: mod.reason,
			present: enabled.some((j) => matches(j, mod) && !replace.some((r) => r.fileName === j.fileName))
		})),
		replace
	};
}

/**
 * Disabled jars that Cleanroom's must-remove list covers, with why, so the
 * Mods list can say a mod is off for Cleanroom rather than leave it looking
 * disabled for no reason. Read from the jars, so it also covers servers
 * installed straight onto Cleanroom (no migration manifest).
 */
export async function cleanroomDisabledReasons(instancePath: string): Promise<Record<string, string>> {
	const reasons: Record<string, string> = {};
	for (const jar of await scanModJars(instancePath)) {
		if (jar.enabled) continue;
		const rule = DISABLE_RULES.find((r) => matches(jar, r));
		if (rule) reasons[jar.fileName] = `${rule.label}: ${rule.reason}${rule.replacement ? ` Use ${rule.replacement} instead.` : ''}`;
	}
	return reasons;
}

// --------------------------------------------------------------- applying ---

/** Builds from `java25From` on need Java 25, which a Java 21 Cleanroom (<= 0.4.x) cannot load. */
function usableForJava(versions: ProjectVersion[], java25From: string | undefined, java: number): ProjectVersion[] {
	return java25From && java < 25 ? versions.filter((v) => compareVersions(v.versionNumber, java25From) < 0) : versions;
}

/** The newest suitable build of a required mod for the Cleanroom generation in use. */
export function pickVersionForJava(
	versions: ProjectVersion[],
	java25From: string | undefined,
	java: number
): ProjectVersion | null {
	return bestVersion(usableForJava(versions, java25From, java));
}

async function installRequiredMod(instance: ServerInstance, mod: RequiredMod): Promise<string> {
	const provider = getModProvider(mod.source);
	const [project, all] = await Promise.all([
		provider.getProject(mod.projectId),
		provider.listVersions(mod.projectId, { minecraftVersion: CLEANROOM_MINECRAFT, loader: 'forge' })
	]);
	const java = cleanroomJavaMajor(instance.modloaderVersion);
	const cleanroom = instance.modloaderVersion;
	const version =
		mod.label === 'Fugue' && cleanroom
			? await pickFugue(all, cleanroom, await cleanroomHasGetUrl(instance.path, cleanroom))
			: pickVersionForJava(all, mod.java25From, java);
	if (!version) {
		throw new Error(`no ${CLEANROOM_MINECRAFT} build for ${cleanroom ? `Cleanroom ${cleanroom}` : `Java ${java}`} found`);
	}

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

/** Adds a required mod, or replaces the `outdated` jars of it with a build that runs on this Cleanroom. */
async function addRequiredMod(
	instance: ServerInstance,
	mod: RequiredMod,
	replace: CleanroomFinding[],
	result: CleanroomFixResult,
	task?: TaskHandle
): Promise<void> {
	const outdated = replace.filter((r) => r.label === mod.label);
	try {
		for (const item of outdated) task?.log(`${item.fileName} does not run on Cleanroom ${instance.modloaderVersion}: ${item.reason}`);
		task?.log(outdated.length ? `Replacing ${mod.label}` : `Adding ${mod.label}`);
		result.added.push(await installRequiredMod(instance, mod));
	} catch (err) {
		const message = outdated.length
			? `Could not replace ${outdated.map((r) => r.fileName).join(', ')}, which does not run on this Cleanroom: ${err instanceof Error ? err.message : 'unknown error'}. Install a ${mod.label} version made for Cleanroom ${instance.modloaderVersion} by hand.`
			: `Could not add ${mod.label}: ${err instanceof Error ? err.message : 'unknown error'}. Add it by hand.`;
		result.failures.push(message);
		task?.log(message);
		return;
	}
	// Only once the replacement is in: a failed download keeps the old one.
	for (const item of outdated) {
		await setModEnabled(instance, item.fileName, false);
		result.disabled.push(item.fileName);
		task?.log(`Disabled ${item.fileName}.`);
	}
}

/**
 * After a Cleanroom version change: Fugue builds are tied to Cleanroom
 * versions, so one that fitted the old version is replaced if it does not
 * fit the new one. Nothing else from the guide is applied.
 */
export async function matchFugueToCleanroom(instance: ServerInstance, task?: TaskHandle): Promise<CleanroomFixResult> {
	const report = await cleanroomReport(instance.path, instance.modloaderVersion);
	const result: CleanroomFixResult = { disabled: [], added: [], failures: [], advise: [] };
	const fugue = REQUIRED_MODS.find((m) => m.label === 'Fugue')!;
	if (report.replace.length) await addRequiredMod(instance, fugue, report.replace, result, task);
	return result;
}

/**
 * Applies the automatic part of the guide and logs the rest. Failures to add
 * a required mod are reported rather than thrown: the server may still boot,
 * and the mod can be added by hand.
 */
export async function applyCleanroomModFixes(
	instance: ServerInstance,
	task?: TaskHandle
): Promise<CleanroomFixResult> {
	const report = await cleanroomReport(instance.path, instance.modloaderVersion);
	const result: CleanroomFixResult = { disabled: [], added: [], failures: [], advise: report.advise };

	for (const item of report.disable) {
		await setModEnabled(instance, item.fileName, false);
		result.disabled.push(item.fileName);
		task?.log(`Disabled ${item.fileName} (${item.label}): ${item.reason}`);
	}

	for (const mod of REQUIRED_MODS) {
		if (report.required.find((r) => r.label === mod.label)?.present) continue;
		await addRequiredMod(instance, mod, report.replace, result, task);
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
