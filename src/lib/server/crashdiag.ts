import fs from 'node:fs/promises';
import path from 'node:path';
// With the extension: capture.mjs runs this file under plain node, which needs it.
import { openZipBuffer, openZipFile, type ZipEntry } from './zip.ts';
import { isChat } from '../shared/consolelines.ts';

/**
 * Turns a failed server start into "mod X broke because Y", for every loader
 * MineShell installs: Fabric and Quilt (old and new loader messages), legacy
 * Forge 1.12 / Cleanroom, modern Forge and NeoForge.
 *
 * Two inputs: the console output of the failed run and the mods folder. The
 * log says *what* went wrong (a class could not be found, a mixin could not
 * apply, a dependency is missing); an index of every jar in mods/ says *who*:
 * which mod's code was running (from the stack trace or the loader's own
 * attribution line) and which jar, if any, should have provided the missing
 * piece.
 *
 * Deliberately self-contained (node built-ins and zip.ts only) so it can be run
 * against saved logs outside the app.
 */

// ---------------------------------------------------------------- mod index ---

export type ModJar = {
	/** As on disk, including any .disabled suffix. */
	fileName: string;
	enabled: boolean;
	ids: string[];
	names: string[];
	/** The version the jar declares, when it is a real one (not a `${file.jarVersion}` placeholder). */
	version: string | null;
	authors: string[];
	/** Declared client-only (Fabric/Quilt `environment: client`); the loader skips it on a server. */
	clientOnly: boolean;
	/** Mod ids it declares as required on a server, lower-cased (Minecraft and loaders included). */
	requires: string[];
	/** Further ids it brings, lower-cased: Fabric/Quilt `provides` and the mods nested inside it. */
	provides: string[];
	/** Class names (dotted) in the jar and in any jars nested inside it. */
	classes: Set<string>;
	/** Mixin config files shipped at the jar root. */
	mixinConfigs: string[];
	/** The picture the jar names for itself (Fabric/Quilt `icon`, Forge `logoFile`), as a path inside it. */
	logo: string | null;
};

const jarCache = new Map<string, { key: string; jar: Omit<ModJar, 'fileName' | 'enabled'> }>();

/** A jar on disk or nested in another one. */
type ZipSource = { entries: ZipEntry[]; read: (entry: ZipEntry) => Buffer | Promise<Buffer> };

async function readText(zip: ZipSource, name: string): Promise<string | null> {
	const entry = zip.entries.find((e) => e.name === name);
	if (!entry) return null;
	try {
		return (await zip.read(entry)).toString('utf8');
	} catch {
		return null;
	}
}

async function indexZip(zip: ZipSource, depth: number, into: Omit<ModJar, 'fileName' | 'enabled'>): Promise<void> {
	for (const e of zip.entries) {
		if (e.name.endsWith('.class') && !e.name.startsWith('META-INF/')) {
			into.classes.add(e.name.slice(0, -6).replace(/\//g, '.'));
		} else if (depth === 0 && !e.name.includes('/') && /mixin.*\.json$|\.mixins?\.json$/i.test(e.name)) {
			into.mixinConfigs.push(e.name);
		} else if (depth < 2 && e.name.endsWith('.jar') && e.name.startsWith('META-INF/')) {
			// Jar-in-jar: Fabric META-INF/jars, Forge/NeoForge META-INF/jarjar.
			try {
				const nested = openZipBuffer(await zip.read(e));
				if (nested) {
					into.provides.push(...(await nestedIds(nested)));
					await indexZip(nested, depth + 1, into);
				}
			} catch {
				/* unreadable nested jar */
			}
		}
	}
}

/** The mod ids a nested jar declares, so the jar around it counts as having them. */
async function nestedIds(zip: ZipSource): Promise<string[]> {
	const ids: string[] = [];
	for (const name of ['fabric.mod.json', 'quilt.mod.json']) {
		const text = await readText(zip, name);
		if (!text) continue;
		try {
			const meta = JSON.parse(text);
			const id = meta.id ?? meta.quilt_loader?.id;
			if (id) ids.push(String(id));
			if (Array.isArray(meta.provides)) ids.push(...meta.provides.map(providedId));
		} catch {
			/* malformed */
		}
	}
	for (const name of ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
		const text = await readText(zip, name);
		if (text) for (const block of tomlBlocks(text, /^mods\]\]/)) ids.push(...tomlValues(block, 'modId'));
	}
	return ids;
}

/** A `provides` entry: an id, or (Quilt) an object with one. */
function providedId(entry: unknown): string {
	return typeof entry === 'string' ? entry : String((entry as { id?: unknown })?.id ?? '');
}

function tomlValues(text: string, key: string): string[] {
	return [...text.matchAll(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'gm'))].map((m) => m[1]);
}

/** The `[[name]]` table-array blocks of a mods.toml whose header matches. */
function tomlBlocks(text: string, header: RegExp): string[] {
	return text.split(/^\s*\[\[/m).filter((b) => header.test(b));
}

/**
 * Required dependencies from a mods.toml: each `[[dependencies.<mod>]]` block
 * with `mandatory=true` (Forge) or `type="required"` (NeoForge), unless only
 * the client needs it (`side="CLIENT"`).
 */
function tomlRequired(text: string): string[] {
	return tomlBlocks(text, /^dependencies\./)
		.filter((b) => /^\s*mandatory\s*=\s*true/m.test(b) || /^\s*type\s*=\s*"required"/m.test(b))
		.filter((b) => !/^\s*side\s*=\s*"CLIENT"/im.test(b))
		.flatMap((b) => tomlValues(b, 'modId'));
}

/** Fabric's and Quilt's `icon`: a path, or paths by size (the largest is taken). */
function iconPath(icon: unknown): string | null {
	if (typeof icon === 'string') return icon || null;
	if (!icon || typeof icon !== 'object') return null;
	const sizes = Object.entries(icon as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string');
	return sizes.sort((a, b) => Number(b[0]) - Number(a[0]))[0]?.[1] ?? null;
}

/** Fabric's authors: names, or objects with a name. */
function personNames(list: unknown): string[] {
	if (!Array.isArray(list)) return [];
	return list.map((p) => (typeof p === 'string' ? p : typeof p?.name === 'string' ? p.name : '')).filter(Boolean);
}

/** A mods.toml `authors` string: "A, B and C". */
function splitAuthors(value: string | undefined): string[] {
	return value ? value.split(/\s*(?:,|&|\band\b)\s*/) : [];
}

async function describeJar(file: string): Promise<Omit<ModJar, 'fileName' | 'enabled'>> {
	const info: Omit<ModJar, 'fileName' | 'enabled'> = {
		ids: [],
		names: [],
		version: null,
		authors: [],
		clientOnly: false,
		requires: [],
		provides: [],
		classes: new Set(),
		mixinConfigs: [],
		logo: null
	};
	const zip = await openZipFile(file).catch(() => null);
	if (!zip) return info;
	await indexZip(zip, 0, info);

	const fabric = await readText(zip, 'fabric.mod.json');
	if (fabric) {
		try {
			const meta = JSON.parse(fabric);
			if (meta.id) info.ids.push(String(meta.id));
			if (meta.name) info.names.push(String(meta.name));
			if (meta.version) info.version ??= String(meta.version);
			info.authors.push(...personNames(meta.authors));
			if (meta.environment === 'client') info.clientOnly = true;
			info.logo ??= iconPath(meta.icon);
			if (meta.depends && typeof meta.depends === 'object') info.requires.push(...Object.keys(meta.depends));
			if (Array.isArray(meta.provides)) info.provides.push(...meta.provides.map(providedId));
		} catch {
			info.ids.push(...[...fabric.matchAll(/"id"\s*:\s*"([^"]+)"/g)].slice(0, 1).map((m) => m[1]));
			if (/"environment"\s*:\s*"client"/.test(fabric)) info.clientOnly = true;
		}
	}
	const quilt = await readText(zip, 'quilt.mod.json');
	if (quilt) {
		try {
			const meta = JSON.parse(quilt);
			if (meta.quilt_loader?.id) info.ids.push(String(meta.quilt_loader.id));
			if (meta.quilt_loader?.metadata?.name) info.names.push(String(meta.quilt_loader.metadata.name));
			if (meta.quilt_loader?.version) info.version ??= String(meta.quilt_loader.version);
			info.logo ??= iconPath(meta.quilt_loader?.metadata?.icon);
			if (Array.isArray(meta.quilt_loader?.provides)) info.provides.push(...meta.quilt_loader.provides.map(providedId));
			// Quilt's contributors map names to roles.
			const contributors = meta.quilt_loader?.metadata?.contributors;
			if (contributors && typeof contributors === 'object') info.authors.push(...Object.keys(contributors));
			if (meta.minecraft?.environment === 'client') info.clientOnly = true;
			for (const dep of meta.quilt_loader?.depends ?? []) {
				const id = typeof dep === 'string' ? dep : dep?.optional ? null : dep?.id;
				if (id) info.requires.push(String(id).replace(/^.*:/, ''));
			}
		} catch {
			/* malformed */
		}
	}
	for (const toml of ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
		const text = await readText(zip, toml);
		if (text) {
			// Only [[mods]] blocks: dependency blocks have a modId too, and
			// counting those made every jar look like "minecraft" or "forge".
			for (const block of tomlBlocks(text, /^mods\]\]/)) {
				info.ids.push(...tomlValues(block, 'modId'));
				info.names.push(...tomlValues(block, 'displayName'));
				info.version ??= tomlValues(block, 'version')[0] ?? null;
				info.authors.push(...splitAuthors(tomlValues(block, 'authors')[0]));
				info.logo ??= tomlValues(block, 'logoFile')[0] ?? null;
			}
			// Forge also takes it above the [[mods]] blocks, for the whole jar.
			info.logo ??= tomlValues(text.split(/^\s*\[/m)[0], 'logoFile')[0] ?? null;
			info.requires.push(...tomlRequired(text));
		}
	}
	const mcmod = await readText(zip, 'mcmod.info');
	if (mcmod) {
		info.ids.push(...[...mcmod.matchAll(/"modid"\s*:\s*"([^"]+)"/g)].map((m) => m[1]));
		info.names.push(...[...mcmod.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]));
		info.version ??= mcmod.match(/"version"\s*:\s*"([^"]+)"/)?.[1] ?? null;
		info.logo ??= mcmod.match(/"logoFile"\s*:\s*"([^"]+)"/)?.[1] || null;
		const authorList = mcmod.match(/"(?:authorList|authors)"\s*:\s*\[([^\]]*)\]/);
		if (authorList) info.authors.push(...[...authorList[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
		for (const list of mcmod.matchAll(/"requiredMods"\s*:\s*\[([^\]]*)\]/g)) {
			info.requires.push(...[...list[1].matchAll(/"([^"@]+)/g)].map((m) => m[1]));
		}
	}
	info.ids = [...new Set(info.ids.map((s) => s.toLowerCase()))];
	info.names = [...new Set(info.names)];
	// Build tools fill these in at build time; a jar that still has one never had it replaced.
	if (info.version && /\$\{|@[a-z_]+@/i.test(info.version)) info.version = null;
	info.authors = [...new Set(info.authors.map((a) => a.trim()).filter(Boolean))];
	info.requires = [...new Set(info.requires.map((s) => s.toLowerCase()))];
	info.provides = [...new Set(info.provides.map((s) => s.toLowerCase()).filter((id) => id && !info.ids.includes(id)))];
	return info;
}

const DISABLED_SUFFIX = '.disabled';

/** One jar, from the same cache as indexMods; null when it is not there. */
export async function describeModJar(file: string): Promise<Omit<ModJar, 'fileName' | 'enabled'> | null> {
	const stat = await fs.stat(file).catch(() => null);
	if (!stat?.isFile()) return null;
	const key = `${stat.size}:${stat.mtimeMs}`;
	let cached = jarCache.get(file);
	if (!cached || cached.key !== key) {
		cached = { key, jar: await describeJar(file) };
		jarCache.set(file, cached);
	}
	return cached.jar;
}

export async function indexMods(modsDir: string): Promise<ModJar[]> {
	let names: string[];
	try {
		names = await fs.readdir(modsDir);
	} catch {
		return [];
	}
	const jars: ModJar[] = [];
	for (const fileName of names) {
		const enabled = /\.jar$/i.test(fileName);
		if (!enabled && !fileName.toLowerCase().endsWith(`.jar${DISABLED_SUFFIX}`)) continue;
		const jar = await describeModJar(path.join(modsDir, fileName));
		if (jar) jars.push({ fileName, enabled, ...jar });
	}
	return jars;
}

/**
 * Ids mod templates ship with, which unrelated mods keep (Born in a Barn says
 * "examplemod"): two jars sharing one of these are not the same mod.
 */
const PLACEHOLDER_IDS = new Set(['examplemod', 'examplemodid', 'modid', 'mod_id', 'yourmodid', 'template', 'example']);

export type DuplicateMod = { id: string; name: string; files: string[] };

/**
 * Enabled jars that declare the same mod id: the same mod twice, often once
 * from Modrinth and once from CurseForge under other file names. Forge,
 * NeoForge and Fabric all refuse to start with a mod id present twice. By
 * the jars' own ids (fabric.mod.json, mods.toml, mcmod.info), not platform
 * metadata, which has no id the two platforms share.
 */
export function duplicateMods(jars: ModJar[]): DuplicateMod[] {
	const byId = new Map<string, ModJar[]>();
	for (const jar of jars) {
		if (!jar.enabled) continue;
		for (const id of jar.ids) {
			if (PLACEHOLDER_IDS.has(id)) continue;
			byId.set(id, [...(byId.get(id) ?? []), jar]);
		}
	}
	const groups = new Map<string, DuplicateMod>();
	for (const [id, found] of byId) {
		if (found.length < 2) continue;
		const files = found.map((j) => j.fileName).sort();
		// A jar declaring several ids would show the same pair once per id.
		const key = files.join('\n');
		if (!groups.has(key)) groups.set(key, { id, name: found.find((j) => j.names.length)?.names[0] ?? id, files });
	}
	return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * For each jar, the enabled mods that would not start without it, by name: they
 * require an id the jar has (its own, or one it provides or nests) and no other
 * enabled jar has it. Disabled jars are included, so a disabled library shows
 * the mods missing it. Client-only mods do not count: the loader skips them on
 * a server. Only jars something needs are listed.
 */
export function requiredBy(jars: ModJar[]): Record<string, string[]> {
	const has = (j: ModJar) => [...j.ids, ...(j.provides ?? [])];
	const enabledHaving = new Map<string, ModJar[]>();
	for (const j of jars) {
		if (!j.enabled) continue;
		for (const id of has(j)) enabledHaving.set(id, [...(enabledHaving.get(id) ?? []), j]);
	}
	const out: Record<string, string[]> = {};
	for (const jar of jars) {
		const ids = has(jar).filter((id) => !PLACEHOLDER_IDS.has(id) && !(enabledHaving.get(id) ?? []).some((j) => j !== jar));
		if (!ids.length) continue;
		const dependents = jars.filter((j) => j !== jar && j.enabled && !j.clientOnly && j.requires.some((id) => ids.includes(id)));
		if (dependents.length) {
			out[jar.fileName] = [...new Set(dependents.map((j) => j.names[0] ?? j.fileName.replace(/\.jar$/i, '')))].sort((a, b) => a.localeCompare(b));
		}
	}
	return out;
}

// ---------------------------------------------------------------- diagnosis ---

export type DiagnosisKind =
	| 'client-only-dependency'
	| 'client-code'
	| 'headless'
	| 'disabled-dependency'
	| 'version-mismatch'
	| 'missing-class'
	| 'missing-dependency'
	| 'incompatible-method'
	| 'mixin-failure'
	| 'java-version'
	| 'loader-version'
	| 'memory-killed'
	| 'watchdog';

export type ModRef = { fileName: string; name: string; enabled: boolean; clientOnly: boolean };

export type Diagnosis = {
	kind: DiagnosisKind;
	title: string;
	detail: string;
	culprit: ModRef | null;
	related: ModRef | null;
	/** The log line this came from, for the user to search for. */
	evidence: string;
	fix: { enable: boolean; fileName: string; label: string } | null;
	/** For the watchdog: the tick limit to raise `max-tick-time` to, when there is a higher step. */
	tickLimit?: { ms: number; label: string } | null;
	/**
	 * False for errors logged before the one that stopped the server. Big packs
	 * log plenty of harmless errors on every start; those are listed apart.
	 */
	fatal: boolean;
};

function ref(jar: ModJar | null | undefined): ModRef | null {
	if (!jar) return null;
	return {
		fileName: jar.fileName,
		name: jar.names[0] ?? jar.fileName.replace(/\.jar(\.disabled)?$/i, ''),
		enabled: jar.enabled,
		clientOnly: jar.clientOnly
	};
}

/** Dependency ids that name the loader or the game rather than a mod. */
const LOADER_IDS: Record<string, string> = {
	minecraft: 'Minecraft',
	forge: 'Forge',
	fml: 'Forge',
	cleanroom: 'Cleanroom',
	neoforge: 'NeoForge',
	fabricloader: 'Fabric Loader',
	'fabric-loader': 'Fabric Loader',
	quilt_loader: 'Quilt Loader',
	'quilt-loader': 'Quilt Loader',
	java: 'Java'
};

const FRAME = /^\s*at\s+(?:[\w.$]+\/\/)?([\w$.]+)\.([\w$<>]+)\(/;
// Loader, launcher and JDK frames never point at the mod to blame.
const INFRA = /^(java\.|javax\.|jdk\.|sun\.|com\.sun\.|net\.minecraft\.|net\.minecraftforge\.|net\.neoforged\.|cpw\.mods\.|net\.fabricmc\.|org\.quiltmc\.|org\.spongepowered\.|com\.llamalad7\.|com\.google\.|org\.apache\.|org\.objectweb\.|top\.outlands\.|com\.cleanroommc\.(?!fugue)|zone\.rong\.mixinbooter|io\.netty\.|it\.unimi\.|com\.mojang\.|kotlin\.|scala\.)/;

function normaliseClass(name: string): string {
	return name.replace(/\//g, '.').replace(/^L|;$/g, '').replace(/^['"]|['"]$/g, '');
}

function isMinecraftClass(name: string): boolean {
	return /^(net\.minecraft\.|com\.mojang\.blaze3d\.)/.test(name);
}

function isClientMinecraftClass(name: string): boolean {
	return /^(net\.minecraft\.client\.|com\.mojang\.blaze3d\.|net\.minecraft\.class_\d+$)/.test(name);
}

/**
 * What the log does not say: the server's memory limit, if it has one; its `max-tick-time` now
 * (null: not set, Minecraft's 60000); the stack lines the watchdog's crash report holds
 * (diagnoseRun reads them from the file the log names).
 */
export type RunContext = { memoryLimitMb?: number | null; maxTickTimeMs?: number | null; watchdogStack?: string[] };

/** Minecraft's own watchdog limit, when server.properties does not set one. */
const VANILLA_TICK_LIMIT_MS = 60_000;

/**
 * What a watchdog stop offers to raise `max-tick-time` to: 3 minutes from vanilla's 1, then
 * 10 (the most the settings field takes). Past 10 minutes a tick is not slow but stuck, so
 * nothing higher is offered; -1 (no watchdog) never is, since a hung server then stays up.
 */
export const TICK_LIMIT_STEPS = [180_000, 600_000];

export function raisedTickLimit(currentMs: number | null | undefined): number | null {
	const now = currentMs ?? VANILLA_TICK_LIMIT_MS;
	if (now < 0) return null;
	return TICK_LIMIT_STEPS.find((step) => step > now) ?? null;
}

const minutes = (ms: number) =>
	ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} seconds`;

export function diagnoseLog(rawLog: string, mods: ModJar[], context: RunContext = {}): Diagnosis[] {
	// Chat is blanked, keeping every other line where it was: players can type
	// anything, a loader's "Mod X requires Y, which is missing" included, and a
	// diagnosis offers to disable the mod it blames.
	// eslint-disable-next-line no-control-regex
	const lines = rawLog.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((line) => (isChat(line) ? '' : line));

	const byClass = new Map<string, ModJar>();
	for (const jar of mods) for (const c of jar.classes) if (!byClass.has(c)) byClass.set(c, jar);
	const byId = new Map<string, ModJar>();
	for (const jar of mods) for (const id of jar.ids) byId.set(id, jar);
	const byName = new Map<string, ModJar>();
	for (const jar of mods) for (const n of jar.names) byName.set(n.toLowerCase(), jar);

	function jarForClass(name: string): ModJar | undefined {
		let n = name;
		while (n) {
			const hit = byClass.get(n);
			if (hit) return hit;
			const cut = n.lastIndexOf('$');
			if (cut < 0) return undefined;
			n = n.slice(0, cut);
		}
		return undefined;
	}

	function jarForMod(idOrName: string): ModJar | undefined {
		return byId.get(idOrName.toLowerCase()) ?? byName.get(idOrName.toLowerCase());
	}

	/**
	 * Mixin renames injected handlers handler$<uid>$<modid>$<method>, with the
	 * mod id cut to 12 characters. That is the only trace of a mod whose code
	 * runs inside a Minecraft or loader class (FermiumBooter's crash has no
	 * frame of its own).
	 */
	function jarForMixinHandler(method: string): ModJar | undefined {
		const m = method.match(/^[a-z]+\$[a-z]{2}[a-z0-9]{3,4}\$([\w]+?)\$/);
		if (!m) return undefined;
		const prefix = m[1].toLowerCase();
		for (const [id, jar] of byId) if (id === prefix || (prefix.length >= 8 && id.startsWith(prefix))) return jar;
		return undefined;
	}

	/** The jar owning most of a class's package, for "the provider exists but lacks this class". */
	function packageOwner(name: string): ModJar | undefined {
		const parts = name.split('.');
		for (let len = parts.length - 1; len >= 2; len--) {
			const prefix = parts.slice(0, len).join('.') + '.';
			const counts = new Map<ModJar, number>();
			for (const [c, jar] of byClass) if (c.startsWith(prefix)) counts.set(jar, (counts.get(jar) ?? 0) + 1);
			if (counts.size) return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
		}
		return undefined;
	}

	/** Loader attribution lines name the mod whose code failed, more reliably than frames. */
	function attribution(from: number): ModJar | undefined {
		const lo = Math.max(0, from - 60);
		const hi = Math.min(lines.length, from + 120);
		const patterns = [
			/provided by '([^']+)'/, // Fabric, Quilt
			/Caught exception from (.+?) \(([^)]+)\)/, // legacy Forge, Cleanroom
			/: (.+?) \(([\w.\-]+)\) has failed to load correctly/, // modern Forge
			/\(([\w.\-]+)\) (?:has failed to load correctly|encountered an error during)/, // NeoForge
			/Failed to create mod instance\. ModID: ([\w.\-]+)/ // Forge 1.16
		];
		for (let i = lo; i < hi; i++) {
			for (const re of patterns) {
				const m = lines[i].match(re);
				if (!m) continue;
				const jar = jarForMod(m[m.length - 1]) ?? (m[1] ? jarForMod(m[1]) : undefined);
				if (jar) return jar;
			}
		}
		return undefined;
	}

	/** First stack frame after `from` that belongs to a mod jar (not the provider). */
	function frameCulprit(from: number, exclude?: ModJar): ModJar | undefined {
		return frameCulpritIn(lines.slice(from + 1, from + 200), exclude);
	}

	function frameCulpritIn(frames: string[], exclude?: ModJar): ModJar | undefined {
		for (const frame of frames) {
			const m = frame.match(FRAME);
			if (!m) continue;
			const cls = m[1];
			const handler = jarForMixinHandler(m[2]);
			if (handler && handler !== exclude) return handler;
			if (INFRA.test(cls)) continue;
			const jar = jarForClass(cls);
			if (jar && jar !== exclude) return jar;
		}
		return undefined;
	}

	function culpritFor(i: number, exclude?: ModJar): ModJar | undefined {
		const attributed = attribution(i);
		if (attributed && attributed !== exclude) return attributed;
		return frameCulprit(i, exclude);
	}

	const out: (Diagnosis & { at: number; consequence?: boolean })[] = [];
	const seen = new Set<string>();
	let current = 0;
	const byKey = new Map<string, Diagnosis & { at: number }>();
	/** `consequence`: ranked after the other fatal causes, which usually explain it. */
	const push = (d: Omit<Diagnosis, 'fatal'>, key: string, consequence = false) => {
		// The same error is often logged twice: once as an early warning and
		// again in the block that ends the start. The latest one decides
		// whether it was fatal.
		const existing = byKey.get(key);
		if (existing) {
			existing.at = current;
			return;
		}
		const entry = { ...d, fatal: true, at: current, consequence };
		byKey.set(key, entry);
		seen.add(key);
		out.push(entry);
	};
	// Classes a failed mixin was meant to patch: their NoClassDefFoundError is a
	// consequence of that failure, not client code.
	const mixinTargets = new Set<string>();
	for (const l of lines) {
		const t = l.match(/(?:-> |target class |in the target class )([\w$.]+)/);
		if (t && /[Mm]ixin/.test(l)) mixinTargets.add(t[1].replace(/\.$/, ''));
	}
	const disableFix = (jar: ModJar | undefined) =>
		jar && jar.enabled ? { enable: false, fileName: jar.fileName, label: `Disable ${ref(jar)!.name}` } : null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		current = i;
		let m: RegExpMatchArray | null;

		// ---- the kernel ended it for its memory (systemd's line; a cgroup limit or the whole machine)
		if (/A process of this unit has been killed by the OOM killer/.test(line)) {
			const limit = context.memoryLimitMb;
			push(
				{
					kind: 'memory-killed',
					title: limit ? `Killed at its memory limit (${limit} MB)` : 'Killed for running out of memory',
					detail: limit
						? `The kernel ended the server for using more memory than its limit allows (Settings > Limits), or the machine ran out. Java needs memory beyond its heap: loaded classes, threads and mods' native memory, several GB on a big pack, and a mod that leaks native memory keeps growing. Raise the limit or lower the maximum memory.`
						: 'The machine ran out of memory and the kernel ended the server. Lower its maximum memory, or that of other servers running beside it.',
					culprit: null,
					related: null,
					evidence: line.trim(),
					fix: null
				},
				'memory-killed'
			);
			continue;
		}

		// ---- the watchdog ended a tick that ran past max-tick-time (vanilla's ServerHangWatchdog, every loader)
		if ((m = line.match(/A single server tick took ([\d.,]+) seconds/))) {
			const tookMs = Math.round(Number(m[1].replace(',', '.')) * 1000);
			const limitMs = context.maxTickTimeMs ?? VANILLA_TICK_LIMIT_MS;
			const jar = frameCulpritIn(context.watchdogStack ?? []);
			const who = jar ? ` ${ref(jar)!.name}'s code was running when it stopped (the crash report's stack).` : '';
			// Raised since the crash: the next start gets the new limit, nothing more to offer.
			const raisedSince = limitMs > Math.max(tookMs, VANILLA_TICK_LIMIT_MS) * 1.5;
			const next = raisedSince ? null : raisedTickLimit(limitMs);
			const detail = raisedSince
				? `The limit is ${minutes(limitMs)} now, raised since; start the server to try again.${who}`
				: next
					? `One tick ran past the watchdog's limit (max-tick-time, ${minutes(limitMs)}), so it ended the server. Heavy modpacks stall like this while generating chunks, at a first start or during a pregeneration.${who} Allowing ${minutes(next)} gets past a slow tick; if it stops the same way again, the server is stuck rather than slow.`
					: `One tick ran past the watchdog's limit (max-tick-time, ${minutes(limitMs)}). A tick that long is not slow chunk generation but a server that hung, waiting for something that never came.${who} The crash report's "Server thread" shows where; disabling the mod there or updating it is the way out. -1 turns the watchdog off, but a hung server then stays up doing nothing.`;
			push(
				{
					kind: 'watchdog',
					title: `Stopped by the watchdog: one tick took ${tookMs >= 1000 ? `${(tookMs / 1000).toFixed(0)} s` : 'too long'}`,
					detail,
					culprit: ref(jar),
					related: null,
					evidence: line.trim(),
					fix: null,
					tickLimit: next ? { ms: next, label: `Allow ticks up to ${minutes(next)}` } : null
				},
				'watchdog'
			);
			continue;
		}

		// ---- loader dependency checks (each loader words these its own way)
		const deps: { who: string; needs: string; range?: string }[] = [];
		if ((m = line.match(/Mod '([^']+)' \(([\w.\-]+)\) \S+ requires .*?(?:of|mod) '?([\w.\-]+)'?.*?(?:which is missing|is not installed)/))) {
			deps.push({ who: m[2], needs: m[3] }); // Fabric 0.14+
		} else if ((m = line.match(/HARD_DEP_NO_CANDIDATE ([\w.\-]+) \S+ \{depends ([\w.\-]+)/))) {
			deps.push({ who: m[1], needs: m[2] }); // Fabric 0.15+ resolution detail
		} else if ((m = line.match(/Could not find required mod: ([\w.\-]+) requires \{([\w.\-]+)/))) {
			deps.push({ who: m[1], needs: m[2] }); // Fabric <= 0.13
		} else if ((m = line.match(/mod ([\w.\-]+) .*?requires .*?([\w.\-]+) .*?(?:which is missing|missing)/i)) && /quilt|Quilt/.test(rawLog) && !/Mod '/.test(line)) {
			deps.push({ who: m[1], needs: m[2] }); // Quilt
		} else if ((m = line.match(/Mod ([\w.\-]+) \(([^)]+)\) requires \[(.*)\]/))) {
			// legacy Forge: "requires [cleanroom@[0.4.4-alpha,), jei]" - ranges contain commas
			for (const d of m[3].matchAll(/([\w.\-]+)(?:@([\[(][^\])]*[\])]|[^,\s\]]+))?/g)) {
				deps.push({ who: m[1], needs: d[1], range: d[2] });
			}
		} else if ((m = line.match(/Mod ID: '([^']+)', Requested by: '([^']+)'(?:, Expected range: '([^']+)')?/))) {
			deps.push({ who: m[2], needs: m[1], range: m[3] }); // modern Forge
		} else if ((m = line.match(/^(?:\[[^\]]*\]\s*)*(.+?) requires (?:any version|version \S+|.+?) of ([\w.\-]+), which is missing!/)) && !/Mod '/.test(line)) {
			deps.push({ who: m[1].trim(), needs: m[2] }); // Quilt (display names)
		} else if ((m = line.match(/Mod (.+?) requires (.+?) (?:[\d.\-\[\]()]+ or above|any version)/)) && !/Mod '/.test(line)) {
			// NeoForge: names, not ids; next line says whether it is missing
			if (/not installed/i.test(lines[i + 1] ?? '') || /not installed/i.test(line)) deps.push({ who: m[1], needs: m[2] });
		}
		for (const { who, needs, range } of deps) {
			const jar = jarForMod(who);
			const loaderName = LOADER_IDS[needs.toLowerCase()];
			if (loaderName) {
				// Installed, but not in the version the mod asks for.
				const name = ref(jar)?.name ?? who;
				push(
					{
						kind: 'loader-version',
						title: `${name} needs ${loaderName}${range ? ` ${range}` : ''}`,
						detail: `The installed ${loaderName} does not match. Change the version in the server's Settings (General) to one in that range, or use a version of ${name} made for this setup.`,
						culprit: ref(jar),
						related: null,
						evidence: line.trim(),
						fix: null
					},
					`loaderdep:${who}:${needs}`
				);
				continue;
			}
			const provider = jarForMod(needs);
			if (provider && !provider.enabled) {
				push(
					{
						kind: 'disabled-dependency',
						title: `${ref(jar)?.name ?? who} needs ${ref(provider)!.name}, which is disabled`,
						detail: `Re-enable ${ref(provider)!.name}, or disable ${ref(jar)?.name ?? who} too.`,
						culprit: ref(jar),
						related: ref(provider),
						evidence: line.trim(),
						fix: { enable: true, fileName: provider.fileName, label: `Enable ${ref(provider)!.name}` }
					},
					`dep:${who}:${needs}`
				);
			} else {
				push(
					{
						kind: 'missing-dependency',
						title: `${ref(jar)?.name ?? who} needs "${needs}", which is not installed`,
						detail: `Install ${needs} (a version matching this Minecraft version and loader), or disable ${ref(jar)?.name ?? who}.`,
						culprit: ref(jar),
						related: null,
						evidence: line.trim(),
						fix: disableFix(jar)
					},
					`dep:${who}:${needs}`
				);
			}
		}

		// ---- client code on a dedicated server (modern Forge/NeoForge say so outright)
		if ((m = line.match(/Attempted to load class ([\w$/.]+) for invalid dist (\w+)/))) {
			const cls = normaliseClass(m[1]);
			const jar = culpritFor(i);
			push(
				{
					kind: 'client-code',
					title: `${ref(jar)?.name ?? 'A mod'} uses client-only game code`,
					detail: `It loaded ${cls}, which only exists on the game client. It is most likely a client-side mod that does not belong on a server; disable it.`,
					culprit: ref(jar),
					related: null,
					evidence: line.trim(),
					fix: disableFix(jar)
				},
				`client:${jar?.fileName ?? cls}`
			);
			continue;
		}

		// ---- missing classes
		if ((m = line.match(/(?:NoClassDefFoundError|ClassNotFoundException)(?::\s*|\s+)([\w$./]+)/))) {
			const cls = normaliseClass(m[1]);
			if (!cls.includes('.') || /^(java|javax|jdk|sun)\./.test(cls)) continue;
			// Exact match only: an outer class existing does not mean a missing
			// nested one (Foo$Bar) is there - that is a version mismatch.
			const provider = byClass.get(cls);
			const jar = culpritFor(i, provider);
			const who = ref(jar)?.name ?? 'A mod';
			if (provider && provider.clientOnly) {
				push(
					{
						kind: 'client-only-dependency',
						title: `${who} needs ${ref(provider)!.name}, which only runs on clients`,
						detail: `${ref(provider)!.name} is declared client-only, so the loader skips it on a server even though the file is installed, and ${who} cannot start without it. ${who} is not usable on a server like this; disable it.`,
						culprit: ref(jar),
						related: ref(provider),
						evidence: line.trim(),
						fix: disableFix(jar)
					},
					`clientdep:${jar?.fileName}:${provider.fileName}`
				);
			} else if (provider && !provider.enabled) {
				push(
					{
						kind: 'disabled-dependency',
						title: `${who} needs ${ref(provider)!.name}, which is disabled`,
						detail: `It tried to use ${cls}. Re-enable ${ref(provider)!.name}, or disable ${who} as well.`,
						culprit: ref(jar),
						related: ref(provider),
						evidence: line.trim(),
						fix: { enable: true, fileName: provider.fileName, label: `Enable ${ref(provider)!.name}` }
					},
					`disabled:${provider.fileName}`
				);
			} else if (!provider && isMinecraftClass(cls) && mixinTargets.has(cls)) {
				// Reported through the mixin failure that caused it.
			} else if (!provider && isMinecraftClass(cls) && !isClientMinecraftClass(cls)) {
				push(
					{
						kind: 'missing-class',
						title: `The game could not load ${cls}`,
						detail: `${cls} is part of the server itself, so it failed to load rather than being absent - usually because a mod's patch to it broke. Look at the other errors listed here for the mod involved.`,
						culprit: ref(jar),
						related: null,
						evidence: line.trim(),
						fix: null
					},
					`gameclass:${cls}`,
					true
				);
			} else if (!provider && isMinecraftClass(cls)) {
				push(
					{
						kind: 'client-code',
						title: `${who} uses client-only game code`,
						detail: `It loaded ${cls}, which ${isClientMinecraftClass(cls) ? 'only exists on the game client' : 'does not exist in this server'}. It is most likely a client-side mod (or built for another Minecraft version); disable it.`,
						culprit: ref(jar),
						related: null,
						evidence: line.trim(),
						fix: disableFix(jar)
					},
					`client:${jar?.fileName ?? cls}`
				);
			} else if (!provider) {
				const owner = (cls.includes('$') ? jarForClass(cls) : undefined) ?? packageOwner(cls);
				if (owner && !jar) {
					push(
						{
							kind: 'version-mismatch',
							title: `${ref(owner)!.name} is missing one of its own classes`,
							detail: `${owner.fileName} refers to ${cls}, which is not in the jar. This is a packaging problem in that mod; if the server carries on past it, it is usually harmless.`,
							culprit: ref(owner),
							related: null,
							evidence: line.trim(),
							fix: null
						},
						`ownclass:${owner.fileName}`
					);
				} else if (owner && owner !== jar) {
					push(
						{
							kind: 'version-mismatch',
							title: `${who} expects a different version of ${ref(owner)!.name}`,
							detail: `It uses ${cls}, which the installed ${ref(owner)!.name} (${owner.fileName}) does not have. Install the ${ref(owner)!.name} version ${who} was built for, or disable ${who}. If this server came from a modpack, its configs may normally switch this integration off; "Reinstall pack files" restores them.`,
							culprit: ref(jar),
							related: ref(owner),
							evidence: line.trim(),
							fix: disableFix(jar)
						},
						`mismatch:${jar?.fileName}:${owner.fileName}`
					);
				} else {
					push(
						{
							kind: 'missing-class',
							title: `${who} needs something that is not installed`,
							detail: `It uses ${cls} (package ${cls.split('.').slice(0, -1).join('.')}), which no installed mod provides. A dependency is probably missing.`,
							culprit: ref(jar),
							related: null,
							evidence: line.trim(),
							fix: null
						},
						`missing:${jar?.fileName}:${cls.split('.').slice(0, 3).join('.')}`
					);
				}
			}
			continue;
		}

		// ---- methods/fields that do not exist in the installed version
		if ((m = line.match(/NoSuch(Method|Field)(?:Error|Exception):\s*['"]?(?:[\w$.<>\[\]]+\s+)?([\w$./]+)[.(]/))) {
			const owner = normaliseClass(m[2]).replace(/\.[\w$<>]+$/, (s) => (/^\.[a-z]/.test(s) ? '' : s));
			const member = m[2].replace(/\//g, '.');
			const ownerJar = jarForClass(owner);
			const jar = culpritFor(i, ownerJar);
			if (!jar) continue;
			const fugue = jarForMod('fugue');
			if (/^com\.cleanroommc\.(?!fugue\.)/.test(owner) && fugue?.enabled && fugue !== jar) {
				// Fugue rewrites other mods' calls into Cleanroom helpers while
				// loading them, so its own classes are nowhere in the stack: Fugue
				// 0.21 calls ReflectionHackery.getURL, which Cleanroom 0.5.3 removed.
				push(
					{
						kind: 'loader-version',
						title: `${ref(fugue)!.name} does not match this Cleanroom version`,
						detail: `${ref(jar)!.name} crashed calling ${member}, which the installed Cleanroom does not have. ${ref(fugue)!.name} patches mods to call Cleanroom's helpers, so a ${ref(fugue)!.name} built for another Cleanroom version breaks them like this. Install a ${ref(fugue)!.name} version made for this Cleanroom (Fugue 0.21, for one, needs Cleanroom 0.5.2 or older), or change Cleanroom in the server's Settings.`,
						culprit: ref(fugue),
						related: ref(jar),
						evidence: line.trim(),
						fix: null
					},
					`fugue:${fugue.fileName}`
				);
				continue;
			}
			if (!ownerJar && (/^net\.minecraft\.client\./.test(owner) || (isMinecraftClass(owner) && /\.func_\d+_[a-z]+$/.test(member)))) {
				// Forge strips client-only (@SideOnly) methods from the server's
				// classes, and 1.12 names (func_<n>_x) are the same in every
				// version, so a missing one is client code rather than another
				// Minecraft version.
				const cleanroom = /cleanroom-[\d.]+-alpha\.jar|top\.outlands\./.test(rawLog);
				push(
					{
						kind: 'client-code',
						title: `${ref(jar)!.name} uses client-only game code`,
						detail: `It calls ${member}, which only exists on the game client: servers do not have client-only methods. It is a client-side mod, or does something client-only while loading; disable it if nothing on the server needs it.${cleanroom ? ' If the pack needs it, a newer Cleanroom version may help: Cleanroom keeps some client-only methods on servers (text formatting from 0.5.4).' : ''}`,
						culprit: ref(jar),
						related: null,
						evidence: line.trim(),
						fix: disableFix(jar)
					},
					`client:${jar.fileName}`
				);
				continue;
			}
			const target = /^org\.spongepowered\./.test(owner)
				? 'the Mixin library'
				: ownerJar
					? ref(ownerJar)!.name
					: /^(net\.minecraftforge|net\.neoforged|net\.fabricmc|org\.quiltmc|com\.cleanroommc|top\.outlands)/.test(owner)
						? 'the mod loader'
						: isMinecraftClass(owner)
							? 'Minecraft'
							: owner;
			push(
				{
					kind: 'incompatible-method',
					title: `${ref(jar)!.name} is built for a different version of ${target}`,
					detail: `It calls ${member}, which the installed ${target.replace(/^the /, '')} does not have. Use a version of ${ref(jar)!.name} made for this setup, or disable it.`,
					culprit: ref(jar),
					related: ref(ownerJar),
					evidence: line.trim(),
					fix: disableFix(jar)
				},
				`method:${jar.fileName}`
			);
			continue;
		}

		// ---- class files newer than the running Java
		if ((m = line.match(/UnsupportedClassVersionError:\s*([\w$/.]+) has been compiled by a more recent version of the Java Runtime \(class file version (\d+)(?:\.\d+)?\), this version of the Java Runtime only recognizes class file versions up to (\d+)/))) {
			const cls = normaliseClass(m[1]);
			const needs = Number(m[2]) - 44;
			const running = Number(m[3]) - 44;
			const jar = jarForClass(cls) ?? culpritFor(i);
			const who = ref(jar)?.name ?? (/^(net\.minecraftforge|net\.neoforged|net\.fabricmc|org\.quiltmc|com\.cleanroommc|top\.outlands)/.test(cls) ? 'The mod loader' : 'A mod');
			push(
				{
					kind: 'java-version',
					title: `${who} needs Java ${needs}, but the server runs Java ${running}`,
					detail: `${cls} was built for Java ${needs}. ${jar ? `Use a version of ${who} built for Java ${running}, or install` : 'Install'} Java ${needs} (for example \`sudo apt install openjdk-${needs}-jre-headless\`); MineShell picks it up after "Rescan for Java" in the server's Settings (Java & memory), or pin it there.`,
					culprit: ref(jar),
					related: null,
					evidence: line.trim(),
					fix: null
				},
				`java:${jar?.fileName ?? cls}`
			);
			continue;
		}

		// ---- a mixin config asking for a newer Java than the one running
		if ((m = line.match(/compatibility level JAVA_(\d+) could not be set.*?\(Java (\d+)/))) {
			const earlier = [...byKey.keys()].find((k) => k.startsWith('java:'));
			if (earlier) {
				byKey.get(earlier)!.at = i;
			} else {
				push(
					{
						kind: 'java-version',
						title: `A mod needs Java ${m[1]}, but the server runs Java ${m[2]}`,
						detail: `One of the installed mods' mixin configs requires Java ${m[1]}. Install Java ${m[1]}, or find the mod (it is usually named just above this error) and use a version built for Java ${m[2]}.`,
						culprit: null,
						related: null,
						evidence: line.trim(),
						fix: null
					},
					`java:mixin:${m[1]}`
				);
			}
			continue;
		}

		// ---- GUI on a headless server
		if (/java\.awt\.HeadlessException|No X11 DISPLAY variable|Can't connect to X11/.test(line)) {
			const jar = culpritFor(i);
			push(
				{
					kind: 'headless',
					title: `${ref(jar)?.name ?? 'A mod'} tries to open a window`,
					detail: 'Servers have no screen, so this crashes. It is a client-side or desktop-only mod; disable it.',
					culprit: ref(jar),
					related: null,
					evidence: line.trim(),
					fix: disableFix(jar)
				},
				`headless:${jar?.fileName}`
			);
			continue;
		}

		// ---- mixins that cannot apply
		if (
			(m = line.match(/Mixin apply (?:for mod ([\w.\-]+) )?failed ([\w./\-]+\.json)/)) ||
			((m = line.match(/Mixin \[([\w./\-]+\.json):[\w$.]+(?: from mod ([\w.\-]+))?\].*FAILED during/)) && (m = [m[0], m[2], m[1]] as unknown as RegExpMatchArray))
		) {
			const jar = (m[1] && jarForMod(m[1])) || mods.find((j) => j.mixinConfigs.includes(m![2]));
			const target = line.match(/-> ([\w$.]+)/)?.[1];
			push(
				{
					kind: 'mixin-failure',
					title: `${ref(jar)?.name ?? m[1] ?? 'A mod'} could not patch ${target ?? 'the game'}`,
					detail: `Its mixin config ${m[2]} failed to apply. The mod is incompatible with this loader or Minecraft version, or another mod already changed the same code. Disable it or install a version made for this setup.`,
					culprit: ref(jar),
					related: null,
					evidence: line.trim().slice(0, 400),
					fix: disableFix(jar)
				},
				`mixin:${jar?.fileName ?? m[2]}`
			);
		}
	}

	// Everything before the first line that ends the start is context, not the cause.
	const FATAL = [
		/Encountered an unexpected exception/, // Minecraft server crash (all loaders)
		/Unable to launch/, // LaunchWrapper / Cleanroom Foundation
		/A problem occurred running the Server launcher/, // legacy Forge launcher
		/An error occurred trying to configure the minecraft home/, // legacy Forge coremods
		/Failed to start the minecraft server/, // Fabric
		/Could not execute entrypoint stage/, // Fabric, Quilt
		/Mod resolution failed|Incompatible mods? (?:set|found)!?/, // Fabric, Quilt
		/Crashed! The full crash report/, // Quilt
		/Missing or unsupported mandatory dependencies/, // modern Forge
		/Loading errors encountered|ModLoadingException/, // NeoForge, modern Forge
		/MissingModsException/, // legacy Forge
		/Error: LinkageError occurred while loading main class|Exception in thread "main"/, // JVM
		/A process of this unit has been killed by the OOM killer/, // systemd
		/A single server tick took [\d.,]+ seconds/ // the watchdog (all loaders)
	];
	const fatalAt = lines.findIndex((l) => FATAL.some((re) => re.test(l)));
	// Loaders print the cause just before their marker; nothing logged before a memory kill caused it.
	const before = fatalAt >= 0 && /killed by the OOM killer/.test(lines[fatalAt]) ? 0 : 3;
	const ranked = out.map((d) => ({ ...d, fatal: fatalAt < 0 || d.at >= fatalAt - before }));
	ranked.sort((a, b) => Number(b.fatal) - Number(a.fatal) || Number(a.consequence) - Number(b.consequence) || a.at - b.at);
	return ranked.map(({ at: _at, consequence: _consequence, ...d }) => d);
}

/** The output of the most recent run: everything after the last systemd "Started" line. */
export function lastRun(journal: string): string {
	const lines = journal.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		if (/^Started \S+\.service/.test(lines[i])) return lines.slice(i).join('\n');
	}
	return journal;
}

export async function diagnoseRun(journal: string, modsDir: string, context: RunContext = {}): Promise<Diagnosis[]> {
	const log = lastRun(journal);
	const serverDir = path.dirname(modsDir);
	const watchdogStack = context.watchdogStack ?? (await watchdogReportStack(log, serverDir));
	const maxTickTimeMs = context.maxTickTimeMs !== undefined ? context.maxTickTimeMs : await tickLimitOf(serverDir);
	return diagnoseLog(log, await indexMods(modsDir), { ...context, watchdogStack, maxTickTimeMs });
}

/** `max-tick-time` from the server's server.properties now; null when it is not set. A number needs no unescaping. */
export async function tickLimitOf(serverDir: string): Promise<number | null> {
	const text = await fs.readFile(path.join(serverDir, 'server.properties'), 'latin1').catch(() => '');
	const raw = text.match(/^[ \t]*max-tick-time[ \t]*[=:][ \t]*(-?\d+)[ \t]*$/m)?.[1];
	return raw === undefined ? null : Number(raw);
}

/**
 * The stalled thread's stack from the crash report a watchdog stop names ("This crash report
 * has been saved to: <path>"): the log has only the one line, the report what was running. Read
 * only from the server's own crash-reports/ folder. Frames lose their module prefix
 * (`app//`, `TRANSFORMER/create@6.0/`) so they read like the log's.
 */
export async function watchdogReportStack(log: string, serverDir: string): Promise<string[]> {
	if (!/A single server tick took/.test(log)) return [];
	const saved = [...log.matchAll(/This crash report has been saved to: (\S+\.txt)/g)].at(-1)?.[1];
	if (!saved) return [];
	const folder = path.join(path.resolve(serverDir), 'crash-reports') + path.sep;
	const file = path.resolve(serverDir, saved);
	if (!file.startsWith(folder)) return [];
	const text = await fs.readFile(file, 'utf8').catch(() => '');
	if (!/Description: Watching Server/.test(text)) return [];
	const body = text.slice(text.indexOf('Description: Watching Server'));
	const end = body.indexOf('A detailed walkthrough');
	return (end >= 0 ? body.slice(0, end) : body.slice(0, 64 * 1024))
		.split('\n')
		.filter((l) => /^\s*at\s/.test(l))
		.map((l) => l.replace(/^(\s*at\s+)(?:[^\s(]*\/)+/, '$1'));
}
