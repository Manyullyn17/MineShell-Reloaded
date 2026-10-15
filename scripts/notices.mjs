#!/usr/bin/env node
/**
 * Writes THIRD-PARTY-NOTICES: the license of every package a release carries,
 * so their notices travel with MineShell as their licenses ask. That is the
 * runtime dependencies (in the archive's node_modules) and the code the build
 * compiles in (Svelte, SvelteKit, the node adapter), each with what they
 * depend on. Some of those are only used while building; listing them too is
 * harmless, missing one is not.
 *
 *   node scripts/notices.mjs <output file>
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = process.argv[2];
if (!out) {
	console.error('Usage: node scripts/notices.mjs <output file>');
	process.exit(1);
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const own = readJson(path.join(root, 'package.json'));
const compiledIn = ['svelte', '@sveltejs/kit', '@sveltejs/adapter-node'];

/** Node's lookup: the package's own node_modules, then each folder above it. */
function locate(name, fromDir) {
	for (let dir = fromDir; ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, 'node_modules', name);
		if (existsSync(path.join(candidate, 'package.json'))) return candidate;
		if (dir === root || dir === path.dirname(dir)) return null;
	}
}

const found = new Map();
function visit(name, fromDir, optional) {
	const dir = locate(name, fromDir);
	if (!dir) {
		if (!optional) throw new Error(`${name} is not installed: run npm ci first.`);
		return;
	}
	if (found.has(dir)) return;
	const pkg = readJson(path.join(dir, 'package.json'));
	found.set(dir, pkg);
	for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir, false);
	for (const dep of Object.keys(pkg.optionalDependencies ?? {})) visit(dep, dir, true);
}
for (const name of Object.keys(own.dependencies ?? {})) visit(name, root, false);
for (const name of compiledIn) visit(name, root, false);

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;
const sections = [...found]
	.map(([dir, pkg]) => {
		const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
		const texts = files.map((f) => readFileSync(path.join(dir, f), 'utf8').trim());
		const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see the package');
		return { title: `${pkg.name} ${pkg.version} (${license})`, body: texts.join('\n\n') || `Licensed under ${license}; the package carries no license file.` };
	})
	.sort((a, b) => a.title.localeCompare(b.title));

const header = `Third-party software in MineShell ${own.version}

MineShell itself is under the MIT license (LICENSE). It carries the following
packages, under their own licenses. better-sqlite3 contains SQLite, which is
in the public domain.
`;
writeFileSync(out, [header, ...sections.map((s) => `${'='.repeat(78)}\n${s.title}\n${'='.repeat(78)}\n\n${s.body}\n`)].join('\n'));
console.log(`${out}: ${sections.length} packages`);
