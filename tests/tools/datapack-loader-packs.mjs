#!/usr/bin/env node
/**
 * Three small Modrinth packs (.mrpack) for trying the pack change's data pack
 * loader warning (datapackloaders.ts) by hand: no real pack ships a data pack
 * loader and then drops it. Fabric 1.21.1 on the newest stable Fabric Loader
 * (newest mod builds can need it: Bookshelf 21.1.81 wants 0.17.2), each mod's
 * newest build for it from Modrinth (downloaded at install, as for any pack):
 *
 *   1.0.0  Open Loader (with Bookshelf, Prickle and Fabric API)
 *   2.0.0  Fabric API alone: Open Loader dropped, nothing takes over
 *   3.0.0  Paxi (with Cloth Config, YUNG's API and Fabric API) in its place
 *
 *   node tests/tools/datapack-loader-packs.mjs <out dir>
 *
 * Install 1.0.0 from Add a server's pack upload, start it once, put a data pack
 * (a zip or folder) into config/openloader/packs, then upload 2.0.0 or 3.0.0 in
 * Settings > Modpack: the preview should say Open Loader goes and its data packs
 * are not loaded any more.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yazl = require('yazl');

const out = process.argv[2];
if (!out) {
	console.error('Usage: node tests/tools/datapack-loader-packs.mjs <out dir>');
	process.exit(1);
}

const MINECRAFT = '1.21.1';
const API = 'https://api.modrinth.com/v2';
const HEADERS = { 'User-Agent': 'MineShell test tooling (tests/tools/datapack-loader-packs.mjs)' };

const PACKS = [
	{ version: '1.0.0', mods: ['fabric-api', 'bookshelf-lib', 'prickle', 'open-loader'] },
	{ version: '2.0.0', mods: ['fabric-api'] },
	{ version: '3.0.0', mods: ['fabric-api', 'cloth-config', 'yungs-api', 'paxi'] }
];

/** The newest Fabric build of a project for the Minecraft version, as an index entry. @param {string} slug */
async function entry(slug) {
	const query = new URLSearchParams({ loaders: JSON.stringify(['fabric']), game_versions: JSON.stringify([MINECRAFT]) });
	const res = await fetch(`${API}/project/${slug}/version?${query}`, { headers: HEADERS });
	if (!res.ok) throw new Error(`${slug}: Modrinth answered ${res.status}`);
	const [version] = await res.json();
	if (!version) throw new Error(`${slug}: no Fabric build for ${MINECRAFT}`);
	const file = version.files.find((/** @type {{ primary: boolean }} */ f) => f.primary) ?? version.files[0];
	return {
		path: `mods/${file.filename}`,
		hashes: { sha1: file.hashes.sha1, sha512: file.hashes.sha512 },
		env: { client: 'required', server: 'required' },
		downloads: [file.url],
		fileSize: file.size
	};
}

const loaders = await (await fetch('https://meta.fabricmc.net/v2/versions/loader', { headers: HEADERS })).json();
const FABRIC_LOADER = loaders.find((/** @type {{ stable: boolean }} */ l) => l.stable)?.version;
if (!FABRIC_LOADER) throw new Error('Fabric meta lists no stable loader');

fs.mkdirSync(out, { recursive: true });
const entries = new Map();
for (const slug of new Set(PACKS.flatMap((p) => p.mods))) entries.set(slug, await entry(slug));

for (const pack of PACKS) {
	const index = {
		formatVersion: 1,
		game: 'minecraft',
		versionId: pack.version,
		name: 'Data pack loader test',
		summary: `Version ${pack.version}: ${pack.mods.join(', ')}`,
		files: pack.mods.map((slug) => entries.get(slug)),
		dependencies: { minecraft: MINECRAFT, 'fabric-loader': FABRIC_LOADER }
	};
	const file = path.join(out, `datapack-loader-test-${pack.version}.mrpack`);
	const zip = new yazl.ZipFile();
	zip.addBuffer(Buffer.from(JSON.stringify(index, null, 1)), 'modrinth.index.json');
	zip.end();
	await new Promise((resolve, reject) => zip.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject));
	console.log(`${file} (Fabric Loader ${FABRIC_LOADER}): ${index.files.map((f) => path.basename(f.path)).join(', ')}`);
}
