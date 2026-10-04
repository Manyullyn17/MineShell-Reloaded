import fs from 'node:fs/promises';
import path from 'node:path';
// With the extension: capture.mjs runs this file under plain node, which needs it.
import { openZipBuffer, openZipFile, type ZipEntry } from './zip.ts';

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
	/** Declared client-only (Fabric/Quilt `environment: client`); the loader skips it on a server. */
	clientOnly: boolean;
	/** Mod ids it declares as required, lower-cased (Minecraft and loaders included). */
	requires: string[];
	/** Class names (dotted) in the jar and in any jars nested inside it. */
	classes: Set<string>;
	/** Mixin config files shipped at the jar root. */
	mixinConfigs: string[];
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
				if (nested) await indexZip(nested, depth + 1, into);
			} catch {
				/* unreadable nested jar */
			}
		}
	}
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
 * with `mandatory=true` (Forge) or `type="required"` (NeoForge).
 */
function tomlRequired(text: string): string[] {
	return tomlBlocks(text, /^dependencies\./)
		.filter((b) => /^\s*mandatory\s*=\s*true/m.test(b) || /^\s*type\s*=\s*"required"/m.test(b))
		.flatMap((b) => tomlValues(b, 'modId'));
}

async function describeJar(file: string): Promise<Omit<ModJar, 'fileName' | 'enabled'>> {
	const info: Omit<ModJar, 'fileName' | 'enabled'> = {
		ids: [],
		names: [],
		clientOnly: false,
		requires: [],
		classes: new Set(),
		mixinConfigs: []
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
			if (meta.environment === 'client') info.clientOnly = true;
			if (meta.depends && typeof meta.depends === 'object') info.requires.push(...Object.keys(meta.depends));
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
			}
			info.requires.push(...tomlRequired(text));
		}
	}
	const mcmod = await readText(zip, 'mcmod.info');
	if (mcmod) {
		info.ids.push(...[...mcmod.matchAll(/"modid"\s*:\s*"([^"]+)"/g)].map((m) => m[1]));
		info.names.push(...[...mcmod.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]));
		for (const list of mcmod.matchAll(/"requiredMods"\s*:\s*\[([^\]]*)\]/g)) {
			info.requires.push(...[...list[1].matchAll(/"([^"@]+)/g)].map((m) => m[1]));
		}
	}
	info.ids = [...new Set(info.ids.map((s) => s.toLowerCase()))];
	info.names = [...new Set(info.names)];
	info.requires = [...new Set(info.requires.map((s) => s.toLowerCase()))];
	return info;
}

const DISABLED_SUFFIX = '.disabled';

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
		const full = path.join(modsDir, fileName);
		const stat = await fs.stat(full).catch(() => null);
		if (!stat?.isFile()) continue;
		const key = `${stat.size}:${stat.mtimeMs}`;
		let cached = jarCache.get(full);
		if (!cached || cached.key !== key) {
			cached = { key, jar: await describeJar(full) };
			jarCache.set(full, cached);
		}
		jars.push({ fileName, enabled, ...cached.jar });
	}
	return jars;
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
	| 'loader-version';

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

export function diagnoseLog(rawLog: string, mods: ModJar[]): Diagnosis[] {
	// eslint-disable-next-line no-control-regex
	const lines = rawLog.replace(/\x1b\[[0-9;]*m/g, '').split('\n');

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
		for (let i = from + 1; i < Math.min(lines.length, from + 200); i++) {
			const m = lines[i].match(FRAME);
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

	const out: (Diagnosis & { at: number })[] = [];
	const seen = new Set<string>();
	let current = 0;
	const byKey = new Map<string, Diagnosis & { at: number }>();
	const push = (d: Omit<Diagnosis, 'fatal'>, key: string) => {
		// The same error is often logged twice: once as an early warning and
		// again in the block that ends the start. The latest one decides
		// whether it was fatal.
		const existing = byKey.get(key);
		if (existing) {
			existing.at = current;
			return;
		}
		const entry = { ...d, fatal: true, at: current };
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
						detail: `The installed ${loaderName} does not match. Change the version in the instance settings to one in that range, or use a version of ${name} made for this setup.`,
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
					`gameclass:${cls}`
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
			const ownerJar = jarForClass(owner);
			const jar = culpritFor(i, ownerJar);
			if (!jar) continue;
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
					detail: `It calls ${m[2].replace(/\//g, '.')}, which the installed ${target} does not have. Use a version of ${ref(jar)!.name} made for this setup, or disable it.`,
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
					detail: `${cls} was built for Java ${needs}. ${jar ? `Use a version of ${who} built for Java ${running}, or install` : 'Install'} Java ${needs} (for example \`sudo apt install openjdk-${needs}-jre-headless\`); MineShell picks it up after "Rescan for Java" in the instance settings, or pin it there under Runtime.`,
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
		/Error: LinkageError occurred while loading main class|Exception in thread "main"/ // JVM
	];
	const fatalAt = lines.findIndex((l) => FATAL.some((re) => re.test(l)));
	const ranked = out.map((d) => ({ ...d, fatal: fatalAt < 0 || d.at >= fatalAt - 3 }));
	ranked.sort((a, b) => Number(b.fatal) - Number(a.fatal) || a.at - b.at);
	return ranked.map(({ at: _at, ...d }) => d);
}

/** The output of the most recent run: everything after the last systemd "Started" line. */
export function lastRun(journal: string): string {
	const lines = journal.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		if (/^Started \S+\.service/.test(lines[i])) return lines.slice(i).join('\n');
	}
	return journal;
}

export async function diagnoseRun(journal: string, modsDir: string): Promise<Diagnosis[]> {
	return diagnoseLog(lastRun(journal), await indexMods(modsDir));
}
