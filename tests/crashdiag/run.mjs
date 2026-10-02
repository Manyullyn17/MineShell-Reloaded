// Regression test for src/lib/server/crashdiag.ts against recorded crashes.
//
//   node --experimental-strip-types tests/crashdiag/run.mjs        (or: npm run test:crashdiag)
//
// A case passes when the expected diagnosis is listed first and marked fatal.
import fs from 'node:fs/promises';
import path from 'node:path';
import { diagnoseLog } from '../../src/lib/server/crashdiag.ts';

const here = path.dirname(new URL(import.meta.url).pathname);
const cases = JSON.parse(await fs.readFile(path.join(here, 'cases.json'), 'utf8'));
const verbose = process.argv.includes('-v');

let failed = 0;
for (const c of cases) {
	const log = await fs.readFile(path.join(here, 'fixtures', `${c.name}.log`), 'utf8');
	const mods = JSON.parse(await fs.readFile(path.join(here, 'fixtures', `${c.name}.mods.json`), 'utf8')).map(
		(j) => ({ ...j, classes: new Set(j.classes) })
	);
	const diags = diagnoseLog(log, mods);
	const top = diags[0];
	const ok =
		!!top &&
		top.fatal &&
		top.kind === c.kind &&
		new RegExp(c.culprit, 'i').test(top.culprit?.name ?? '') &&
		(!c.related || new RegExp(c.related, 'i').test(`${top.related?.name ?? ''} ${top.related?.fileName ?? ''}`));
	if (!ok) failed++;
	const shown = verbose || !ok ? diags.map((d) => `${d.fatal ? '' : '(non-fatal) '}[${d.kind}] ${d.title}`).join(' | ') : top.title;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(34)} ${shown || '(nothing found)'}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
