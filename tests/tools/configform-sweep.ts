/**
 * Reads every TOML, Forge .cfg and JSON config under the given server folders' config/,
 * defaultconfigs/ and world serverconfig/ with the mod config form (configform.ts), read-only:
 * lists the files the form refuses and why, and changes a few settings of each file to check
 * that only that setting reads back changed.
 *
 *   npx tsx tests/tools/configform-sweep.ts ~/mineshell-data/instances/*
 */
import fs from 'node:fs';
import path from 'node:path';
import { configFormatOf, ConfigFormError, readConfig, writeField, type FieldInput } from '../../src/lib/shared/configform.ts';

const roots = process.argv.slice(2);
const files: string[] = [];
function walk(dir: string, depth: number) {
	if (depth > 5) return;
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) walk(full, depth + 1);
		else if (configFormatOf(e.name)) files.push(full);
	}
}
for (const root of roots) {
	for (const sub of ['config', 'defaultconfigs']) if (fs.existsSync(path.join(root, sub))) walk(path.join(root, sub), 0);
	for (const e of fs.readdirSync(root, { withFileTypes: true })) {
		const sc = path.join(root, e.name, 'serverconfig');
		if (e.isDirectory() && fs.existsSync(sc)) walk(sc, 0);
	}
}

const refused = new Map<string, string[]>();
let ok = 0;
let fields = 0;
const kinds: Record<string, number> = {};
const changed: string[] = [];
for (const file of files) {
	const text = fs.readFileSync(file, 'utf8');
	const format = configFormatOf(file)!;
	try {
		const parsed = readConfig(format, text);
		ok++;
		for (const s of parsed.sections)
			for (const f of s.fields) {
				fields++;
				const k = f.kind + (f.items ? `:${f.items}` : '') + (f.choices ? '+choices' : '') + (f.min !== undefined || f.max !== undefined ? '+range' : '');
				kinds[`${format} ${k}`] = (kinds[`${format} ${k}`] ?? 0) + 1;
			}
		// Changes a few settings each: the setting reads back changed, every other one as it was.
		const all = parsed.sections.flatMap((x) => x.fields);
		for (const f of all.filter((x) => x.kind !== 'raw').slice(0, 12)) {
			const input: FieldInput =
				f.kind === 'boolean' ? !f.value : f.kind === 'integer' ? String(f.min ?? 7) : f.kind === 'float' ? String(f.min ?? 2.5) : f.kind === 'list' ? [...(f.value as string[]), f.items === 'string' ? 'x:y' : '3'] : (f.choices?.[0] ?? 'changed "text"');
			if (JSON.stringify(input) === JSON.stringify(f.value)) continue;
			const again = writeField(text, format, f, input);
			let re;
			try {
				re = readConfig(format, again).sections.flatMap((x) => x.fields);
			} catch (err) {
				changed.push(`${file} ${f.key}: unreadable after writing ${JSON.stringify(input)}: ${(err as Error).message}`);
				continue;
			}
			const expect = (x: (typeof all)[number]) => (x.id === f.id ? JSON.stringify(input) : JSON.stringify(x.value));
			// Numbers by value: a whole number in a list of floats is written 3.0.
			const norm = (x: (typeof all)[number], v: unknown) =>
				x.kind === 'integer' || x.kind === 'float' ? String(Number(v)) : x.kind === 'list' && x.items !== 'string' ? JSON.stringify((v as string[]).map(Number)) : JSON.stringify(v);
			const bad = re.length !== all.length ? 'setting count' : all.find((x, i) => re[i].id !== x.id || norm(x, re[i].value) !== norm(x, JSON.parse(expect(x))))?.key;
			if (bad) changed.push(`${file} ${f.key}: after writing ${JSON.stringify(input)}, ${bad} reads differently`);
		}
	} catch (err) {
		const why = err instanceof ConfigFormError ? err.message.replace(/^Line \d+: /, '') : `CRASH ${(err as Error).message}`;
		refused.set(why, [...(refused.get(why) ?? []), file]);
	}
}
console.log(`${files.length} files, ${ok} in the form, ${fields} settings`);
for (const [k, v] of Object.entries(kinds).sort()) console.log(`  ${k}: ${v}`);
console.log('refused:');
for (const [why, list] of [...refused].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${list.length} × ${why}\n      e.g. ${list.slice(0, 3).join('\n           ')}`);
console.log(`changes that did not read back as written: ${changed.length}`);
for (const c of changed.slice(0, 15)) console.log('  ' + c);
