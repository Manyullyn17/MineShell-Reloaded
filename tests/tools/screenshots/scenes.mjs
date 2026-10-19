/**
 * The placeholder world the screenshots show (README.md here). Each scene puts
 * one thing into a fresh throwaway data dir; they run in order, all of them,
 * so every shot sees the same world. Add a scene for new data, change one to
 * change what the pictures show. Never real data: names are invented, players
 * are offline-mode UUIDs (MineShell never looks those up).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

/** @type {{ name: string; run: (ctx: import('./run.mjs').Context) => Promise<void> | void }[]} */
export const scenes = [
	{
		name: 'servers',
		async run(ctx) {
			// Up since the nightly restart at 05:00 (the day before, early in the morning).
			const sinceFive = Math.floor((ctx.now - new Date(ctx.now).setHours(5, 0, 0, 0)) / 60_000);
			// The Cobblemon pack's newest version for 1.21.1, so its name matches the mods it ships.
			const [packVersion] = await ctx.fetchJson(
				`https://api.modrinth.com/v2/project/5FFgwNNP/version?loaders=${encodeURIComponent('["fabric"]')}&game_versions=${encodeURIComponent('["1.21.1"]')}`
			);
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
			ctx.server({ id: 'creative', name: 'Creative build', minecraft: '1.21.4', loader: 'fabric', loaderVersion: '0.16.10', memoryMb: 4096, worldMb: 600, properties: { gamemode: 'creative' } });
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
		// The pack server's mods, with their real names and icons from Modrinth.
		name: 'mods',
		async run(ctx) {
			const slugs = [
				'cobblemon',
				'fabric-api',
				'fabric-language-kotlin',
				'lithium',
				'ferrite-core',
				'c2me-fabric',
				'chunky',
				'spark',
				'waystones',
				'balm',
				'jei',
				'jade',
				'appleskin',
				'travelersbackpack',
				'yungs-api',
				'yungs-better-dungeons',
				'terralith',
				'simple-voice-chat'
			];
			const projects = await ctx.fetchJson(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(slugs))}`);
			for (const slug of slugs) {
				const project = projects.find((/** @type {{ slug: string }} */ p) => p.slug === slug);
				if (!project) continue;
				const versions = await ctx.fetchJson(
					`https://api.modrinth.com/v2/project/${slug}/version?loaders=${encodeURIComponent('["fabric"]')}&game_versions=${encodeURIComponent('["1.21.1"]')}`
				);
				const version = versions[0];
				const file = version?.files.find((/** @type {{ primary: boolean }} */ f) => f.primary) ?? version?.files[0];
				if (!file) continue;
				ctx.mod('cobblemon', {
					source: 'modrinth',
					slug: project.id,
					name: project.title,
					summary: project.description,
					projectUrl: `https://modrinth.com/mod/${slug}`,
					iconUrl: project.icon_url,
					version: version.version_number,
					versionId: version.id,
					fileName: file.filename,
					size: file.size,
					hash: file.hashes.sha512,
					fromPack: true
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
			// Voice chat's own UDP port, clear of 24454 (a real server on this machine may hold it).
			const config = path.join(ctx.dataDir, 'instances/cobblemon/config/voicechat');
			fs.mkdirSync(config, { recursive: true });
			fs.writeFileSync(path.join(config, 'voicechat-server.properties'), 'port=24790\n');
		}
	}
];

export { PLAYERS };
