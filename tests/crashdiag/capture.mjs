// Turn a crash log + mods folder into a self-contained test case.
//
//   node --experimental-strip-types tests/crashdiag/capture.mjs <name> <log> <modsDir> <kind> <culpritRegex> [relatedRegex]
//
// The mods folder of a real pack is gigabytes, so only what the diagnosis can
// actually use is kept: jars the log mentions (by id, name or class package)
// and, for those, the classes sharing a package with something in the log.
import fs from 'node:fs/promises';
import path from 'node:path';
import { indexMods } from '../../src/lib/server/crashdiag.ts';

const here = path.dirname(new URL(import.meta.url).pathname);
const [name, logFile, modsDir, kind, culprit, related] = process.argv.slice(2);
if (!name || !logFile || !modsDir || !kind || culprit === undefined) {
	console.error('usage: capture.mjs <name> <log> <modsDir> <kind> <culpritRegex> [relatedRegex]');
	process.exit(1);
}

let log = await fs.readFile(logFile, 'utf8');
// Machine-specific paths do not matter to the diagnosis; keep fixtures portable.
log = log.replace(/\/home\/[^/\s]+\/[^\s'"\]]*?\/instances\/[\w.-]+/g, '<instance>').replace(/\/home\/[^/\s]+/g, '<home>');

const tokens = new Set(
	[...log.matchAll(/[A-Za-z_$][\w$]*(?:[./][\w$]+){2,}/g)].map((m) => m[0].replace(/\//g, '.'))
);
const prefixes = new Set([...tokens].map((t) => t.split('.').slice(0, 3).join('.')));
const lower = log.toLowerCase();

const jars = [];
for (const jar of await indexMods(modsDir)) {
	const classes = [...jar.classes].filter((c) => prefixes.has(c.split('.').slice(0, 3).join('.')));
	const mentioned =
		classes.length > 0 ||
		jar.ids.some((id) => lower.includes(id)) ||
		jar.names.some((n) => n.length > 3 && lower.includes(n.toLowerCase())) ||
		lower.includes(jar.fileName.toLowerCase());
	if (!mentioned) continue;
	jars.push({
		fileName: jar.fileName,
		enabled: jar.enabled,
		ids: jar.ids,
		names: jar.names,
		clientOnly: jar.clientOnly,
		classes,
		mixinConfigs: jar.mixinConfigs.filter((c) => log.includes(c))
	});
}

await fs.writeFile(path.join(here, 'fixtures', `${name}.log`), log);
await fs.writeFile(path.join(here, 'fixtures', `${name}.mods.json`), JSON.stringify(jars, null, 1));

const casesFile = path.join(here, 'cases.json');
/** @typedef {{ name: string; kind: string; culprit: string; related?: string }} Case */
const cases = /** @type {Case[]} */ (JSON.parse(await fs.readFile(casesFile, 'utf8').catch(() => '[]'))).filter((c) => c.name !== name);
cases.push({ name, kind, culprit, ...(related ? { related } : {}) });
cases.sort((a, b) => a.name.localeCompare(b.name));
await fs.writeFile(casesFile, JSON.stringify(cases, null, '\t') + '\n');
console.log(`${name}: kept ${jars.length} jar(s), ${jars.reduce((n, j) => n + j.classes.length, 0)} class name(s)`);
