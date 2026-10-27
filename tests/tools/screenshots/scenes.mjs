/**
 * The placeholder world the screenshots show (README.md here). Each scene puts
 * one thing into a fresh throwaway data dir; they run in order, all of them,
 * so every shot sees the same world. Add a scene for new data, change one to
 * change what the pictures show. Never real data: names are invented, players
 * are offline-mode UUIDs (MineShell never looks those up).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import yazl from 'yazl';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Offline-mode UUID: version 3 of "OfflinePlayer:<name>", as the game makes it. */
/** @param {string} name */
export function offlineUuid(name) {
	const h = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
	h[6] = (h[6] & 0x0f) | 0x30;
	h[8] = (h[8] & 0x3f) | 0x80;
	const x = h.toString('hex');
	return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/**
 * A small random generator with a seed, so every run draws the same graphs.
 * @param {number} seed
 */
function seeded(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/** A real crash (tests/crashdiag): Simple Datapacks needs Mod Menu, which servers leave out as client-only. */
const CRASH_LOG = fileURLToPath(new URL('../../crashdiag/fixtures/real-vanillaperfected-simpledatapacks.log', import.meta.url));

/**
 * A Fabric mod jar holding only what the crash diagnosis reads: fabric.mod.json and the class files' names.
 * @param {string} id @param {string} name @param {boolean} clientOnly @param {string[]} classes
 * @returns {Promise<Buffer>}
 */
function modJar(id, name, clientOnly, classes) {
	const zip = new yazl.ZipFile();
	zip.addBuffer(Buffer.from(JSON.stringify({ schemaVersion: 1, id, name, version: '1.0.0', environment: clientOnly ? 'client' : '*' })), 'fabric.mod.json');
	for (const c of classes) zip.addBuffer(Buffer.alloc(0), `${c.replace(/\./g, '/')}.class`);
	zip.end();
	/** @type {Buffer[]} */
	const parts = [];
	return new Promise((resolve, reject) => {
		zip.outputStream.on('data', (b) => parts.push(b));
		zip.outputStream.on('end', () => resolve(Buffer.concat(parts)));
		zip.outputStream.on('error', reject);
	});
}

const PLAYERS = ['Bramblewick', 'mossy_fox', 'TinCanTom', 'Quillfeather', 'lantern_jay', 'Oakhollow', 'Ferrogrim'];

const MIRROR = 'https://api.modpacks.ch/public';
const MEATBALLCRAFT = 411966;

/**
 * MeatballCraft's newest version on CurseForge (through the modpacks.ch mirror, as
 * MineShell reads it), with its file list.
 * @param {import('./run.mjs').Context} ctx
 * @returns {Promise<{ id: number; name: string; files: { name: string; path: string; size: number; sha1: string; curseforge?: { project: string; file: string } }[] }>}
 */
async function meatballcraft(ctx) {
	const pack = await ctx.fetchJson(`${MIRROR}/curseforge/${MEATBALLCRAFT}`);
	const newest = pack.versions.slice().sort((/** @type {{ updated: number }} */ a, /** @type {{ updated: number }} */ b) => b.updated - a.updated)[0];
	return ctx.fetchJson(`${MIRROR}/curseforge/${MEATBALLCRAFT}/${newest.id}`);
}

const COBBLEMON = '5FFgwNNP';

/**
 * The Cobblemon pack's Fabric 1.21.1 versions: the one the server has (three
 * releases back) and the newest, which the pack change preview moves it to.
 * @param {import('./run.mjs').Context} ctx
 * @returns {Promise<{ installed: any; newest: any }>}
 */
async function cobblemonVersions(ctx) {
	const versions = await ctx.fetchJson(
		`https://api.modrinth.com/v2/project/${COBBLEMON}/version?loaders=${encodeURIComponent('["fabric"]')}&game_versions=${encodeURIComponent('["1.21.1"]')}`
	);
	return { installed: versions[Math.min(3, versions.length - 1)], newest: versions[0] };
}

/** Downloads kept between runs (pack files, the jars a preview hashes), so a run fetches each once. */
const CACHE = path.join(os.homedir(), '.cache/mineshell-screenshots');

/**
 * A file's bytes, from the cache or downloaded into it.
 * @param {string} url @param {string} name  cache file name, unique per content
 * @returns {Promise<Buffer>}
 */
async function cachedDownload(url, name) {
	const file = path.join(CACHE, name);
	if (fs.existsSync(file)) return fs.readFileSync(file);
	for (let attempt = 1; ; attempt++) {
		try {
			const res = await fetch(url, { headers: { 'User-Agent': 'MineShell screenshots (tests/tools/screenshots)' } });
			if (!res.ok) throw new Error(`${url}: ${res.status}`);
			const data = Buffer.from(await res.arrayBuffer());
			fs.mkdirSync(CACHE, { recursive: true });
			fs.writeFileSync(file, data);
			return data;
		} catch (err) {
			if (attempt >= 3) throw err;
		}
	}
}

/**
 * A .mrpack's modrinth.index.json.
 * @param {Buffer} mrpack
 * @returns {Promise<{ files: { path: string; hashes: { sha1: string; sha512: string }; fileSize: number; downloads: string[]; env?: { server?: string } }[] }>}
 */
function mrpackIndex(mrpack) {
	return new Promise((resolve, reject) =>
		yauzl.fromBuffer(mrpack, { lazyEntries: true }, (err, zip) => {
			if (err || !zip) return reject(err);
			zip.on('entry', (entry) => {
				if (entry.fileName !== 'modrinth.index.json') return zip.readEntry();
				zip.openReadStream(entry, (e, stream) => {
					if (e || !stream) return reject(e);
					/** @type {Buffer[]} */
					const parts = [];
					stream.on('data', (b) => parts.push(b));
					stream.on('end', () => resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))));
				});
			});
			zip.on('end', () => reject(new Error('no modrinth.index.json in the pack')));
			zip.readEntry();
		})
	);
}

/**
 * A pack version's index, its .mrpack cached.
 * @param {any} version  a Modrinth version
 */
async function packIndex(version) {
	const file = version.files.find((/** @type {{ primary: boolean }} */ f) => f.primary) ?? version.files[0];
	return mrpackIndex(await cachedDownload(file.url, `${version.id}-${file.filename}`));
}

/** @type {{ name: string; run: (ctx: import('./run.mjs').Context) => Promise<void> | void }[]} */
export const scenes = [
	{
		name: 'servers',
		async run(ctx) {
			// Up since the nightly restart at 05:00 (the day before, early in the morning).
			const sinceFive = Math.floor((ctx.now - new Date(ctx.now).setHours(5, 0, 0, 0)) / 60_000);
			// The Cobblemon pack a few versions back, so the newest is an update to preview (the mods scene installs its files).
			const { installed: packVersion } = await cobblemonVersions(ctx);
			const meatball = await meatballcraft(ctx);
			const online = PLAYERS.slice(0, 3);
			ctx.server({
				id: 'survival',
				name: 'Survival',
				minecraft: '26.3',
				loader: 'vanilla',
				memoryMb: 6144,
				worldMb: 3400,
				pinned: true,
				notes: 'The main world. Restarts every night at 5.',
				running: {
					players: online,
					mspt: 11.6,
					memoryMb: 2700,
					cpuPercent: 30,
					uptimeMinutes: sinceFive >= 120 ? sinceFive : sinceFive + 24 * 60,
					// [player, text, seconds after the line before]; '*' is a server line.
					chat: [
						['Bramblewick', 'anyone up for the end tonight?'],
						['mossy_fox', 'after I finish the farm', 7],
						['*', 'TinCanTom has made the advancement [Diamonds!]', 160],
						['TinCanTom', 'finally', 4],
						['Bramblewick', 'gg', 3]
					]
				},
				properties: { motd: 'Survival - be nice', 'max-players': '20', difficulty: 'hard' }
			});
			ctx.server({
				id: 'cobblemon',
				name: 'Cobblemon',
				minecraft: '1.21.1',
				loader: 'fabric',
				loaderVersion: '0.16.10',
				memoryMb: 8192,
				pack: { source: 'modrinth', project: '5FFgwNNP', version: packVersion.id, versionName: packVersion.version_number, name: 'Cobblemon Official Modpack [Fabric]' },
				// Stopped three hours ago (its history ends there): two servers running are enough, and each fake holds its memory.
				worldMb: 1900
			});
			// Crashed at its last start (the crash scene gives it the mods): a real crash's log, printed by the fake.
			ctx.server({
				id: 'creative',
				name: 'Creative build',
				minecraft: '1.21.11',
				loader: 'fabric',
				loaderVersion: '0.18.4',
				memoryMb: 4096,
				worldMb: 600,
				properties: { gamemode: 'creative' },
				running: { players: [], crashLog: CRASH_LOG }
			});
			// Old Minecraft, a big pack and Cleanroom in one: 1.12.2, hundreds of mods.
			ctx.server({
				id: 'meatballcraft',
				name: 'MeatballCraft',
				minecraft: '1.12.2',
				loader: 'cleanroom',
				loaderVersion: '0.5.17',
				memoryMb: 12288,
				pack: {
					source: 'curseforge',
					project: String(MEATBALLCRAFT),
					version: String(meatball.id),
					versionName: meatball.name.match(/(\d[\d.]*\d)(?:\.zip)?$/)?.[1] ?? meatball.name,
					name: 'MeatballCraft, Dimensional Ascension'
				},
				worldMb: 9800,
				running: { players: PLAYERS.slice(5, 7), mspt: 31.4, memoryMb: 5000, cpuPercent: 70, uptimeMinutes: 2 * 24 * 60 + 310, startSeconds: 241.7 }
			});
			ctx.server({ id: 'snapshot-test', name: 'Snapshot testing', minecraft: '1.21.5', loader: 'vanilla', memoryMb: 2048, worldMb: 80 });

			// The nightly restart the notes and the runs tell of, so the overview's Setup says so too.
			ctx.db.prepare("UPDATE server_instances SET restart_schedule = 'daily', restart_daily_time = '05:00' WHERE id IN ('survival', 'meatballcraft')").run();
			// The crashed one stays crashed for its picture, rather than being started again.
			ctx.db.prepare("UPDATE server_instances SET auto_restart_on_crash = 0 WHERE id = 'creative'").run();

			ctx.tag('Friends', ['survival', 'cobblemon']);
			ctx.tag('Modded', ['cobblemon', 'meatballcraft']);
			ctx.tag('Testing', ['snapshot-test']);
		}
	},
	{
		// A day of CPU and memory, and a week of runs and players; a stopped server's end when it stopped.
		name: 'history',
		run(ctx) {
			const random = seeded(7);
			const now = ctx.now;
			const sample = ctx.db.prepare('INSERT INTO resource_samples (instance_id, timestamp, cpu_percent, memory_bytes) VALUES (?, ?, ?, ?)');
			const run = ctx.db.prepare(
				'INSERT INTO server_runs (instance_id, invocation, started_at, done_at, ended_at, exit_status, failed, crashed, diagnosed) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 1)'
			);
			const session = ctx.db.prepare('INSERT INTO player_sessions (instance_id, player, joined_at, left_at) VALUES (?, ?, ?, ?)');
			for (const [id, baseMb, heapSwingMb, cpu, startSeconds, stoppedHoursAgo] of /** @type {[string, number, number, number, number, number?][]} */ ([
				['survival', 2300, 900, 28, 38],
				['cobblemon', 2800, 1000, 42, 52, 3],
				['meatballcraft', 4100, 1900, 65, 242]
			])) {
				const until = stoppedHoursAgo ? now - stoppedHoursAgo * HOUR : now - 60_000;
				ctx.db.transaction(() => {
					// Every 10 s, as the monitor samples: a garbage-collected sawtooth, busier in the evening.
					let heap = 0;
					for (let t = now - DAY; t < until; t += 10_000) {
						const hour = new Date(t).getHours();
						const busy = hour >= 17 && hour <= 23 ? 1.5 : hour < 7 ? 0.5 : 1;
						heap += (5 + random() * 20) * busy;
						if (heap > heapSwingMb) heap = random() * 120;
						const mem = (baseMb + heap) * 1024 * 1024;
						sample.run(id, t, cpu * busy * (0.75 + random() * 0.5), Math.round(mem));
					}
					// A run per night, restarted at 05:00, and evening sessions.
					for (let d = 7; d >= 1; d--) {
						const start = new Date(now - d * DAY);
						start.setHours(5, 0, 12, 0);
						const end = start.getTime() + DAY - 60_000;
						run.run(id, crypto.randomBytes(16).toString('hex'), start.getTime(), start.getTime() + (startSeconds + 3 * random()) * 1000, end);
						for (const player of PLAYERS) {
							if (random() < 0.35) continue;
							const join = start.getTime() + (12 + random() * 6) * HOUR;
							session.run(id, player, join, join + (0.3 + random() * 3) * HOUR);
						}
					}
					// A stopped server's run today, from the nightly restart to the stop.
					const today = new Date(now).setHours(5, 0, 12, 0);
					if (stoppedHoursAgo && until > today + HOUR)
						run.run(id, crypto.randomBytes(16).toString('hex'), today, today + startSeconds * 1000, until);
				})();
			}
		}
	},
	{
		// The pack servers' mods, with their real names and icons.
		name: 'mods',
		async run(ctx) {
			// Cobblemon's: the installed pack version's own mods/, named through Modrinth by hash. The jars the
			// newest version ships under the same name are the real ones: a pack change preview hashes those to
			// tell an updated mod from an unchanged one, and a sparse file would read as updated.
			const { installed, newest } = await cobblemonVersions(ctx);
			const [ours, theirs] = await Promise.all([packIndex(installed), packIndex(newest)]);
			const kept = new Set(theirs.files.map((f) => f.path));
			// The pack change the gallery previews (shots.mjs, pack-update).
			ctx.vars.cobblemonNewest = newest.id;
			// Files the pack marks server-unsupported are never installed on a server (packs/index.ts).
			const packJars = ours.files.filter((f) => f.path.startsWith('mods/') && f.path.endsWith('.jar') && f.env?.server !== 'unsupported');
			const res = await fetch('https://api.modrinth.com/v2/version_files', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ hashes: packJars.map((f) => f.hashes.sha512), algorithm: 'sha512' })
			});
			/** @type {Record<string, { id: string; project_id: string; version_number: string }>} */
			const byHash = await res.json();
			const ids = [...new Set(Object.values(byHash).map((v) => v.project_id))];
			const projects = new Map(
				(await ctx.fetchJson(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`)).map((/** @type {{ id: string }} */ p) => [p.id, p])
			);
			for (const f of packJars) {
				const fileName = f.path.slice('mods/'.length);
				const version = byHash[f.hashes.sha512];
				const project = version && projects.get(version.project_id);
				ctx.mod('cobblemon', {
					source: project ? 'modrinth' : 'manual',
					slug: project?.id ?? fileName,
					name: project?.title ?? fileName.replace(/[-_]?\d.*$/, ''),
					summary: project?.description,
					projectUrl: project ? `https://modrinth.com/mod/${project.slug}` : undefined,
					iconUrl: project?.icon_url,
					version: version?.version_number ?? fileName.replace(/\.jar$/, ''),
					versionId: version?.id,
					fileName,
					size: f.fileSize,
					hash: f.hashes.sha512,
					fromPack: true,
					data: kept.has(f.path) ? await cachedDownload(f.downloads[0], `${f.hashes.sha1}.jar`) : undefined
				});
			}
			// MeatballCraft's mods: every jar of its pack version, named by CurseForge (16 lookups at a time).
			const meatball = await meatballcraft(ctx);
			const jars = meatball.files.filter((f) => f.path.replace(/^\.?\//, '') === 'mods/' && f.name.endsWith('.jar') && f.curseforge);
			for (let i = 0; i < jars.length; i += 16) {
				const batch = jars.slice(i, i + 16);
				const projects = await Promise.all(batch.map((f) => ctx.fetchJson(`${MIRROR}/mod/${f.curseforge?.project}`).catch(() => null)));
				for (const [j, file] of batch.entries()) {
					const project = projects[j];
					ctx.mod('meatballcraft', {
						source: 'curseforge',
						slug: String(file.curseforge?.project),
						name: project?.name ?? file.name.replace(/[-_]?\d.*$/, ''),
						summary: project?.synopsis,
						iconUrl: project?.art?.[0]?.url,
						version: file.name.replace(/\.jar$/, ''),
						versionId: file.curseforge?.file,
						fileName: file.name,
						size: file.size,
						hash: file.sha1,
						hashAlgo: 'sha1',
						fromPack: true
					});
				}
			}
			// The crashed server's mods: the recorded crash's own mods folder, as small jars carrying
			// each mod's id and classes (what the diagnosis reads), and Mod Menu disabled as client-only.
			const creative = path.join(ctx.dataDir, 'instances/creative/mods');
			for (const jar of JSON.parse(fs.readFileSync(CRASH_LOG.replace(/\.log$/, '.mods.json'), 'utf8'))) {
				const file = path.join(creative, jar.enabled ? jar.fileName : `${jar.fileName}.disabled`);
				fs.writeFileSync(file, await modJar(jar.ids[0], jar.names[0], jar.clientOnly, jar.classes));
			}
			// Voice chat's own UDP port, clear of 24454 (a real server on this machine may hold it).
			const config = path.join(ctx.dataDir, 'instances/cobblemon/config/voicechat');
			fs.mkdirSync(config, { recursive: true });
			fs.writeFileSync(path.join(config, 'voicechat-server.properties'), 'port=24790\n');
		}
	}
];

export { PLAYERS };
