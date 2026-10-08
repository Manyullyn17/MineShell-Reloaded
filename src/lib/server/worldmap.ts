import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cpus } from 'node:os';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { settings, type ServerInstance } from './db/schema';
import { DATA_DIR } from './config';
import { fetchJson, downloadFile } from './download';
import { listDimensions } from './dimensions';
import { directorySize } from './files';
import { compareVersions, listJavaRuntimes, scanJavaRuntimes } from './java';
import { installJava, type JavaVendor } from './javadownload';
import { audit, InstanceError, JavaMissingError, sendCommand, summarise } from './instances';
import { bestVersion, getModProvider, hasEnabledMod, installModVersion, modsDir, syncMods } from './mods';
import { compatibleVersions, filterFor } from './modupdates';
import { allocatePort } from './ports';
import { nextSnapshotAt } from './snapshotschedule';
import { startTask, type TaskHandle } from './tasks';

/**
 * A map of the world in the browser (ROADMAP, "A map of the world").
 *
 * Minecraft 1.13 and newer: BlueMap's standalone CLI, run by MineShell - no
 * mod on the server. It reads the world's region files and the server's mod
 * jars (for modded blocks' models and textures) and writes a static web map
 * (three.js) that MineShell serves under the server's Map tab, behind its
 * login (`resolveMapFile`). Its own web server is never run.
 *
 * Per server, everything lives in `$DATA/maps/<id>/`: config/ (written here
 * on every render), data/ (BlueMap's caches and the Minecraft client jar it
 * downloads), web/ (the map). The client jar is Mojang's: BlueMap only
 * downloads it with `accept-download`, which is set once the person has
 * accepted Mojang's EULA on the Map tab (per server, the user's call).
 */

export const MAPS_DIR = path.join(DATA_DIR, 'maps');
const TOOLS_DIR = path.join(DATA_DIR, 'tools', 'bluemap');
/** Current BlueMap releases need Java 21. */
const BLUEMAP_JAVA = 21;
const RELEASES = 'https://api.github.com/repos/BlueMap-Minecraft/BlueMap/releases/latest';

export const mapDir = (instanceId: string) => path.join(MAPS_DIR, instanceId);
const webRoot = (instanceId: string) => path.join(mapDir(instanceId), 'web');

// ----------------------------------------------------------------- settings ---

export type MapSchedule = {
	every: 'off' | 'interval' | 'daily';
	/** For 'daily', "HH:MM" local time. */
	dailyTime: string;
	/** For 'interval'. */
	intervalHours: number;
};

export type MapSettings = {
	/** Mojang's EULA accepted for this server's map (BlueMap downloads the client jar). */
	eulaAccepted: boolean;
	lastRenderAt: number | null;
	schedule: MapSchedule;
	/** When the schedule updates the map next; null when it is off. */
	nextAt: number | null;
	/** The port given to a map mod's web server (Dynmap, the BlueMap mod); MineShell passes it through. */
	modPort: number | null;
};

const OFF: MapSchedule = { every: 'off', dailyTime: '05:00', intervalHours: 6 };

/** Anything stored or sent, made into a schedule: unknown or out-of-range values fall back. */
export function validMapSchedule(raw: Record<string, unknown> | undefined): MapSchedule {
	const hours = Number(raw?.intervalHours);
	return {
		every: raw?.every === 'interval' || raw?.every === 'daily' ? raw.every : 'off',
		dailyTime: typeof raw?.dailyTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.dailyTime) ? raw.dailyTime : OFF.dailyTime,
		intervalHours: Number.isInteger(hours) && hours >= 1 && hours <= 24 * 7 ? hours : OFF.intervalHours
	};
}

const KEY = (id: string) => `map:${id}`;
const DEFAULTS: MapSettings = { eulaAccepted: false, lastRenderAt: null, schedule: OFF, nextAt: null, modPort: null };

export function getMapSettings(instanceId: string): MapSettings {
	const raw = db.select().from(settings).where(eq(settings.key, KEY(instanceId))).get()?.value;
	try {
		const parsed = raw ? (JSON.parse(raw) as Partial<MapSettings>) : {};
		return {
			eulaAccepted: parsed.eulaAccepted === true,
			lastRenderAt: typeof parsed.lastRenderAt === 'number' ? parsed.lastRenderAt : null,
			schedule: validMapSchedule(parsed.schedule as Record<string, unknown> | undefined),
			nextAt: typeof parsed.nextAt === 'number' ? parsed.nextAt : null,
			modPort: Number.isInteger(parsed.modPort) ? (parsed.modPort as number) : null
		};
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveMapSettings(instanceId: string, changes: Partial<MapSettings>): MapSettings {
	const next = { ...getMapSettings(instanceId), ...changes };
	const value = JSON.stringify(next);
	db.insert(settings).values({ key: KEY(instanceId), value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
	return next;
}

/** With the server: its settings and everything rendered. */
export async function deleteMapData(instanceId: string, opts: { keepSettings?: boolean } = {}): Promise<void> {
	if (rendering.has(instanceId)) throw new InstanceError('The map is being updated; wait for it to finish or cancel it.');
	await fs.rm(mapDir(instanceId), { recursive: true, force: true });
	if (!opts.keepSettings) db.delete(settings).where(eq(settings.key, KEY(instanceId))).run();
	else saveMapSettings(instanceId, { lastRenderAt: null });
}

/** Sets the schedule; its first update is the next slot from now. */
export function saveMapSchedule(instanceId: string, schedule: MapSchedule): MapSettings {
	return saveMapSettings(instanceId, { schedule, nextAt: nextSnapshotAt(schedule) });
}

/**
 * From the scheduler's tick: updates the map when its slot has come. A slot
 * that passed while MineShell was down moves to the next one (rollForwardMaps)
 * rather than firing at once; a map already updating, a server without the
 * EULA answer or a world that is not there yet skips the slot.
 */
export async function evaluateMapSchedule(instance: ServerInstance, now = Date.now()): Promise<string | null> {
	const current = getMapSettings(instance.id);
	if (current.schedule.every === 'off' || !current.eulaAccepted || mapSupport(instance).engine !== 'bluemap') return null;
	if (current.nextAt === null) {
		saveMapSettings(instance.id, { nextAt: nextSnapshotAt(current.schedule, now) });
		return null;
	}
	if (current.nextAt > now) return null;
	saveMapSettings(instance.id, { nextAt: nextSnapshotAt(current.schedule, now) });
	if (rendering.has(instance.id)) return null;
	try {
		return await renderMap(instance);
	} catch (err) {
		audit('scheduler.map_skipped', { instanceId: instance.id, detail: err instanceof Error ? err.message : 'failed', actor: 'scheduler' });
		return null;
	}
}

/** At MineShell's start: slots that passed while it was down move to the next one. */
export function rollForwardMaps(now = Date.now()): void {
	for (const row of db.select().from(settings).all()) {
		if (!row.key.startsWith('map:')) continue;
		const id = row.key.slice('map:'.length);
		const current = getMapSettings(id);
		if (current.schedule.every !== 'off' && (current.nextAt === null || current.nextAt < now)) {
			saveMapSettings(id, { nextAt: nextSnapshotAt(current.schedule, now) });
		}
	}
}

// ------------------------------------------------------------------ support ---

export type MapSupport =
	/** BlueMap's CLI renders it; the BlueMap mod can be added for a live map. */
	| { engine: 'bluemap' }
	/** Only a mod can draw it: Dynmap, with DynmapBlockScan for modded blocks (1.12.2 Forge/Cleanroom). */
	| { engine: 'dynmap' }
	| { engine: null; reason: string };

/**
 * Which way this server can have a map. BlueMap reads 1.13 and newer worlds;
 * 1.12.2 needs Dynmap inside the game (big packs raise the block id limit
 * with RoughlyEnoughIDs/JEID, which no standalone renderer reads).
 */
export function mapSupport(instance: Pick<ServerInstance, 'minecraftVersion' | 'modloader'>): MapSupport {
	if (compareVersions(instance.minecraftVersion, '1.13') >= 0) return { engine: 'bluemap' };
	if (DYNMAP[instance.minecraftVersion] && (instance.modloader === 'forge' || instance.modloader === 'cleanroom')) return { engine: 'dynmap' };
	return { engine: null, reason: `There is no map for Minecraft ${instance.minecraftVersion} yet: BlueMap reads 1.13 and newer worlds, Dynmap is set up here for Forge 1.12.2.` };
}

export type MapStatus = {
	support: MapSupport;
	settings: MapSettings;
	/** Map mods on the server (enabled jars). */
	mods: MapMods;
	/** The server runs, so a mod's map can be shown. */
	running: boolean;
	/** A map has been rendered and can be shown. */
	ready: boolean;
	sizeBytes: number;
	/** The task updating it now, if any. */
	taskId: string | null;
};

export async function mapStatus(instance: ServerInstance): Promise<MapStatus> {
	const ready = await fs
		.access(path.join(webRoot(instance.id), 'index.html'))
		.then(() => true)
		.catch(() => false);
	return {
		support: mapSupport(instance),
		settings: getMapSettings(instance.id),
		mods: await mapMods(instance),
		running: (await summarise(instance)).running,
		ready,
		sizeBytes: ready ? await directorySize(mapDir(instance.id)).catch(() => 0) : 0,
		taskId: rendering.get(instance.id) ?? null
	};
}

// ------------------------------------------------------------- the tool ---

type Release = { tag_name: string; assets: { name: string; browser_download_url: string; digest?: string | null }[] };

/** BlueMap's CLI jar, downloaded once (the newest release) and kept in $DATA/tools/bluemap. */
async function blueMapJar(task: Pick<TaskHandle, 'log' | 'setProgress'>): Promise<string> {
	const have = (await fs.readdir(TOOLS_DIR).catch(() => [] as string[])).filter((n) => /^bluemap-.+-cli\.jar$/.test(n)).sort(compareJarNames);
	try {
		const release = await fetchJson<Release>(RELEASES);
		const asset = release.assets.find((a) => /^bluemap-.+-cli\.jar$/.test(a.name));
		if (!asset) throw new Error('the release has no CLI jar');
		if (have.includes(asset.name)) return path.join(TOOLS_DIR, asset.name);
		task.setProgress(null, `Downloading BlueMap ${release.tag_name}`);
		const target = path.join(TOOLS_DIR, asset.name);
		const sha256 = asset.digest?.startsWith('sha256:') ? asset.digest.slice('sha256:'.length) : null;
		await downloadFile(asset.browser_download_url, target, { hash: sha256 ? { algo: 'sha256', value: sha256 } : null });
		task.log(`Downloaded BlueMap ${release.tag_name}.`);
		// One version is enough: older ones go.
		for (const old of have) await fs.rm(path.join(TOOLS_DIR, old), { force: true });
		return target;
	} catch (err) {
		// Offline (or GitHub refusing): the jar there is, if any.
		const newest = have.at(-1);
		if (newest) {
			task.log(`Could not check for a newer BlueMap (${err instanceof Error ? err.message : 'lookup failed'}); using ${newest}.`);
			return path.join(TOOLS_DIR, newest);
		}
		throw new InstanceError(`Could not download BlueMap: ${err instanceof Error ? err.message : 'lookup failed'}.`);
	}
}

const compareJarNames = (a: string, b: string) => compareVersions(a.replace(/^bluemap-|-cli\.jar$/g, ''), b.replace(/^bluemap-|-cli\.jar$/g, ''));

/** The newest installed Java that BlueMap runs on (21 or newer). */
async function blueMapJava(download?: JavaVendor, task?: Pick<TaskHandle, 'log' | 'setProgress'>): Promise<string> {
	const pick = () =>
		listJavaRuntimes()
			.filter((j) => j.majorVersion >= BLUEMAP_JAVA)
			.sort((a, b) => b.majorVersion - a.majorVersion)[0]?.path;
	let java = pick();
	if (!java) {
		await scanJavaRuntimes();
		java = pick();
	}
	if (java) return java;
	if (download && task) {
		await installJava(download, BLUEMAP_JAVA, task);
		java = pick();
		if (java) return java;
	}
	throw new JavaMissingError(BLUEMAP_JAVA, `BlueMap needs Java ${BLUEMAP_JAVA} or newer, and none is installed.`);
}

// ------------------------------------------------------------------ config ---

const hocon = (value: string) => JSON.stringify(value);

/** Map ids BlueMap uses in URLs: from the dimension id, file-name safe. */
const mapId = (dimension: string) => (dimension.startsWith('minecraft:') ? dimension.slice('minecraft:'.length).replace(/^the_/, '') : dimension.replace(/[^a-z0-9_-]+/gi, '_'));

/**
 * BlueMap's config for this server, written fresh before every render (the
 * world folder, its dimensions or the EULA answer may have changed). One map
 * per dimension BlueMap can name: vanilla ones and namespaced modded ones
 * (`dimensions/<ns>/<name>`, 1.16+); old-style DIM folders without an id are
 * left out.
 */
export async function writeBlueMapConfig(instance: ServerInstance): Promise<string[]> {
	const dir = mapDir(instance.id);
	const config = path.join(dir, 'config');
	await fs.rm(path.join(config, 'maps'), { recursive: true, force: true });
	await fs.mkdir(path.join(config, 'maps'), { recursive: true });
	await fs.mkdir(path.join(config, 'storages'), { recursive: true });
	await fs.mkdir(path.join(config, 'packs'), { recursive: true });
	const { eulaAccepted } = getMapSettings(instance.id);
	const threads = Math.max(1, Math.min(4, Math.floor(cpus().length / 2)));
	await fs.writeFile(
		path.join(config, 'core.conf'),
		[
			`accept-download: ${eulaAccepted}`,
			`data: ${hocon(path.join(dir, 'data'))}`,
			`render-thread-count: ${threads}`,
			'scan-for-mod-resources: true',
			'metrics: false',
			`log: { file: ${hocon(path.join(dir, 'data', 'logs', 'debug.log'))}, append: false }`,
			''
		].join('\n')
	);
	await fs.writeFile(
		path.join(config, 'webapp.conf'),
		[
			'enabled: true',
			`webroot: ${hocon(webRoot(instance.id))}`,
			'update-settings-file: true',
			'use-cookies: true',
			'scripts: []',
			'styles: []',
			''
		].join('\n')
	);
	// MineShell serves the map; BlueMap's own web server stays off.
	await fs.writeFile(path.join(config, 'webserver.conf'), 'enabled: false\n');
	await fs.writeFile(
		path.join(config, 'storages', 'file.conf'),
		['storage-type: file', `root: ${hocon(path.join(webRoot(instance.id), 'maps'))}`, 'compression: gzip', ''].join('\n')
	);

	const ids: string[] = [];
	const dimensions = (await listDimensions(instance.path)).filter((d) => d.id.includes(':'));
	for (const [i, d] of dimensions.entries()) {
		const id = mapId(d.id);
		if (ids.includes(id)) continue;
		ids.push(id);
		// The world folder is the path's first part: `world` for world/DIM-1 or
		// world/dimensions/ns/name, `world_nether` for Bukkit's sibling worlds.
		const world = d.paths[0].split(path.sep)[0];
		const nether = d.id === 'minecraft:the_nether';
		await fs.writeFile(
			path.join(config, 'maps', `${id}.conf`),
			[
				`world: ${hocon(path.join(instance.path, world))}`,
				`dimension: ${hocon(d.id)}`,
				`name: ${hocon(d.label)}`,
				`sorting: ${i}`,
				`sky-color: ${hocon(nether ? '#290000' : d.id === 'minecraft:the_end' ? '#080010' : '#7dabff')}`,
				`sky-light: ${nether || d.id === 'minecraft:the_end' ? 0 : 1}`,
				...(nether ? ['remove-caves-below-y: -10000', 'render-mask: [{ max-y: 90 }]'] : []),
				'storage: "file"',
				''
			].join('\n')
		);
	}
	return ids;
}

// ------------------------------------------------------------------ render ---

/** Renders running, by server: one at a time each. */
const rendering = new Map<string, string>();

/**
 * Updates the map in the background: BlueMap renders what changed since the
 * last run (`force`: everything). A running server is told to save first, so
 * the map shows the world as it is.
 */
export async function renderMap(instance: ServerInstance, opts: { force?: boolean; downloadJava?: JavaVendor } = {}): Promise<string> {
	const support = mapSupport(instance);
	if (support.engine === null) throw new InstanceError(support.reason);
	if (support.engine === 'dynmap') throw new InstanceError('This server’s map is drawn by Dynmap while it runs; there is nothing to render.');
	if (!getMapSettings(instance.id).eulaAccepted) {
		throw new InstanceError('Accept Mojang’s EULA for the map first: BlueMap needs the Minecraft client for textures.');
	}
	if (rendering.has(instance.id)) throw new InstanceError('The map is already being updated.');
	// Settled before the task starts, so a missing Java is a question on the page.
	if (!opts.downloadJava) await blueMapJava();

	const taskId = startTask({ label: `Update the map of ${instance.name}`, instanceId: instance.id }, async (task) => {
		try {
			const java = await blueMapJava(opts.downloadJava, task);
			const jar = await blueMapJar(task);
			const maps = await writeBlueMapConfig(instance);
			if (!maps.length) throw new InstanceError('The world has no region files yet; start the server once so it generates.');
			if ((await summarise(instance)).running) {
				task.setProgress(null, 'Saving the world');
				await sendCommand(instance, 'save-all').catch((err) => task.log(`Could not ask the server to save (${err instanceof Error ? err.message : 'RCON failed'}); the map shows what is on disk.`));
			}
			const mods = modsDir(instance.path);
			const hasMods = (await fs.readdir(mods).catch(() => [] as string[])).some((n) => n.endsWith('.jar'));
			const args = ['-jar', jar, '-c', path.join(mapDir(instance.id), 'config'), '-r', '-v', instance.minecraftVersion];
			if (hasMods) args.push('-n', mods);
			if (opts.force) args.push('-f');
			task.setProgress(null, `Rendering ${maps.length} map${maps.length === 1 ? '' : 's'}`);
			await runBlueMap(java, args, mapDir(instance.id), task);
			saveMapSettings(instance.id, { lastRenderAt: Date.now() });
			task.setProgress(100, 'Map updated');
		} finally {
			rendering.delete(instance.id);
		}
	});
	rendering.set(instance.id, taskId);
	return taskId;
}

/** Runs the CLI, its lines into the task log and any percentage into its progress; cancelling stops it. */
function runBlueMap(java: string, args: string[], cwd: string, task: TaskHandle): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(java, args, { cwd, env: process.env });
		const tail: string[] = [];
		const line = (text: string) => {
			const clean = text.replace(/\x1b\[[0-9;]*m/g, '').trim();
			if (!clean || /Loading resource/i.test(clean)) return;
			tail.push(clean);
			if (tail.length > 20) tail.shift();
			const percent = clean.match(/(\d{1,3}(?:\.\d+)?)\s?%/);
			if (percent) task.setProgress(Math.min(99, Number(percent[1])), clean.replace(/^\[[^\]]*\]\s*/, '').slice(0, 120));
			else task.log(clean.replace(/^\[[^\]]*\]\s*/, ''));
		};
		let buffered = '';
		const feed = (chunk: Buffer) => {
			buffered += chunk.toString();
			const parts = buffered.split(/\r?\n|\r/);
			buffered = parts.pop() ?? '';
			parts.forEach(line);
		};
		child.stdout.on('data', feed);
		child.stderr.on('data', feed);
		const watch = setInterval(() => {
			if (task.isCancelled()) child.kill('SIGTERM');
		}, 1000);
		child.on('error', (err) => {
			clearInterval(watch);
			reject(new Error(`Could not run BlueMap: ${err.message}`));
		});
		child.on('close', (code) => {
			clearInterval(watch);
			if (buffered) line(buffered);
			if (task.isCancelled()) return resolve();
			if (code === 0) resolve();
			else reject(new Error(`BlueMap stopped with exit code ${code}: ${tail.slice(-3).join(' / ')}`));
		});
	});
}

// ----------------------------------------------------------------- serving ---

export type MapFile = { file: string; type: string; gzip: boolean } | { empty: true } | null;

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.ttf': 'font/ttf',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.conf': 'text/plain; charset=utf-8',
	'.webmanifest': 'application/manifest+json',
	'.prbm': 'application/octet-stream'
};

/**
 * What a request under the map maps to, as BlueMap's own web server answers
 * it: the file; else its `.gz` sent with Content-Encoding gzip (tiles and
 * textures are stored compressed); else, for a tile or live data, nothing
 * (204: not rendered there, or the live updates only BlueMap's server has).
 * Null is a 404. Nothing outside the server's map folder is reachable.
 */
export async function resolveMapFile(instanceId: string, rel: string): Promise<MapFile> {
	const root = webRoot(instanceId);
	const clean = path.posix.normalize(`/${rel || 'index.html'}`);
	const file = path.join(root, clean.endsWith('/') ? `${clean}index.html` : clean);
	if (file !== root && !file.startsWith(root + path.sep)) return null;
	const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
	const isFile = (p: string) =>
		fs.stat(p).then(
			(s) => s.isFile(),
			() => false
		);
	if (await isFile(file)) return { file, type, gzip: false };
	if (await isFile(`${file}.gz`)) return { file: `${file}.gz`, type, gzip: true };
	if (/\/(tiles|live)\//.test(clean)) return { empty: true };
	return null;
}

// ---------------------------------------------------------------- mod maps ---

/** Dynmap's CurseForge project, and DynmapBlockScan's build per Minecraft version (dynmap.us only). */
const DYNMAP_PROJECT = '59433';
const DYNMAP: Record<string, { blockScan: string }> = {
	'1.12.2': { blockScan: 'https://dynmap.us/builds/DynmapBlockScan/DynmapBlockScan-3.4-beta-1-forge-1.12.2.jar' }
};
const BLUEMAP_PROJECT = 'bluemap';
/** Where map mods' web servers get their ports from; the same range Dynmap uses by default. */
const MOD_PORT_START = 8123;

export type MapMods = { dynmap: boolean; blockScan: boolean; blueMap: boolean };

export async function mapMods(instance: ServerInstance): Promise<MapMods> {
	const [dynmap, blockScan, blueMap] = await Promise.all(
		['dynmap', 'dynmapblockscan', 'bluemap'].map((id) => hasEnabledMod(instance.path, id).catch(() => false))
	);
	return { dynmap, blockScan, blueMap };
}

/** The server's map-mod port, given once: not another server's, nor any port in use now. */
async function modPort(instance: ServerInstance): Promise<number> {
	const current = getMapSettings(instance.id).modPort;
	if (current) return current;
	const taken = new Set(
		db
			.select()
			.from(settings)
			.all()
			.filter((r) => r.key.startsWith('map:') && r.key !== KEY(instance.id))
			.map((r) => getMapSettings(r.key.slice('map:'.length)).modPort)
	);
	let port = await allocatePort(MOD_PORT_START, instance.id);
	while (taken.has(port)) port = await allocatePort(port + 1, instance.id);
	saveMapSettings(instance.id, { modPort: port });
	return port;
}

/** Sets `key: value` in a YAML/HOCON-ish config, over the line or its commented-out form, else appended. */
export function setConfigLine(text: string, key: string, value: string): string {
	const line = new RegExp(`^[ \\t]*#?[ \\t]*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*:.*$`, 'm');
	return line.test(text) ? text.replace(line, `${key}: ${value}`) : `${text.replace(/\n?$/, '\n')}${key}: ${value}\n`;
}

/**
 * Points the map mods' web servers at the server's own port, on localhost
 * only (MineShell passes them through, behind its login), and gives the
 * BlueMap mod the EULA answer. Their config files exist only once the mod
 * has started once, so this runs before every start and after an install;
 * a first start uses the mod's default port. Returns what it changed.
 */
export async function applyMapModConfig(instance: ServerInstance): Promise<string[]> {
	const mods = await mapMods(instance);
	if (!mods.dynmap && !mods.blueMap) return [];
	const port = await modPort(instance);
	const changed: string[] = [];
	const edit = async (rel: string, apply: (text: string) => string) => {
		const file = path.join(instance.path, rel);
		const text = await fs.readFile(file, 'utf8').catch(() => null);
		if (text === null) return;
		const next = apply(text);
		if (next !== text) {
			await fs.writeFile(file, next);
			changed.push(rel);
		}
	};
	if (mods.dynmap) {
		await edit('dynmap/configuration.txt', (t) => setConfigLine(setConfigLine(t, 'webserver-port', String(port)), 'webserver-bindaddress', '127.0.0.1'));
	}
	if (mods.blueMap) {
		await edit('config/bluemap/webserver.conf', (t) => setConfigLine(setConfigLine(t, 'port', String(port)), 'ip', '"127.0.0.1"'));
		await edit('config/bluemap/core.conf', (t) => setConfigLine(t, 'accept-download', String(getMapSettings(instance.id).eulaAccepted)));
	}
	return changed;
}

/**
 * Installs the map mod this server's version takes, as a task: Dynmap and
 * DynmapBlockScan on 1.12.2 (Dynmap alone draws modded blocks black), the
 * BlueMap mod on 1.13+ (live updates and player markers). Mods load on the
 * next start.
 */
export async function installMapMod(instance: ServerInstance): Promise<string> {
	const support = mapSupport(instance);
	if (support.engine === null) throw new InstanceError(support.reason);
	const mods = await mapMods(instance);
	if (support.engine === 'dynmap' && mods.dynmap && mods.blockScan) throw new InstanceError('Dynmap and DynmapBlockScan are installed already.');
	if (support.engine === 'bluemap' && mods.blueMap) throw new InstanceError('The BlueMap mod is installed already.');
	return startTask({ label: `Install the map mod on ${instance.name}`, instanceId: instance.id }, async (task) => {
		if (support.engine === 'dynmap') {
			if (!mods.dynmap) {
				task.setProgress(null, 'Installing Dynmap');
				const versions = await getModProvider('curseforge').listVersions(DYNMAP_PROJECT, { minecraftVersion: instance.minecraftVersion, loader: 'forge' });
				// Its 1.12.2 builds after 3.6 are betas: the newest of any channel.
				const newest = [...versions].sort((a, b) => Date.parse(b.datePublished ?? '') - Date.parse(a.datePublished ?? ''))[0];
				if (!newest) throw new InstanceError(`No Dynmap build for Forge ${instance.minecraftVersion}.`);
				await installModVersion(instance, 'curseforge', { id: DYNMAP_PROJECT, slug: DYNMAP_PROJECT, name: 'Dynmap', projectUrl: null, iconUrl: null }, newest);
				task.log(`Installed Dynmap ${newest.versionNumber}.`);
			}
			if (!mods.blockScan) {
				task.setProgress(null, 'Installing DynmapBlockScan');
				const url = DYNMAP[instance.minecraftVersion].blockScan;
				await downloadFile(url, path.join(modsDir(instance.path), path.posix.basename(url)));
				task.log(`Installed ${path.posix.basename(url)} (from dynmap.us; it reads the mods' block models so Dynmap can draw modded blocks).`);
			}
		} else {
			task.setProgress(null, 'Installing the BlueMap mod');
			const best = bestVersion(await compatibleVersions('modrinth', BLUEMAP_PROJECT, filterFor(instance)));
			if (!best) throw new InstanceError(`No BlueMap mod for ${instance.modloader} ${instance.minecraftVersion}.`);
			await installModVersion(instance, 'modrinth', { id: BLUEMAP_PROJECT, slug: BLUEMAP_PROJECT, name: 'BlueMap', projectUrl: null, iconUrl: null }, best);
			task.log(`Installed BlueMap ${best.versionNumber}.`);
		}
		await syncMods(instance).catch(() => undefined);
		await applyMapModConfig(instance);
		task.setProgress(100, 'Installed; the map starts with the server');
	});
}

/** Where a request under the live map goes: the mod's web server, on localhost. Null without one. */
export async function liveMapTarget(instance: ServerInstance, rel: string, search: string): Promise<string | null> {
	const port = getMapSettings(instance.id).modPort;
	const mods = await mapMods(instance);
	if (!port || (!mods.dynmap && !mods.blueMap)) return null;
	const clean = path.posix.normalize(`/${rel}`);
	if (clean.startsWith('/..')) return null;
	return `http://127.0.0.1:${port}${clean}${search}`;
}

