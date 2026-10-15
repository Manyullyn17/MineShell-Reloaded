#!/usr/bin/env node
/**
 * Puts a server row into a throwaway dev server's database, without
 * installing anything: for looking at pages that need a server of some
 * shape (a pack server on an old version, a Fabric server on an old loader).
 * Start the dev server once first, so its migrations have run. Never point
 * this at real data.
 *
 *   node tests/tools/seed-instance.mjs <data dir> <id> [options]
 *     --mc <version>             Minecraft version (default 1.21.1)
 *     --loader <id>              vanilla | fabric | quilt | forge | neoforge | cleanroom (default fabric)
 *     --loader-version <v>       the installed loader build
 *     --pack <source>:<project>:<versionId>[:<version name>[:<pack name>]]
 *                                a pack server, e.g. modrinth:5FFgwNNP:Cqimd3JM:1.8.1:Cobblemon
 *     --port <n>                 game port (RCON is port + 10; default 25900 + a count)
 *
 * The folder <data dir>/instances/<id> is created empty; the EULA counts as accepted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
/** @param {string} name @param {string | null} [fallback] */
const option = (name, fallback = null) => {
	const at = args.indexOf(name);
	if (at < 0) return fallback;
	const [value] = args.splice(at, 2).slice(1);
	return value;
};
const minecraft = option('--mc', '1.21.1');
const loader = option('--loader', 'fabric');
const loaderVersion = option('--loader-version');
const pack = option('--pack');
const portArg = option('--port');
const [dataDir, id] = args;
if (!dataDir || !id) {
	console.error('Usage: node tests/tools/seed-instance.mjs <data dir> <id> [--mc v] [--loader id] [--loader-version v] [--pack source:project:versionId[:name[:pack name]]] [--port n]');
	process.exit(1);
}
const dbFile = path.join(dataDir, 'mineshell.db');
if (!fs.existsSync(dbFile)) throw new Error(`${dbFile} does not exist: start the dev server on this data dir once first.`);

const db = new Database(dbFile);
const count = /** @type {{ n: number }} */ (db.prepare('SELECT count(*) AS n FROM server_instances').get()).n;
const port = Number(portArg ?? 25900 + count + 1);
const [packSource, packProjectId, packVersionId, packVersionName, packName] = pack ? pack.split(':') : [];
const dir = path.join(dataDir, 'instances', id);
fs.mkdirSync(dir, { recursive: true });
const now = Date.now();
db.prepare(
	`INSERT INTO server_instances (id, name, path, minecraft_version, modloader, modloader_version, pack_source, pack_project_id,
		pack_version_id, pack_version_name, pack_name, server_port, rcon_port, rcon_password_enc, jvm_args, launch_args,
		eula_accepted, created_at, updated_at)
	VALUES (@id, @id, @dir, @minecraft, @loader, @loaderVersion, @packSource, @packProjectId, @packVersionId, @packVersionName,
		@packName, @port, @rcon, 'x', '-Xmx2G', '-jar server.jar nogui', 1, @now, @now)`
).run({
	id,
	dir,
	minecraft,
	loader,
	loaderVersion,
	packSource: packSource ?? null,
	packProjectId: packProjectId ?? null,
	packVersionId: packVersionId ?? null,
	packVersionName: packVersionName ?? null,
	packName: packName ?? null,
	port,
	rcon: port + 10,
	now
});
console.log(`${id}: ${loader} ${loaderVersion ?? ''} on ${minecraft}${pack ? `, pack ${packName ?? packProjectId} ${packVersionName ?? packVersionId}` : ''}, port ${port}`);
