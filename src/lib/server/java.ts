import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { javaRuntimes, settings } from './db/schema';
import { run } from './systemd';
import { cleanroomJavaMajor } from '#lib/shared/cleanroom.js';
import { minecraftJavaMajor } from './modloaders';
import { DATA_DIR } from './config';

/**
 * Two jobs: work out which Java a given Minecraft version needs, and find the
 * JDKs actually present on the box. Instances store either an explicit java
 * path or nothing, in which case the mapping picks the best installed match.
 */

type JavaRule = { minInclusive: string; java: number };

/**
 * Fallback only: what Mojang declares per version (learnJavaRequirement) wins.
 * Ordered newest-first; `minInclusive` is the first Minecraft version that
 * requires the given Java major.
 */
const JAVA_RULES: JavaRule[] = [
	{ minInclusive: '26.1', java: 25 },
	{ minInclusive: '1.20.5', java: 21 },
	{ minInclusive: '1.18', java: 17 },
	{ minInclusive: '1.17', java: 16 },
	{ minInclusive: '1.0', java: 8 }
];

// Java majors Mojang declared per Minecraft version, kept in the settings
// table so they survive restarts and work offline.
const LEARNED_KEY = 'java.minecraftRequirements';
let learned: Record<string, number> | null = null;

function learnedRequirements(): Record<string, number> {
	if (learned) return learned;
	const row = db.select().from(settings).where(eq(settings.key, LEARNED_KEY)).get();
	try {
		learned = row?.value ? JSON.parse(row.value) : {};
	} catch {
		learned = {};
	}
	return learned!;
}

/**
 * Look up (once) and remember the Java major Mojang declares for a Minecraft
 * version. Call before anything resolves Java for that version; offline it is
 * a no-op and the fallback rules apply.
 */
export async function learnJavaRequirement(minecraftVersion: string): Promise<void> {
	const known = learnedRequirements();
	if (known[minecraftVersion]) return;
	try {
		const major = await minecraftJavaMajor(minecraftVersion);
		if (!major) return;
		known[minecraftVersion] = major;
		const value = JSON.stringify(known);
		db.insert(settings)
			.values({ key: LEARNED_KEY, value })
			.onConflictDoUpdate({ target: settings.key, set: { value } })
			.run();
	} catch {
		/* offline or unknown version: the rules below still answer */
	}
}

/** Compare dotted versions numerically; missing components count as zero. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
	const pb = b.split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * The Java major version a server needs: Mojang's requirement for the Minecraft
 * version, except for loaders that replace the runtime story outright.
 */
export function requiredJavaMajor(
	minecraftVersion: string,
	modloader?: string,
	modloaderVersion?: string | null
): number {
	// Cleanroom is 1.12.2 rebuilt for modern Java; Mojang's 1.12.2 -> 8 rule does not apply.
	if (modloader === 'cleanroom') return cleanroomJavaMajor(modloaderVersion);
	const clean = minecraftVersion.trim();
	const declared = learnedRequirements()[clean];
	if (declared) return declared;
	for (const rule of JAVA_RULES) {
		if (compareVersions(clean, rule.minInclusive) >= 0) return rule.java;
	}
	return 8;
}

/**
 * Newer JDKs usually run older servers, with known exceptions: Forge for 1.16
 * and below breaks on Java 17+, and 1.12-era packs want 8 specifically. Callers
 * get a preferred major plus the range that is safe to substitute.
 */
export function acceptableJavaMajors(
	minecraftVersion: string,
	modloader: string,
	modloaderVersion?: string | null
): number[] {
	const required = requiredJavaMajor(minecraftVersion, modloader, modloaderVersion);
	if (required === 8) {
		// Legacy Forge is the strict case; Fabric on 1.16 tolerates 11 and 17.
		return modloader === 'forge' ? [8] : [8, 11, 17];
	}
	if (required === 16) return [16, 17];
	if (required === 17) return [17, 18, 19, 20, 21];
	if (required === 25) return [25, 26, 27];
	return [21, 22, 23, 24, 25];
}

const SCAN_ROOTS = [
	'/usr/lib/jvm',
	'/usr/lib64/jvm',
	'/usr/java',
	'/opt/java',
	'/opt/jdk',
	'/opt/hostedtoolcache/Java_Adoptium_jdk',
	path.join(homedir(), '.sdkman', 'candidates', 'java'),
	path.join(homedir(), '.jdks'),
	path.join(homedir(), '.local', 'share', 'PrismLauncher', 'java'),
	// Runtimes MineShell downloaded (javadownload.ts).
	path.join(DATA_DIR, 'java')
];

async function candidateBinaries(): Promise<string[]> {
	const found = new Set<string>();

	for (const root of SCAN_ROOTS) {
		let entries: string[] = [];
		try {
			entries = await fs.readdir(root);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const bin = path.join(root, entry, 'bin', 'java');
			try {
				await fs.access(bin, fs.constants.X_OK);
				found.add(await fs.realpath(bin));
			} catch {
				/* not a JDK dir */
			}
		}
	}

	if (process.env.JAVA_HOME) {
		const bin = path.join(process.env.JAVA_HOME, 'bin', 'java');
		try {
			await fs.access(bin, fs.constants.X_OK);
			found.add(await fs.realpath(bin));
		} catch {
			/* ignore */
		}
	}

	const which = await run(['sh', '-c', 'command -v java'], { timeoutMs: 5000 });
	if (which.code === 0 && which.stdout.trim()) {
		try {
			found.add(await fs.realpath(which.stdout.trim()));
		} catch {
			/* ignore */
		}
	}

	return [...found];
}

export type ProbedJava = {
	path: string;
	majorVersion: number;
	versionString: string;
	vendor: string | null;
};

/** `java -version` writes to stderr; both streams are checked to be safe. */
export async function probeJava(binary: string): Promise<ProbedJava | null> {
	const res = await run([binary, '-version'], { timeoutMs: 10_000 });
	const output = `${res.stderr}\n${res.stdout}`;
	const match = output.match(/version "([^"]+)"/);
	if (!match) return null;
	const versionString = match[1];
	const parts = versionString.split(/[._]/);
	// "1.8.0_412" -> 8, "21.0.3" -> 21
	const major = parts[0] === '1' ? parseInt(parts[1], 10) : parseInt(parts[0], 10);
	if (!Number.isFinite(major)) return null;
	const vendorLine = output.split('\n').find((l) => /Runtime Environment/i.test(l)) ?? '';
	return {
		path: binary,
		majorVersion: major,
		versionString,
		vendor: vendorLine.trim() || null
	};
}

/** Scan the usual install locations and refresh the java_runtimes table. */
export async function scanJavaRuntimes(): Promise<ProbedJava[]> {
	const binaries = await candidateBinaries();
	const probed: ProbedJava[] = [];
	for (const bin of binaries) {
		const info = await probeJava(bin);
		if (info) probed.push(info);
	}

	const now = Date.now();
	for (const info of probed) {
		db.insert(javaRuntimes)
			.values({
				path: info.path,
				majorVersion: info.majorVersion,
				versionString: info.versionString,
				vendor: info.vendor,
				manual: false,
				lastSeenAt: now
			})
			.onConflictDoUpdate({
				target: javaRuntimes.path,
				set: {
					majorVersion: info.majorVersion,
					versionString: info.versionString,
					vendor: info.vendor,
					lastSeenAt: now
				}
			})
			.run();
	}
	return probed;
}

export function listJavaRuntimes() {
	return db.select().from(javaRuntimes).orderBy(javaRuntimes.majorVersion).all();
}

export async function addManualJava(binary: string) {
	const info = await probeJava(binary);
	if (!info) throw new Error(`${binary} did not answer to \`java -version\`.`);
	db.insert(javaRuntimes)
		.values({ ...info, manual: true, lastSeenAt: Date.now() })
		.onConflictDoUpdate({
			target: javaRuntimes.path,
			set: { ...info, manual: true, lastSeenAt: Date.now() }
		})
		.run();
	return info;
}

export function removeJavaRuntime(binary: string) {
	db.delete(javaRuntimes).where(eq(javaRuntimes.path, binary)).run();
}

// ------------------------------------------------- default per major ---

/**
 * The runtime to use for each Java major when several are installed, set in
 * Settings: { "17": "/usr/lib/jvm/java-17-openjdk-amd64/bin/java" }. A server
 * pinned to a path ignores it.
 */
const DEFAULTS_KEY = 'java.defaults';

/** Every read is validated, so a stale or hand-edited row degrades to no defaults. */
export function getJavaDefaults(): Record<number, string> {
	const row = db.select().from(settings).where(eq(settings.key, DEFAULTS_KEY)).get();
	let raw: unknown;
	try {
		raw = row ? JSON.parse(row.value) : {};
	} catch {
		return {};
	}
	const defaults: Record<number, string> = {};
	if (!raw || typeof raw !== 'object') return defaults;
	for (const [key, value] of Object.entries(raw)) {
		const major = Number(key);
		if (Number.isInteger(major) && major > 0 && typeof value === 'string' && value) defaults[major] = value;
	}
	return defaults;
}

/** Null clears it, back to the newest runtime of that major. */
export function setJavaDefault(major: number, binary: string | null): void {
	const defaults = getJavaDefaults();
	if (binary) defaults[major] = binary;
	else delete defaults[major];
	const value = JSON.stringify(defaults);
	db.insert(settings)
		.values({ key: DEFAULTS_KEY, value })
		.onConflictDoUpdate({ target: settings.key, set: { value } })
		.run();
}

/** "17.0.12" / "1.8.0_422" -> numbers, for comparing builds of one major. */
function versionParts(version: string): number[] {
	return (version.match(/\d+/g) ?? []).map(Number);
}

function newerFirst(a: { versionString: string; path: string }, b: { versionString: string; path: string }): number {
	const x = versionParts(a.versionString);
	const y = versionParts(b.versionString);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const diff = (y[i] ?? 0) - (x[i] ?? 0);
		if (diff) return diff;
	}
	return a.path.localeCompare(b.path);
}

type Runtime = ReturnType<typeof listJavaRuntimes>[number];

/**
 * The runtime used for one major: the default set for it if that is still
 * installed, otherwise the newest build, and the path between equal builds -
 * so the same machine always gives the same answer.
 */
export function runtimeForMajor(
	installed: Runtime[],
	major: number,
	defaults: Record<number, string> = getJavaDefaults()
): { runtime: Runtime; isDefault: boolean } | null {
	const candidates = installed.filter((j) => j.majorVersion === major);
	const chosen = candidates.find((j) => j.path === defaults[major]);
	if (chosen) return { runtime: chosen, isDefault: true };
	const newest = [...candidates].sort(newerFirst)[0];
	return newest ? { runtime: newest, isDefault: false } : null;
}

export type JavaResolution = {
	path: string | null;
	majorVersion: number | null;
	requiredMajor: number;
	/**
	 * explicit = pinned on the instance, default = the runtime set as default for
	 * its major, auto = matched by version, missing = none found
	 */
	origin: 'explicit' | 'default' | 'auto' | 'missing';
	warning: string | null;
};

/**
 * Resolve the java binary for an instance. An explicit path always wins, even if
 * it looks wrong for the Minecraft version - the warning says so rather than
 * silently overriding the choice.
 */
export function resolveJava(opts: {
	explicitPath?: string | null;
	minecraftVersion: string;
	modloader: string;
	modloaderVersion?: string | null;
}): JavaResolution {
	const requiredMajor = requiredJavaMajor(opts.minecraftVersion, opts.modloader, opts.modloaderVersion);
	const acceptable = acceptableJavaMajors(opts.minecraftVersion, opts.modloader, opts.modloaderVersion);
	const installed = listJavaRuntimes();

	if (opts.explicitPath) {
		const known = installed.find((j) => j.path === opts.explicitPath);
		const warning =
			known && !acceptable.includes(known.majorVersion)
				? `This instance is pinned to Java ${known.majorVersion}, but ${opts.modloader === 'cleanroom' ? 'Cleanroom' : `Minecraft ${opts.minecraftVersion}`} expects Java ${requiredMajor}.`
				: null;
		return {
			path: opts.explicitPath,
			majorVersion: known?.majorVersion ?? null,
			requiredMajor,
			origin: 'explicit',
			warning
		};
	}

	// Prefer the exact required major, then the lowest acceptable one.
	const defaults = getJavaDefaults();
	const majors = [requiredMajor, ...[...new Set(installed.map((j) => j.majorVersion))].filter((m) => acceptable.includes(m)).sort((a, b) => a - b)];
	let pick: ReturnType<typeof runtimeForMajor> = null;
	for (const major of majors) {
		pick = runtimeForMajor(installed, major, defaults);
		if (pick) break;
	}

	if (!pick) {
		return {
			path: null,
			majorVersion: null,
			requiredMajor,
			origin: 'missing',
			warning: `No Java ${requiredMajor} runtime found. Download one in Settings, install one with your package manager and rescan, or pin a path in instance settings.`
		};
	}

	const chosen = pick.runtime;
	return {
		path: chosen.path,
		majorVersion: chosen.majorVersion,
		requiredMajor,
		origin: pick.isDefault ? 'default' : 'auto',
		warning:
			chosen.majorVersion === requiredMajor
				? null
				: `Using Java ${chosen.majorVersion}; Minecraft ${opts.minecraftVersion} nominally wants Java ${requiredMajor}.`
	};
}
