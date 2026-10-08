import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadFile, fetchJson, fetchText } from './download';
import { run } from './systemd';
import type { TaskHandle } from './tasks';
import { CLEANROOM_MINECRAFT } from '#lib/shared/cleanroom.js';

/**
 * Every loader answers the same two questions: what versions exist, and how do I
 * end up with something runnable in this directory. Adding Quilt-like loader X
 * means adding one entry to LOADERS - nothing else in the app changes.
 *
 * `launchArgs` is what goes after the JVM args in the systemd unit. Modern Forge
 * and NeoForge do not ship a fat server jar any more, so they return an @argfile
 * form instead of `-jar something.jar`.
 */

export type ModloaderId = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'cleanroom';

export type InstallContext = {
	dir: string;
	minecraftVersion: string;
	loaderVersion?: string | null;
	javaPath: string;
	task?: TaskHandle;
};

export type InstallResult = {
	launchArgs: string;
	loaderVersion: string | null;
};

export type Modloader = {
	id: ModloaderId;
	label: string;
	/** Shown in the UI under the loader picker. */
	blurb: string;
	supportsMods: boolean;
	/**
	 * Set when the loader only exists for a fixed set of Minecraft versions, so
	 * the new-server form can offer just those instead of Mojang's whole list.
	 */
	onlyGameVersions?: string[];
	/**
	 * The loader name mod catalogs publish this loader's mods under, when it
	 * differs from `id`. Neither Modrinth nor CurseForge has a Cleanroom tag;
	 * Cleanroom mods are ordinary 1.12.2 Forge mods there.
	 */
	catalogLoader?: ModloaderId;
	listGameVersions: () => Promise<string[]>;
	listLoaderVersions: (minecraftVersion: string) => Promise<string[]>;
	install: (ctx: InstallContext) => Promise<InstallResult>;
};

function log(ctx: InstallContext, message: string) {
	ctx.task?.log(message);
}

/** True when a dotted version is older than major.minor (0.11.7 before [0, 12]). */
function versionBefore(version: string, [major, minor]: [number, number]): boolean {
	const [a = 0, b = 0] = version.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
	return a < major || (a === major && b < minor);
}

// ---------------------------------------------------------------- vanilla ---

type MojangManifest = {
	latest: { release: string; snapshot: string };
	versions: { id: string; type: string; url: string }[];
};

const MOJANG_MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

let manifestCache: { at: number; data: MojangManifest } | null = null;

async function mojangManifest(): Promise<MojangManifest> {
	if (manifestCache && Date.now() - manifestCache.at < 10 * 60_000) return manifestCache.data;
	const data = await fetchJson<MojangManifest>(MOJANG_MANIFEST);
	manifestCache = { at: Date.now(), data };
	return data;
}

/**
 * The Java major Mojang declares for a Minecraft version (`javaVersion` in the
 * version's metadata), or null if the version or field is unknown.
 */
export async function minecraftJavaMajor(minecraftVersion: string): Promise<number | null> {
	const manifest = await mojangManifest();
	const entry = manifest.versions.find((v) => v.id === minecraftVersion);
	if (!entry) return null;
	const detail = await fetchJson<{ javaVersion?: { majorVersion?: number } }>(entry.url);
	return detail.javaVersion?.majorVersion ?? null;
}

export async function listReleaseVersions(): Promise<string[]> {
	const manifest = await mojangManifest();
	return manifest.versions.filter((v) => v.type === 'release').map((v) => v.id);
}

async function downloadVanillaServer(ctx: InstallContext, filename = 'server.jar'): Promise<string> {
	const manifest = await mojangManifest();
	const entry = manifest.versions.find((v) => v.id === ctx.minecraftVersion);
	if (!entry) throw new Error(`Minecraft ${ctx.minecraftVersion} is not in Mojang's manifest.`);
	const detail = await fetchJson<{ downloads?: { server?: { url: string; sha1: string } } }>(
		entry.url
	);
	const server = detail.downloads?.server;
	if (!server) throw new Error(`Minecraft ${ctx.minecraftVersion} has no server download.`);
	const target = path.join(ctx.dir, filename);
	log(ctx, `Downloading Minecraft ${ctx.minecraftVersion} server jar`);
	await downloadFile(server.url, target, {
		hash: { algo: 'sha1', value: server.sha1 },
		onProgress: (received, total) => {
			if (total) ctx.task?.setProgress((received / total) * 100, 'Downloading server jar');
		}
	});
	return target;
}

const vanilla: Modloader = {
	id: 'vanilla',
	label: 'Vanilla',
	blurb: 'No mod loader. Datapacks only.',
	supportsMods: false,
	listGameVersions: listReleaseVersions,
	listLoaderVersions: async () => [],
	install: async (ctx) => {
		await downloadVanillaServer(ctx);
		return { launchArgs: '-jar server.jar nogui', loaderVersion: null };
	}
};

// ----------------------------------------------------------------- fabric ---

const FABRIC_META = 'https://meta.fabricmc.net/v2';

const fabric: Modloader = {
	id: 'fabric',
	label: 'Fabric',
	blurb: 'Lightweight and fast to update. The usual choice for performance packs.',
	supportsMods: true,
	listGameVersions: async () => {
		const versions = await fetchJson<{ version: string; stable: boolean }[]>(
			`${FABRIC_META}/versions/game`
		);
		return versions.filter((v) => v.stable).map((v) => v.version);
	},
	listLoaderVersions: async (mc) => {
		const loaders = await fetchJson<{ loader: { version: string; stable: boolean } }[]>(
			`${FABRIC_META}/versions/loader/${encodeURIComponent(mc)}`
		);
		return loaders.map((l) => l.loader.version);
	},
	install: async (ctx) => {
		const loaders = await fetchJson<{ loader: { version: string } }[]>(
			`${FABRIC_META}/versions/loader/${encodeURIComponent(ctx.minecraftVersion)}`
		);
		const loaderVersion = ctx.loaderVersion || loaders[0]?.loader.version;
		if (!loaderVersion) throw new Error(`No Fabric loader for Minecraft ${ctx.minecraftVersion}.`);

		const installers = await fetchJson<{ version: string; stable: boolean }[]>(
			`${FABRIC_META}/versions/installer`
		);
		const installerVersion = installers.find((i) => i.stable)?.version ?? installers[0]?.version;

		// Fabric's server-jar endpoint refuses loaders before 0.12 ("0.12 or
		// higher is required for unattended server installs"); those go through
		// the full installer in server mode instead.
		if (versionBefore(loaderVersion, [0, 12])) {
			const installer = path.join(ctx.dir, '.mineshell', 'fabric-installer.jar');
			log(ctx, `Downloading Fabric installer ${installerVersion}`);
			await downloadFile(
				`https://maven.fabricmc.net/net/fabricmc/fabric-installer/${installerVersion}/fabric-installer-${installerVersion}.jar`,
				installer
			);
			log(ctx, `Running the Fabric installer for loader ${loaderVersion}`);
			const res = await run(
				[
					ctx.javaPath,
					'-jar',
					installer,
					'server',
					'-mcversion',
					ctx.minecraftVersion,
					'-loader',
					loaderVersion,
					'-downloadMinecraft',
					'-dir',
					ctx.dir
				],
				{ cwd: ctx.dir, timeoutMs: 15 * 60_000 }
			);
			await fs.rm(installer, { force: true });
			if (res.code !== 0) {
				throw new Error(`Fabric installer failed: ${(res.stderr || res.stdout).trim().slice(-600)}`);
			}
			return { launchArgs: '-jar fabric-server-launch.jar nogui', loaderVersion };
		}

		// Fabric serves a ready-made server launcher jar, so no installer run needed.
		const url = `${FABRIC_META}/versions/loader/${encodeURIComponent(ctx.minecraftVersion)}/${loaderVersion}/${installerVersion}/server/jar`;
		log(ctx, `Downloading Fabric ${loaderVersion} server launcher`);
		await downloadFile(url, path.join(ctx.dir, 'server.jar'));

		// The launcher downloads the vanilla jar itself on first boot, but doing it
		// now means a start failure is an install failure instead of a mystery.
		await downloadVanillaServer(ctx, path.join('.fabric-cache', 'vanilla.jar')).catch(() =>
			log(ctx, 'Could not pre-cache the vanilla jar; Fabric will fetch it on first start.')
		);

		return { launchArgs: '-jar server.jar nogui', loaderVersion };
	}
};

// ------------------------------------------------------------------ quilt ---

const QUILT_META = 'https://meta.quiltmc.org/v3';

const quilt: Modloader = {
	id: 'quilt',
	label: 'Quilt',
	blurb: 'Fabric-compatible fork. Most Fabric mods load unchanged.',
	supportsMods: true,
	listGameVersions: async () => {
		const versions = await fetchJson<{ version: string; stable: boolean }[]>(
			`${QUILT_META}/versions/game`
		);
		return versions.filter((v) => v.stable).map((v) => v.version);
	},
	listLoaderVersions: async (mc) => {
		const loaders = await fetchJson<{ loader: { version: string } }[]>(
			`${QUILT_META}/versions/loader/${encodeURIComponent(mc)}`
		);
		return loaders.map((l) => l.loader.version);
	},
	install: async (ctx) => {
		const loaders = await fetchJson<{ loader: { version: string } }[]>(
			`${QUILT_META}/versions/loader/${encodeURIComponent(ctx.minecraftVersion)}`
		);
		const loaderVersion = ctx.loaderVersion || loaders[0]?.loader.version;
		if (!loaderVersion) throw new Error(`No Quilt loader for Minecraft ${ctx.minecraftVersion}.`);

		// Quilt has no server-jar endpoint; run the installer like Forge does.
		const metadata = await fetchText(
			'https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/maven-metadata.xml'
		);
		const installerVersion = metadata.match(/<release>([^<]+)<\/release>/)?.[1];
		if (!installerVersion) throw new Error('Could not resolve the Quilt installer version.');

		const installerJar = path.join(ctx.dir, '.mineshell', 'quilt-installer.jar');
		log(ctx, `Downloading Quilt installer ${installerVersion}`);
		await downloadFile(
			`https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/${installerVersion}/quilt-installer-${installerVersion}.jar`,
			installerJar
		);

		log(ctx, 'Running the Quilt installer');
		const res = await run(
			[
				ctx.javaPath,
				'-jar',
				installerJar,
				'install',
				'server',
				ctx.minecraftVersion,
				loaderVersion,
				`--install-dir=${ctx.dir}`,
				'--download-server'
			],
			{ cwd: ctx.dir, timeoutMs: 15 * 60_000 }
		);
		if (res.code !== 0) {
			throw new Error(`Quilt installer failed: ${res.stderr.trim() || res.stdout.trim()}`);
		}
		return { launchArgs: '-jar quilt-server-launch.jar nogui', loaderVersion };
	}
};

// -------------------------------------------------------- forge / neoforge ---

/**
 * Since 1.17 both Forge and NeoForge generate an @argfile rather than a runnable
 * jar. This finds whichever launch shape the installer produced.
 */
async function resolveInstalledLoaderLaunch(dir: string): Promise<string> {
	const argFiles = [
		'libraries/net/minecraftforge/forge',
		'libraries/net/neoforged/neoforge'
	];
	for (const base of argFiles) {
		const abs = path.join(dir, base);
		let versions: string[] = [];
		try {
			versions = await fs.readdir(abs);
		} catch {
			continue;
		}
		for (const version of versions) {
			const argFile = path.join(base, version, 'unix_args.txt');
			try {
				await fs.access(path.join(dir, argFile));
				// user_jvm_args.txt is where the installer expects people to put -Xmx.
				// MineShell passes JVM args from the unit instead, so it stays empty.
				const userArgs = path.join(dir, 'user_jvm_args.txt');
				await fs.writeFile(
					userArgs,
					'# MineShell sets JVM arguments in instance settings; this file is left empty.\n',
					{ flag: 'w' }
				);
				return `@user_jvm_args.txt @${argFile} nogui`;
			} catch {
				/* keep looking */
			}
		}
	}

	// Pre-1.17 Forge ships a runnable universal jar.
	const entries = await fs.readdir(dir);
	const jar = entries.find((f) => /^forge-.*\.jar$/.test(f) && !f.includes('installer'));
	if (jar) return `-jar ${jar} nogui`;

	throw new Error(
		'The loader installer finished but produced no recognisable launch target. Check the task log.'
	);
}

async function runInstallerJar(ctx: InstallContext, url: string, name: string): Promise<void> {
	const installer = path.join(ctx.dir, '.mineshell', name);
	log(ctx, `Downloading ${name}`);
	await downloadFile(url, installer);
	log(ctx, 'Running the installer (this pulls a few hundred MB of libraries)');
	ctx.task?.setProgress(null, 'Running the loader installer');
	const res = await run([ctx.javaPath, '-jar', installer, '--installServer'], {
		cwd: ctx.dir,
		timeoutMs: 20 * 60_000
	});
	if (res.code !== 0) {
		throw new Error(`Installer failed: ${(res.stderr || res.stdout).trim().slice(-600)}`);
	}
	await fs.rm(installer, { force: true });
	// The installer writes its log to the working directory (the server
	// folder), not next to itself; the second one is just in case.
	await fs.rm(path.join(ctx.dir, `${name}.log`), { force: true });
	await fs.rm(`${installer}.log`, { force: true });
}

const forge: Modloader = {
	id: 'forge',
	label: 'Forge',
	blurb: 'The long-established loader. Most large kitchen-sink packs are Forge.',
	supportsMods: true,
	listGameVersions: listReleaseVersions,
	listLoaderVersions: async (mc) => {
		const xml = await fetchText(
			'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml'
		);
		return [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
			.map((m) => m[1])
			.filter((v) => v.startsWith(`${mc}-`))
			.map((v) => v.slice(mc.length + 1))
			.reverse();
	},
	install: async (ctx) => {
		let loaderVersion = ctx.loaderVersion;
		if (!loaderVersion) {
			const promos = await fetchJson<{ promos: Record<string, string> }>(
				'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
			);
			loaderVersion =
				promos.promos[`${ctx.minecraftVersion}-recommended`] ??
				promos.promos[`${ctx.minecraftVersion}-latest`];
		}
		if (!loaderVersion) throw new Error(`No Forge build found for Minecraft ${ctx.minecraftVersion}.`);
		const full = `${ctx.minecraftVersion}-${loaderVersion}`;
		await runInstallerJar(
			ctx,
			`https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`,
			`forge-${full}-installer.jar`
		);
		return { launchArgs: await resolveInstalledLoaderLaunch(ctx.dir), loaderVersion };
	}
};

/** NeoForge versions look like 21.1.72 where 21.1 maps to Minecraft 1.21.1. */
function neoforgePrefix(minecraftVersion: string): string {
	const parts = minecraftVersion.split('.');
	const minor = parts[1] ?? '0';
	const patch = parts[2] ?? '0';
	return `${minor}.${patch}.`;
}

const neoforge: Modloader = {
	id: 'neoforge',
	label: 'NeoForge',
	blurb: 'Community fork of Forge, standard for 1.20.2 and newer.',
	supportsMods: true,
	listGameVersions: listReleaseVersions,
	listLoaderVersions: async (mc) => {
		const data = await fetchJson<{ versions: string[] }>(
			'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge'
		);
		const prefix = neoforgePrefix(mc);
		return data.versions.filter((v) => v.startsWith(prefix) && !v.includes('beta')).reverse();
	},
	install: async (ctx) => {
		let loaderVersion = ctx.loaderVersion;
		if (!loaderVersion) {
			const candidates = await neoforge.listLoaderVersions(ctx.minecraftVersion);
			loaderVersion = candidates[0];
		}
		if (!loaderVersion) {
			throw new Error(`No NeoForge build found for Minecraft ${ctx.minecraftVersion}.`);
		}
		await runInstallerJar(
			ctx,
			`https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`,
			`neoforge-${loaderVersion}-installer.jar`
		);
		return { launchArgs: await resolveInstalledLoaderLaunch(ctx.dir), loaderVersion };
	}
};

// -------------------------------------------------------------- cleanroom ---

const CLEANROOM_MAVEN = 'https://repo.cleanroommc.com/releases/com/cleanroommc/cleanroom';

async function cleanroomVersions(): Promise<{ versions: string[]; release: string | null }> {
	const xml = await fetchText(`${CLEANROOM_MAVEN}/maven-metadata.xml`);
	return {
		versions: [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]).reverse(),
		release: xml.match(/<release>([^<]+)<\/release>/)?.[1] ?? null
	};
}

/**
 * The Cleanroom installer is a Forge-installer fork and, like pre-1.17 Forge,
 * leaves a runnable cleanroom-<version>.jar in the server root.
 */
async function resolveCleanroomLaunch(dir: string, version: string): Promise<string> {
	const entries = await fs.readdir(dir);
	const exact = `cleanroom-${version}.jar`;
	const jar = entries.includes(exact)
		? exact
		: entries.find((f) => /^cleanroom-.*\.jar$/.test(f) && !/installer|universal|sources/.test(f));
	if (!jar) {
		throw new Error(
			'The Cleanroom installer finished but produced no cleanroom jar. Check the task log.'
		);
	}
	return `-jar ${jar} nogui`;
}

const cleanroom: Modloader = {
	id: 'cleanroom',
	label: 'Cleanroom',
	blurb: 'Forge 1.12.2 rebuilt for modern Java (25; 21 before 0.5). Loads 1.12.2 Forge mods; add Fugue and Scalar Legacy for most packs.',
	supportsMods: true,
	onlyGameVersions: [CLEANROOM_MINECRAFT],
	catalogLoader: 'forge',
	listGameVersions: async () => [CLEANROOM_MINECRAFT],
	listLoaderVersions: async (mc) =>
		mc === CLEANROOM_MINECRAFT ? (await cleanroomVersions()).versions : [],
	install: async (ctx) => {
		if (ctx.minecraftVersion !== CLEANROOM_MINECRAFT) {
			throw new Error(`Cleanroom only exists for Minecraft ${CLEANROOM_MINECRAFT}.`);
		}
		let loaderVersion = ctx.loaderVersion;
		if (!loaderVersion) {
			const { versions, release } = await cleanroomVersions();
			loaderVersion = release ?? versions[0];
		}
		if (!loaderVersion) throw new Error('Could not resolve the latest Cleanroom version.');
		await runInstallerJar(
			ctx,
			`${CLEANROOM_MAVEN}/${loaderVersion}/cleanroom-${loaderVersion}-installer.jar`,
			`cleanroom-${loaderVersion}-installer.jar`
		);
		return { launchArgs: await resolveCleanroomLaunch(ctx.dir, loaderVersion), loaderVersion };
	}
};

export const LOADERS: Record<ModloaderId, Modloader> = {
	vanilla,
	fabric,
	quilt,
	forge,
	neoforge,
	cleanroom
};

export const LOADER_LIST = Object.values(LOADERS);

export function getLoader(id: string): Modloader {
	const loader = LOADERS[id as ModloaderId];
	if (!loader) throw new Error(`Unknown mod loader "${id}".`);
	return loader;
}

const pickerLists = new Map<string, { at: number; versions: string[] }>();
const PICKER_FRESH_MS = 10 * 60_000;

/**
 * Version lists for pickers (a server's Settings, the new-server form). Each
 * was fetched on every page open - 0.1-0.6 s, Forge's metadata is 200 KB - so
 * the last answer is handed out at once and refreshed behind it once it is
 * 10 min old. A failed fetch is not kept: the next call tries again.
 */
async function pickerList(key: string, fetch: () => Promise<string[]>): Promise<string[]> {
	const hit = pickerLists.get(key);
	if (hit && Date.now() - hit.at < PICKER_FRESH_MS) return hit.versions;
	const fresh = fetch().then((versions) => {
		pickerLists.set(key, { at: Date.now(), versions });
		return versions;
	});
	if (!hit) return fresh;
	// Stale: answer now; one refresh at a time, so the old list counts as fresh meanwhile.
	hit.at = Date.now();
	fresh.catch(() => {});
	return hit.versions;
}

/** Minecraft releases, newest first, for a picker. */
export function pickerReleaseVersions(): Promise<string[]> {
	return pickerList('minecraft', listReleaseVersions);
}

/** A loader's versions for a Minecraft version, newest first, for a picker. */
export function pickerLoaderVersions(loader: string, minecraftVersion: string): Promise<string[]> {
	return pickerList(`${loader}:${minecraftVersion}`, () => getLoader(loader).listLoaderVersions(minecraftVersion));
}

/**
 * Cross-loader compatibility, off by default, per the original design notes.
 * NeoForge can generally load Forge mods; Quilt can load Fabric mods.
 */
export const LOADER_FALLBACKS: Partial<Record<ModloaderId, ModloaderId[]>> = {
	neoforge: ['forge'],
	quilt: ['fabric']
};
