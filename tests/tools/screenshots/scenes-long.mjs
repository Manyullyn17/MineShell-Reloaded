/**
 * The long world (`npm run screenshots -- --long`): every field filled to the
 * most it takes, and text from elsewhere (mod, pack and player names, versions,
 * file names, item names, dimensions) as long as it gets, for sweeping the
 * pages for text that breaks them (tests/tools/page-sweep.mjs --spill). No
 * network. Fields MineShell limits are filled through its own form actions at
 * their limit, so a limit that moves shows here; what it reads from elsewhere
 * is written as it would arrive. Signed in: an owner (run.mjs) and a
 * restricted account (here) with a 32-character name, for sweeping as each.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';
import { offlineUuid } from './scenes.mjs';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const WORDS = 'the quick server keeps every chunk of its long named world loaded for friends who play late into the night with modded machines and far too many tabs open'.split(' ');

/** Words, exactly `n` characters (no space at either end). @param {number} n @param {number} [start] */
export function words(n, start = 0) {
	let out = '';
	for (let i = start; out.length < n; i++) out += (out ? ' ' : '') + WORDS[i % WORDS.length];
	out = out.slice(0, n);
	return out.endsWith(' ') ? `${out.slice(0, -1)}s` : out;
}
/** One word of `n` characters, the way a mod or file name runs on: no place to break. @param {number} n @param {string} [stem] */
export function unbroken(n, stem = 'ExtremelyLongUnbrokenName') {
	return stem.repeat(Math.ceil(n / stem.length)).slice(0, n);
}

/**
 * Twenty player names of 16 characters, the most Minecraft allows; W and M are
 * the widest letters, and a Bedrock (Floodgate) name has a dot in front.
 */
const PLAYERS = [
	'WWWWWWWWWWWWWWWW',
	'MMMMMMMMMMMMMMMM',
	'xX_Long_Name_Xx_',
	'Supercalifragili',
	'The_Wandering_Ox',
	'.WWWWWWWWWWWWWWW',
	...Array.from({ length: 14 }, (_, i) => `Player_Number_${String(i + 10).padStart(2, '0')}`)
];

/** Server names at the limit (instances.ts SERVER_NAME_MAX): spaced, and one word. */
const NAME_SPACED = words(80);
const NAME_UNBROKEN = unbroken(80, 'MeatballCraftDimensionalAscension');
/** A pack's name as a platform may give it (Modrinth allows 64; CurseForge more). */
const PACK_NAME = words(100, 7);
const PACK_VERSION = '2.44.1-beta.3-hotfix+build.20261027.2315-neoforge-21.1.77-SNAPSHOT';
const LOADER_VERSION = '21.1.77-beta+backport.20261027-unofficial';
const DIM_MOD = 'extremelylongmodidentifier';
const DIM_NAME = 'the_extremely_long_dimension_name_from_a_mod_that_never_stops';

/** A real crash (tests/crashdiag), its mods renamed long. */
const CRASH_LOG = fileURLToPath(new URL('../../crashdiag/fixtures/real-vanillaperfected-simpledatapacks.log', import.meta.url));

/**
 * A Fabric mod jar holding only fabric.mod.json and the class files' names (scenes.mjs's modJar).
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

/** @param {string} dir @param {string} file @param {unknown} value */
const writeJson = (dir, file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value, null, 2));

/** The player lists, as the game writes them: names at 16, ban reasons at MineShell's 200. @param {string} dir */
function playerLists(dir) {
	const ban = { created: '2026-10-01 12:00:00 +0000', source: 'MineShell', expires: 'forever', reason: words(200, 3) };
	writeJson(dir, 'whitelist.json', PLAYERS.map((name) => ({ uuid: offlineUuid(name), name })));
	writeJson(dir, 'ops.json', PLAYERS.slice(0, 4).map((name) => ({ uuid: offlineUuid(name), name, level: 4, bypassesPlayerLimit: false })));
	writeJson(dir, 'banned-players.json', PLAYERS.slice(16).map((name) => ({ uuid: offlineUuid(name), name, ...ban })));
	writeJson(dir, 'banned-ips.json', [{ ip: '2001:0db8:85a3:0000:0000:8a2e:0370:7334', ...ban }]);
	fs.writeFileSync(
		path.join(dir, 'usercache.json'),
		JSON.stringify(PLAYERS.map((name) => ({ name, uuid: offlineUuid(name), expiresOn: '2099-01-01 00:00:00 +0000' })))
	);
}

/** @type {{ name: string; run: (ctx: import('./run.mjs').Context) => Promise<void> | void }[]} */
export const longScenes = [
	{
		name: 'servers',
		run(ctx) {
			ctx.server({
				id: 'spaced',
				name: NAME_SPACED,
				minecraft: '1.21.1',
				loader: 'vanilla',
				memoryMb: 6144,
				worldMb: 300,
				pinned: true,
				running: {
					players: PLAYERS,
					mspt: 48.2,
					memoryMb: 600,
					cpuPercent: 20,
					uptimeMinutes: 9 * DAY / 60_000 + 23 * 60 + 59,
					chat: [
						['WWWWWWWWWWWWWWWW', words(256)],
						['MMMMMMMMMMMMMMMM', `https://example.com/${unbroken(230, 'averylongpathsegment/')}`, 3],
						['*', `xX_Long_Name_Xx_ has made the advancement [${words(60, 4)}]`, 5],
						['Supercalifragili', unbroken(256, 'W'), 4]
					]
				},
				properties: { motd: words(150, 2), 'max-players': '2147483647', 'level-name': 'world' }
			});
			ctx.server({
				id: 'unbroken',
				name: NAME_UNBROKEN,
				minecraft: '1.21.1',
				loader: 'neoforge',
				loaderVersion: LOADER_VERSION,
				memoryMb: 65536,
				worldMb: 120,
				pack: { source: 'curseforge', project: '999999', version: '8888888', versionName: PACK_VERSION, name: PACK_NAME }
			});
			ctx.server({
				id: 'crashed',
				name: words(80, 12),
				minecraft: '1.21.11',
				loader: 'fabric',
				loaderVersion: '0.18.4',
				worldMb: 20,
				running: { players: [], crashLog: CRASH_LOG }
			});
			ctx.db.prepare("UPDATE server_instances SET auto_restart_on_crash = 0 WHERE id = 'crashed'").run();
			ctx.db.prepare("UPDATE server_instances SET restart_schedule = 'daily', restart_daily_time = '05:00' WHERE id = 'spaced'").run();
			for (const id of ['spaced', 'unbroken']) playerLists(path.join(ctx.dataDir, 'instances', id));

			// The pack's update notice and a found mod update, with long names on both.
			ctx.db
				.prepare('INSERT INTO update_notices (instance_id, kind, from_version, version_id, label, channel, found_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
				.run('unbroken', 'pack', PACK_VERSION, '8888889', `${PACK_VERSION}-and-then-some`, 'beta', ctx.now - HOUR);

			// A Java with a long path and vendor string.
			ctx.db
				.prepare('INSERT INTO java_runtimes (path, major_version, version_string, vendor, manual, last_seen_at) VALUES (?, 21, ?, ?, 1, ?)')
				.run(`/opt/${unbroken(120, 'very-long-folder-name/')}/bin/java`, '21.0.9+10-LTS-graalvm-community-jdk-21.0.9-unofficial-build', words(60, 5), ctx.now);
		}
	},
	{
		name: 'history',
		run(ctx) {
			const session = ctx.db.prepare('INSERT INTO player_sessions (instance_id, player, joined_at, left_at) VALUES (?, ?, ?, ?)');
			const run = ctx.db.prepare(
				'INSERT INTO server_runs (instance_id, invocation, started_at, done_at, ended_at, exit_status, failed, crashed, diagnosed) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 1)'
			);
			const sample = ctx.db.prepare('INSERT INTO resource_samples (instance_id, timestamp, cpu_percent, memory_bytes) VALUES (?, ?, ?, ?)');
			ctx.db.transaction(() => {
				for (let t = ctx.now - DAY; t < ctx.now; t += 60_000) sample.run('spaced', t, 1599 * (0.5 + 0.5 * Math.sin(t / HOUR)), 64 * 1024 ** 3);
				for (let d = 7; d >= 1; d--) {
					const start = ctx.now - d * DAY;
					run.run('spaced', crypto.randomBytes(16).toString('hex'), start, start + 9999_000, start + DAY - 60_000);
					for (const [i, player] of PLAYERS.entries()) session.run('spaced', player, start + i * 60_000, start + DAY - 120_000);
				}
			})();
		}
	},
	{
		name: 'mods',
		async run(ctx) {
			// Thirty mods named the longest ways they come: spaced, one word, long files and versions.
			for (let i = 0; i < 30; i++) {
				const spaced = i % 2 === 0;
				ctx.mod('unbroken', {
					source: i % 3 === 0 ? 'manual' : i % 3 === 1 ? 'modrinth' : 'curseforge',
					slug: `long-mod-${i}`,
					name: spaced ? words(100, i) : unbroken(64, i % 4 === 1 ? 'AppliedEnergistics2WirelessTerminals' : 'W'),
					summary: words(256, i + 1),
					projectUrl: `https://modrinth.com/mod/${unbroken(64, 'long-mod-slug-')}`,
					version: `${PACK_VERSION}.${i}`,
					fileName: `${unbroken(150, 'create-new-age-steam-and-electricity-addon-')}-${i}.jar`,
					size: 1234567 * (i + 1),
					fromPack: i < 20,
					enabled: i % 5 !== 4
				});
			}
			ctx.db
				.prepare('INSERT INTO mod_update_notices (instance_id, updates, fingerprint, found_at) VALUES (?, ?, ?, ?)')
				.run(
					'spaced',
					JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ fileName: `${unbroken(150, 'long-file-name-')}-${i}.jar`, name: words(100, i), from: PACK_VERSION, to: `${PACK_VERSION}-next` }))),
					'long',
					ctx.now - HOUR
				);
			// The crashed server's mods: the recorded crash's own, renamed long (the diagnosis names them).
			const crashed = path.join(ctx.dataDir, 'instances/crashed/mods');
			for (const [i, jar] of JSON.parse(fs.readFileSync(CRASH_LOG.replace(/\.log$/, '.mods.json'), 'utf8')).entries()) {
				const file = path.join(crashed, jar.enabled ? jar.fileName : `${jar.fileName}.disabled`);
				fs.writeFileSync(file, await modJar(jar.ids[0], `${jar.names[0]} ${i % 2 ? words(80, i) : unbroken(60)}`, jar.clientOnly, jar.classes));
			}
		}
	},
	{
		// Folders and files with the longest names a file system takes (255 bytes), deep inside each other.
		name: 'files',
		run(ctx) {
			const dir = path.join(ctx.dataDir, 'instances/unbroken');
			let deep = path.join(dir, 'config');
			for (let i = 0; i < 6; i++) deep = path.join(deep, unbroken(60, `nested-folder-${i}-`));
			fs.mkdirSync(deep, { recursive: true });
			fs.writeFileSync(path.join(deep, `${unbroken(250, 'a-very-long-config-file-name-')}.toml`), `${words(2000)}\n`);
			fs.writeFileSync(path.join(dir, `${words(250)}.txt`), 'spaced\n');
			fs.writeFileSync(path.join(dir, `${unbroken(251)}.txt`), 'unbroken\n');
			// A dimension from a mod with a long id and name, and a world folder named long.
			const region = path.join(dir, 'world/dimensions', DIM_MOD, DIM_NAME, 'region');
			fs.mkdirSync(region, { recursive: true });
			ctx.sparseFile(path.join(region, 'r.0.0.mca'), 8 * 1024 * 1024);
			for (const name of [`${unbroken(200, 'some-mods-own-dimension-')}`, words(200)]) ctx.sparseFile(path.join(dir, 'world/dimensions/othermod', name.replace(/ /g, '_'), 'region/r.0.0.mca'), 4096 * 3);
			// Logs and crash reports named long.
			fs.mkdirSync(path.join(dir, 'crash-reports'), { recursive: true });
			fs.writeFileSync(path.join(dir, `crash-reports/crash-2026-10-27_05.00.00-server-${unbroken(150, 'long-')}.txt`), `---- Minecraft Crash Report ----\n// ${words(300)}\n`);
			fs.writeFileSync(path.join(dir, `logs/${unbroken(200, 'debug-')}.log`), `${unbroken(5000, 'W')}\n${words(4000)}\n`);
		}
	},
	{
		// Player files on the running server's world (offline players, so the editor opens them) with
		// long custom names, lore and modded ids.
		name: 'player-files',
		async run(ctx) {
			const { writeNbt } = await import('../../../src/lib/server/nbt.ts');
			const dir = path.join(ctx.dataDir, 'instances/unbroken/world/playerdata');
			fs.mkdirSync(dir, { recursive: true });
			// NBT as nbt.ts holds it (scenes.mjs has the same helpers).
			/** @param {string} value @returns {any} */ const string = (value) => ({ type: 'string', value });
			/** @param {number} value @returns {any} */ const int = (value) => ({ type: 'int', value });
			/** @param {number} value @returns {any} */ const byte = (value) => ({ type: 'byte', value });
			/** @param {[string, any][]} value @returns {any} */ const compound = (value) => ({ type: 'compound', value });
			/** @param {string} itemType @param {any[]} value @returns {any} */ const list = (itemType, value) => ({ type: 'list', itemType, value });
			/** @param {number} slot @param {string} id @param {string} name */
			const item = (slot, id, name) =>
				compound([
					['Slot', byte(slot)],
					['id', string(id)],
					['count', int(64)],
					[
						'components',
						compound([
							['minecraft:custom_name', string(JSON.stringify({ text: name }))],
							['minecraft:lore', list('string', [string(JSON.stringify({ text: words(200, slot) })), string(JSON.stringify({ text: unbroken(120, 'W') }))])],
							['minecraft:enchantments', compound([['levels', compound([[`${DIM_MOD}:${unbroken(60, 'enchant_')}`, int(255)], ['minecraft:sharpness', int(32767)]])]])]
						])
					]
				]);
			const items = Array.from({ length: 36 }, (_, slot) =>
				item(slot, slot % 2 ? `${DIM_MOD}:${unbroken(60, 'item_registry_name_')}` : 'minecraft:netherite_sword', slot % 2 ? unbroken(50, 'W') : words(50, slot))
			);
			for (const name of PLAYERS.slice(0, 3)) {
				const root = compound([
					['DataVersion', int(3955)],
					['Dimension', string(`${DIM_MOD}:${DIM_NAME}`)],
					['Pos', list('double', [{ type: 'double', value: -29999999.5 }, { type: 'double', value: 320 }, { type: 'double', value: 29999999.5 }])],
					['XpLevel', int(2147483647)],
					['playerGameType', int(3)],
					['Inventory', list('compound', items)],
					['EnderItems', list('compound', items.slice(0, 27))]
				]);
				fs.writeFileSync(path.join(dir, `${offlineUuid(name)}.dat`), writeNbt({ name: '', root, gzipped: true }));
			}
		}
	}
];

/**
 * What goes in through MineShell's own forms, at each one's limit, once it runs
 * (run.mjs calls this after the start, signed in as the owner).
 * @param {(page: string, action: string, fields?: Record<string, string>) => Promise<unknown>} act
 * @param {(page: string, init: RequestInit) => Promise<Response>} call
 * @param {import('./run.mjs').Context} ctx
 * @returns {Promise<string>} the restricted account's id
 */
export async function longForms(act, call, ctx) {
	for (const id of ['spaced', 'unbroken', 'crashed']) {
		await act(`/instances/${id}`, 'notes', { notes: words(4000, id.length) });
		for (let t = 0; t < 6; t++) await act(`/instances/${id}`, 'addTag', { name: t % 2 ? unbroken(31, 'W') + t : words(32, t) });
	}
	for (let i = 0; i < 4; i++) await act('/instances/spaced/settings', 'addCommand', { command: `say ${words(496, i)}`, mode: 'daily', dailyTime: `0${i}:00` });
	await call('/api/instances/spaced/macros', {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ macros: Array.from({ length: 20 }, (_, i) => (i % 2 ? `say ${words(196, i)}` : `tellraw @a ${unbroken(189, 'W')}`)) })
	});
	// Snapshots with the longest note and the most tags (snapshots.ts NOTE_MAX, TAG_MAX, TAGS_MAX).
	const snapshots = path.join(ctx.dataDir, 'instances/unbroken/.mineshell/snapshots');
	for (let i = 0; i < 2; i++) {
		const before = new Set(fs.existsSync(snapshots) ? fs.readdirSync(snapshots) : []);
		await act('/instances/unbroken/world', 'snapshot');
		let id;
		for (let wait = 0; wait < 60 && !id; wait++) {
			id = (fs.existsSync(snapshots) ? fs.readdirSync(snapshots) : []).find((f) => !before.has(f) && !f.includes('.'));
			if (!id) await new Promise((r) => setTimeout(r, 500));
		}
		if (!id) throw new Error('The snapshot did not appear.');
		await new Promise((r) => setTimeout(r, 1500));
		const tags = Array.from({ length: 10 }, (_, t) => (t % 2 ? unbroken(31, 'W') + t : words(31, t) + t)).join(',');
		await act('/instances/unbroken/world', 'editSnapshot', { id, note: i ? unbroken(120, 'W') : words(120), tags });
	}
	// Worlds named at the limit (worlds.ts WORLD_NAME_MAX), on the stopped server (after the snapshots: a new world is the active one).
	await act('/instances/unbroken/world', 'createWorld', { name: unbroken(60, 'W'), seedMode: 'random' });
	await act('/instances/unbroken/world', 'createWorld', { name: words(60), seedMode: 'set', seed: '-9223372036854775808' });
	// Back to the first world, which holds the player files.
	await act('/instances/unbroken/world', 'switchWorld', { world: 'world' });
	// MineShell settings: presets (jvm-presets.ts PRESET_NAME_MAX, PRESET_DESCRIPTION_MAX), backup folders and accounts named long.
	await act('/settings', 'savePreset', { presetName: words(60), presetDescription: words(200, 3), jvmArgs: `-XX:+UseG1GC ${unbroken(400, '-XX:SomeVeryLongFlagName=1 ')}` });
	await act('/settings', 'savePreset', { presetName: unbroken(60, 'W'), presetDescription: unbroken(200, 'W'), jvmArgs: '-XX:+UseZGC' });
	// Outside the data folder, which MineShell refuses; emptied each run.
	const backups = `${ctx.dataDir}-backups`;
	fs.rmSync(backups, { recursive: true, force: true });
	const folder = path.join(backups, unbroken(120, 'backup-folder-on-a-usb-drive/'));
	fs.mkdirSync(folder, { recursive: true });
	await act('/settings', 'addBackupFolder', { name: unbroken(60, 'W'), path: folder, compress: 'on' });
	await act('/settings', 'addBackupFolder', { name: words(60), path: backups });
	// The restricted account the sweep signs in as: some servers, some of each (its session is run.mjs's).
	const restricted = crypto.randomUUID();
	ctx.db
		.prepare('INSERT INTO users (id, username, password_hash, is_owner, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
		.run(restricted, unbroken(32, 'W'), 'unusable', ctx.now, ctx.now);
	const grant = ctx.db.prepare('INSERT INTO instance_access (user_id, instance_id, is_admin, permissions, player_view, player_edit, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)');
	grant.run(restricted, 'spaced', JSON.stringify(['view', 'console.read', 'settings.view', 'backups.create']), 'all', 'none', ctx.now);
	grant.run(restricted, 'unbroken', JSON.stringify(['view', 'mods', 'files']), 'selected', 'none', ctx.now);
	ctx.db.prepare('INSERT INTO instance_player_access (user_id, instance_id, uuid, can_edit) VALUES (?, ?, ?, 0)').run(restricted, 'unbroken', offlineUuid(PLAYERS[0]));
	for (let i = 0; i < 6; i++) await act('/settings/users', 'create', { newAccount: `${unbroken(30, i % 2 ? 'W' : 'Account_with_a_long_name_')}${String(i).padStart(2, '0')}`, ...(i === 0 ? { canCreate: 'on' } : {}) });
	return restricted;
}
