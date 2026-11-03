#!/usr/bin/env node
// What mod jars declare about themselves (describeModJar: fabric.mod.json, quilt.mod.json,
// mods.toml, neoforge.mods.toml, mcmod.info), next to the name their catalog record gives,
// and the one mainDeclaredMod picks to show for a jar no catalog knows, for every server in a
// MineShell data dir. Read only. To judge how far a jar's own name and
// version can stand in for a catalog's (ROADMAP, "Mods from outside Modrinth's hash lookup"):
//
//   node tests/tools/jar-metadata-survey.mjs ~/mineshell-data [--list]
//
// --list prints every jar; without it, the counts and the odd cases.
import path from 'node:path';
import Database from 'better-sqlite3';

const { describeModJar, mainDeclaredMod } = await import('../../src/lib/server/crashdiag.ts');
const dir = process.argv[2] || process.env.MINESHELL_DATA;
if (!dir) {
	console.error('usage: jar-metadata-survey.mjs <MineShell data dir> [--list]');
	process.exit(2);
}
const list = process.argv.includes('--list');
const db = new Database(path.join(dir, 'mineshell.db'), { readonly: true });
const rows = /** @type {{ instance_id: string, file_path: string, version: string | null, source: string, name: string }[]} */ (db
	.prepare(
		`select im.instance_id, im.file_path, im.version, m.source, m.name
		 from instance_mods im join mods m on m.id = im.mod_id`
	)
	.all());

const counts = { jars: 0, unreadable: 0, noName: 0, several: 0, noVersion: 0, sameName: 0, catalogued: 0 };
const odd = [];
for (const row of rows) {
	const file = path.join(dir, 'instances', row.instance_id, row.file_path);
	const jar = await describeModJar(file).catch(() => null);
	counts.jars++;
	if (!jar) {
		counts.unreadable++;
		continue;
	}
	const main = mainDeclaredMod(jar, path.basename(file));
	if (!main) counts.noName++;
	if (jar.mods.length > 1) counts.several++;
	if (!main?.version) counts.noVersion++;
	if (row.source !== 'manual') {
		counts.catalogued++;
		if (main && main.name?.toLowerCase() === row.name.toLowerCase()) counts.sameName++;
	}
	if (list || !main || !main.version || jar.mods.length > 1) {
		const shown = main ? `${main.name} ${main.version ?? '(no version)'}` : '(nothing usable)';
		odd.push(`${row.instance_id}/${path.basename(row.file_path)}\t${row.source}: ${row.name} ${row.version ?? ''} | shown: ${shown} | of ${jar.mods.map((m) => m.id).join(', ')}`);
	}
}
console.log(counts);
console.log(odd.join('\n'));
