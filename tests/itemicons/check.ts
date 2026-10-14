/**
 * The item check (README.md): names and pictures for every item of some
 * vanilla versions and real servers, resolved exactly as the player editor
 * does (iconsFor, itemName, itemChoices), optionally drawn by the page's own
 * renderer in headless Chromium. Run through check.mjs, never on its own.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { iconsFor, itemChoices, itemName, serverResources, type ItemIcon } from '#lib/server/itemicons.js';
import { saveMapSettings } from '#lib/server/worldmap.js';
import { openZipFile } from '#lib/server/zip.js';
import { parseNbt, type Tag } from '#lib/server/nbt.js';
import { compareVersions } from '#lib/server/java.js';
import { DATA_DIR } from '#lib/server/config.js';

/** Oldest to newest, one per code path that differs (item definitions 1.21.4, own egg textures 1.21.5). */
const DEFAULT_VANILLA = ['1.12.2', '1.13.2', '1.16.5', '1.20.1', '1.21.1', '1.21.3', '1.21.4', '1.21.5', 'latest'];
const MCDATA = 'https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data';
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

type Options = {
	vanilla: string[];
	instances: { dir: string; version: string }[];
	world: boolean;
	render: boolean;
	sheets: 'problems' | 'all' | null;
	out: string;
	baseline: string | null;
};

type Spec = ItemIcon['spec'];
type Record_ = {
	key: string;
	id: string;
	damage: number | null;
	mod: string;
	inWorld: number;
	name: string;
	/** Where the name came from: a 1.12 variant's own, the lang files, or the id tidied up. */
	nameFrom: 'variant' | 'lang' | 'id';
	/** minecraft-data's name, vanilla only (its own wording in places: compare by eye). */
	expected?: string;
	spec: Spec;
	exact: boolean;
	/** Texture files the picture names that do not exist. */
	missing: string[];
	/** Visible pixels of the drawn picture (with --render): 0 = drew nothing, -1 = could not be drawn. */
	drawn?: number;
};
type Target = { name: string; version: string; items: Record_[]; picker?: { missing: string[]; extra: string[] } };

function parse(args: string[], cache: string): Options {
	const o: Options = { vanilla: DEFAULT_VANILLA, instances: [], world: false, render: false, sheets: null, out: path.join(cache, 'reports', new Date().toISOString().replace(/[:.]/g, '-')), baseline: null };
	let vanillaGiven = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const next = () => args[++i] ?? '';
		if (a === '--vanilla') {
			const v = next();
			o.vanilla = v === 'none' ? [] : v.split(',');
			vanillaGiven = true;
		} else if (a === '--instance') {
			const [dir, version] = next().split('@');
			if (!version) throw new Error('--instance needs <server folder>@<minecraft version>');
			o.instances.push({ dir: path.resolve(dir), version });
		} else if (a === '--world') o.world = true;
		else if (a === '--render') o.render = true;
		else if (a === '--sheets') {
			o.render = true;
			o.sheets = args[i + 1] === 'all' || args[i + 1] === 'problems' ? (next() as 'all' | 'problems') : 'problems';
		} else if (a === '--out') o.out = path.resolve(next());
		else if (a === '--baseline') o.baseline = path.resolve(next());
		else throw new Error(`Unknown option ${a} (see tests/itemicons/README.md)`);
	}
	// Servers given and no versions: only the servers.
	if (o.instances.length && !vanillaGiven) o.vanilla = [];
	return o;
}

// ------------------------------------------------------------ item lists ---

async function cached(cache: string, name: string, url: string): Promise<string> {
	const file = path.join(cache, 'downloads', name);
	try {
		return await fs.readFile(file, 'utf8');
	} catch {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`${url}: ${res.status}`);
		const text = await res.text();
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, text);
		return text;
	}
}

async function latestRelease(cache: string): Promise<string> {
	// Not cached: "latest" should mean today's.
	const manifest = (await (await fetch(MANIFEST)).json()) as { latest: { release: string } };
	void cache;
	return manifest.latest.release;
}

/** minecraft-data's items for a version (with 1.12's damage variations), or null when it has none. */
async function vanillaItems(cache: string, version: string): Promise<{ name: string; displayName: string; variations?: { metadata: number; displayName: string }[] }[] | null> {
	const paths = JSON.parse(await cached(cache, 'dataPaths.json', `${MCDATA}/dataPaths.json`)) as { pc: Record<string, { items?: string }> };
	const at = paths.pc[version]?.items;
	if (!at) return null;
	return JSON.parse(await cached(cache, `items-${at.replace(/\//g, '_')}.json`, `${MCDATA}/${at}/items.json`));
}

/** Every item stack in a world (region and entity chunks, player files): id@damage -> stacks. Read only. */
async function worldItems(worldDir: string): Promise<Map<string, number>> {
	const found = new Map<string, number>();
	const walk = (tag: Tag, depth = 0): void => {
		if (depth > 64) return;
		if (tag.type === 'compound') {
			const get = (k: string) => tag.value.find(([n]) => n === k)?.[1];
			const id = get('id');
			const count = get('Count') ?? get('count');
			if (id?.type === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id.value) && id.value !== 'minecraft:air' && count && /byte|short|int/.test(count.type)) {
				const dmg = get('Damage');
				const d = dmg && typeof dmg.value === 'number' && dmg.value > 0 ? dmg.value : 0;
				const key = d ? `${id.value}@${d}` : id.value;
				found.set(key, (found.get(key) ?? 0) + 1);
			}
			for (const [, v] of tag.value) walk(v, depth + 1);
		} else if (tag.type === 'list') for (const v of tag.value) walk(v, depth + 1);
	};
	for (const rel of await fs.readdir(worldDir, { recursive: true }).catch(() => [] as string[])) {
		const file = path.join(worldDir, rel);
		if (/(^|\/)playerdata\/[^/]+\.dat$/.test(rel)) {
			try {
				walk(parseNbt(await fs.readFile(file)).root);
			} catch {
				/* unreadable player file */
			}
		} else if (/(^|\/)(region|entities)\/[^/]+\.mca$/.test(rel)) {
			const buf = await fs.readFile(file);
			if (buf.length < 8192) continue;
			for (let i = 0; i < 1024; i++) {
				const off = (buf.readUInt32BE(i * 4) >>> 8) * 4096;
				if (!off || off + 5 > buf.length) continue;
				const len = buf.readUInt32BE(off);
				const body = buf.subarray(off + 5, off + 4 + len);
				try {
					const kind = buf[off + 4];
					walk(parseNbt(kind === 2 ? zlib.inflateSync(body) : kind === 1 ? zlib.gunzipSync(body) : body).root);
				} catch {
					/* a damaged chunk */
				}
			}
		}
	}
	return found;
}

/** Which jar in mods/ ships each namespace's assets. */
async function owners(modsDir: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const jar of (await fs.readdir(modsDir).catch(() => [] as string[])).filter((n) => n.endsWith('.jar')).sort()) {
		const zip = await openZipFile(path.join(modsDir, jar)).catch(() => null);
		for (const e of zip?.entries ?? []) {
			const m = e.name.match(/^assets\/([^/]+)\//);
			if (m && !out.has(m[1])) out.set(m[1], jar.replace(/\.jar$/, ''));
		}
	}
	return out;
}

// --------------------------------------------------------------- resolve ---

const texturesOf = (spec: Spec): string[] =>
	!spec
		? []
		: spec.kind === 'flat'
			? spec.layers.flatMap((l) => [l.texture, ...(l.mask ? [l.mask] : [])])
			: [...spec.elements.flatMap((e) => Object.values(e.faces).map((f) => f!.texture)), ...(spec.quads ?? []).map((q) => q.face.texture)];

async function check(o: Options, cache: string, target: { name: string; dir: string | null; version: string }): Promise<{ target: Target; textures: Record<string, string> }> {
	const id = `check-${target.name}`;
	let dir = target.dir;
	if (!dir) {
		dir = path.join(DATA_DIR, 'vanilla', target.version);
		await fs.mkdir(path.join(dir, 'mods'), { recursive: true });
	}
	saveMapSettings(id, { eulaAccepted: true });
	const instance = { id, path: dir, minecraftVersion: target.version } as never;
	const res = await serverResources(instance);
	const lang = await res.lang();
	const langValues = new Set(lang.values());
	const old = compareVersions(target.version, '1.13') < 0;

	// What to look at: minecraft-data's list for vanilla, the picker's list and the world for a server.
	const wanted = new Map<string, { id: string; damage: number | null; inWorld: number; expected?: string }>();
	const add = (key: string, inWorld = 0, expected?: string) => {
		const [iid, d] = key.split('@');
		// As the page sends it: 1.12 items always carry their damage, newer ones none.
		const damage = d ? Number(d) : old ? 0 : null;
		const k = damage ? `${iid}@${damage}` : iid;
		const prev = wanted.get(k);
		wanted.set(k, { id: iid, damage, inWorld: (prev?.inWorld ?? 0) + inWorld, expected: expected ?? prev?.expected });
	};
	const choices = await itemChoices(instance);
	const listed = target.dir ? null : await vanillaItems(cache, target.version);
	if (listed) {
		for (const item of listed) {
			if (item.name === 'air') continue;
			if (item.variations?.length) for (const v of item.variations) add(`minecraft:${item.name}${v.metadata ? `@${v.metadata}` : ''}`, 0, v.displayName);
			else add(`minecraft:${item.name}`, 0, item.displayName);
		}
	} else for (const c of choices) if (c.id !== 'minecraft:air') add(c.id);
	if (target.dir && o.world) {
		const level = (await fs.readFile(path.join(dir, 'server.properties'), 'utf8').catch(() => '')).match(/^level-name=(.*)$/m)?.[1]?.trim() || 'world';
		for (const [k, n] of await worldItems(path.join(dir, level))) add(k, n);
	}

	const list = [...wanted.values()];
	const icons: Record<string, ItemIcon> = {};
	for (let i = 0; i < list.length; i += 400) Object.assign(icons, (await iconsFor(instance, list.slice(i, i + 400))).icons);
	const mods = await owners(path.join(dir, 'mods'));
	const textures: Record<string, string> = {};
	const items: Record_[] = [];
	for (const w of list) {
		const key = w.damage ? `${w.id}@${w.damage}` : w.id;
		const icon = icons[key] ?? { spec: null, exact: true };
		const ns = w.id.split(':')[0];
		const name = icon.name ?? itemName(w.id, lang);
		const missing: string[] = [];
		for (const t of new Set(texturesOf(icon.spec))) {
			const [tns, p] = t.split(':');
			const png = await res.read(`${tns}/textures/${p}.png`);
			if (!png) missing.push(t);
			else if (o.render) textures[t] ??= `data:image/png;base64,${png.toString('base64')}`;
		}
		items.push({
			key,
			id: w.id,
			damage: w.damage,
			mod: ns === 'minecraft' ? 'minecraft' : (mods.get(ns) ?? ns),
			inWorld: w.inWorld,
			name,
			// A lang template's gaps show as "…": still the lang file's name.
			nameFrom: icon.name ? 'variant' : langValues.has(name) || name.includes('…') ? 'lang' : 'id',
			...(w.expected ? { expected: w.expected } : {}),
			spec: icon.spec,
			exact: icon.exact,
			missing
		});
	}
	let picker: Target['picker'];
	if (listed) {
		const offered = new Set(choices.map((c) => c.id));
		const ids = new Set(list.map((w) => w.id));
		picker = { missing: [...ids].filter((x) => !offered.has(x)), extra: [...offered].filter((x) => x.startsWith('minecraft:') && !ids.has(x)) };
	}
	return { target: { name: target.name, version: target.version, items, ...(picker ? { picker } : {}) }, textures };
}

// ---------------------------------------------------------------- render ---

async function chromium(): Promise<string> {
	if (process.env.CHROME) return process.env.CHROME;
	const home = process.env.HOME ?? '';
	for (const pattern of [`${home}/.cache/ms-playwright/chromium_headless_shell-*/*/headless_shell`, `${home}/.cache/ms-playwright/chromium-*/*/chrome`]) {
		const [found] = await Array.fromAsync(fs.glob(pattern));
		if (found) return found;
	}
	for (const name of ['chromium', 'chromium-browser', 'google-chrome']) {
		for (const dir of (process.env.PATH ?? '').split(':')) {
			const file = path.join(dir, name);
			if (await fs.access(file).then(() => true, () => false)) return file;
		}
	}
	throw new Error('--render needs Chromium: set CHROME, or install one (npx playwright install chromium-headless-shell).');
}

const PAGE = `<!doctype html><meta charset="utf-8"><body><script type="module">
import { renderIcon } from './itemicon.js';
const q = new URLSearchParams(location.search);
const post = (p, b) => fetch(p, { method: 'POST', body: typeof b === 'string' ? b : JSON.stringify(b) });
try {
	const items = await (await fetch('/items/' + q.get('target'))).json();
	const tex = await (await fetch('/textures/' + q.get('target'))).json();
	const url = (ref) => tex[ref] ?? 'data:,missing';
	const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = u; });
	const c = document.createElement('canvas'); c.width = c.height = 64;
	const ctx = c.getContext('2d', { willReadFrequently: true });
	const drawn = {}, pictures = {};
	for (const it of items) {
		if (!it.spec) continue;
		const u = await renderIcon(it.spec, url).catch(() => null);
		if (!u) { drawn[it.key] = it.missing.length ? -1 : 0; continue; }
		const img = await load(u); ctx.clearRect(0, 0, 64, 64); ctx.drawImage(img, 0, 0);
		const d = ctx.getImageData(0, 0, 64, 64).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 16) n++;
		drawn[it.key] = n; pictures[it.key] = img;
	}
	await post('/drawn/' + q.get('target'), drawn);
	// Contact sheets, 100 a page: every item, or the problems (guessed, broken or drawing nothing).
	const mode = q.get('sheets');
	const chosen = mode === 'all' ? items : mode === 'problems' ? items.filter((it) => it.spec && (!it.exact || !(drawn[it.key] > 0))) : [];
	const sheets = [];
	for (let i = 0; i < chosen.length; i += 100) sheets.push(chosen.slice(i, i + 100).map((it) => it.key));
	for (const [i, keys] of sheets.entries()) {
		const byKey = new Map(items.map((x) => [x.key, x]));
		const cols = 10, cw = 150, ch = 96, s = document.createElement('canvas');
		s.width = cols * cw; s.height = Math.ceil(keys.length / cols) * ch;
		const g = s.getContext('2d'); g.fillStyle = '#8b8b8b'; g.fillRect(0, 0, s.width, s.height);
		g.font = '10px sans-serif'; g.textAlign = 'center'; g.imageSmoothingEnabled = false;
		keys.forEach((k, j) => {
			const it = byKey.get(k), x = (j % cols) * cw, y = Math.floor(j / cols) * ch;
			g.fillStyle = it && !it.exact ? '#e0c060' : '#c6c6c6'; g.fillRect(x + cw / 2 - 34, y + 2, 68, 68);
			if (pictures[k]) g.drawImage(pictures[k], x + cw / 2 - 32, y + 4, 64, 64);
			g.fillStyle = '#000'; g.fillText((it?.name ?? '?').slice(0, 26), x + cw / 2, y + 80);
			g.fillStyle = '#222'; g.fillText(k.slice(0, 28), x + cw / 2, y + 91);
		});
		await post('/sheet/' + q.get('target') + '-' + i, s.toDataURL('image/png'));
	}
} catch (e) { await post('/error', String(e?.stack ?? e)); }
await post('/done', '');
</script>`;

async function render(o: Options, repo: string, target: Target, textures: Record<string, string>): Promise<string[]> {
	const work = path.join(o.out, '.render');
	await fs.mkdir(work, { recursive: true });
	// esbuild is CommonJS, which Vite's module runner does not load.
	const esbuild = createRequire(path.join(repo, 'package.json'))('esbuild') as typeof import('esbuild');
	await esbuild.build({ entryPoints: [path.join(repo, 'src/lib/shared/itemicon.svelte.ts')], bundle: true, format: 'esm', loader: { '.ts': 'ts' }, outfile: path.join(work, 'itemicon.js'), logLevel: 'silent' });
	const items = target.items.map(({ key, name, spec, exact, missing }) => ({ key, name, spec, exact, missing }));
	const written: string[] = [];
	const browser = await chromium();
	await new Promise<void>((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://x');
			if (req.method === 'POST') {
				const chunks: Buffer[] = [];
				req.on('data', (c) => chunks.push(c));
				req.on('end', async () => {
					const body = Buffer.concat(chunks).toString();
					res.end();
					if (url.pathname === '/done') {
						child.kill();
						server.close();
						resolve();
					} else if (url.pathname === '/error') reject(new Error(body));
					else if (url.pathname.startsWith('/drawn/')) for (const [k, n] of Object.entries(JSON.parse(body) as Record<string, number>)) target.items.find((i) => i.key === k)!.drawn = n;
					else if (url.pathname.startsWith('/sheet/')) {
						const file = path.join(o.out, `${path.basename(url.pathname)}.png`);
						await fs.writeFile(file, Buffer.from(body.split(',')[1], 'base64'));
						written.push(file);
					}
				});
				return;
			}
			const send = (type: string, body: string | Buffer) => {
				res.setHeader('content-type', type);
				res.end(body);
			};
			if (url.pathname === '/page.html') send('text/html', PAGE);
			else if (url.pathname === '/itemicon.js') fs.readFile(path.join(work, 'itemicon.js')).then((b) => send('text/javascript', b));
			else if (url.pathname.startsWith('/items/')) send('application/json', JSON.stringify(items));
			else if (url.pathname.startsWith('/textures/')) send('application/json', JSON.stringify(textures));
			else {
				res.statusCode = 404;
				res.end();
			}
		});
		let child: ReturnType<typeof spawn>;
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as { port: number };
			const query = new URLSearchParams({ target: target.name, sheets: o.sheets ?? '' });
			child = spawn(browser, ['--headless', '--no-sandbox', '--disable-gpu', `--user-data-dir=${path.join(work, 'profile')}`, `http://127.0.0.1:${port}/page.html?${query}`], { stdio: 'ignore' });
			child.on('exit', (code) => code && reject(new Error(`Chromium exited with ${code}`)));
		});
	});
	return written;
}

// ---------------------------------------------------------------- report ---

const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : '-');
/** No picture, or one that draws nothing; without --render, one whose every texture is missing. */
const noPicture = (i: Record_) => !i.spec || (i.drawn !== undefined ? i.drawn <= 0 : i.missing.length > 0 && i.missing.length === new Set(texturesOf(i.spec)).size);
/** Drawn, but some of its textures are missing (often: textures of a mod that is not installed). */
const partial = (i: Record_) => !noPicture(i) && i.missing.length > 0;

function summary(t: Target): string[] {
	const out: string[] = [];
	const n = t.items.length;
	const none = t.items.filter((i) => !i.spec).length;
	const broken = t.items.filter((i) => i.spec && noPicture(i)).length;
	const partly = t.items.filter(partial).length;
	const guessed = t.items.filter((i) => i.spec && !i.exact).length;
	const fromId = t.items.filter((i) => i.nameFrom === 'id').length;
	out.push(`${t.name} (${t.version}): ${n} items | no picture ${none} (${pct(none, n)}) | draws nothing ${broken} | textures missing ${partly} | guessed ${guessed} | named from the id ${fromId}`);
	const names = t.items.filter((i) => i.expected && i.expected.replace(/\s+/g, ' ') !== i.name.replace(/\s+/g, ' '));
	if (names.length) out.push(`  names unlike minecraft-data's (${names.length}; it has wordings of its own): ${names.slice(0, 12).map((i) => `${i.key} "${i.name}" vs "${i.expected}"`).join('; ')}${names.length > 12 ? ' ...' : ''}`);
	const bad = t.items.filter((i) => i.mod === 'minecraft' && noPicture(i));
	if (bad.length) out.push(`  vanilla without a picture: ${bad.map((i) => i.key).join(' ')}`);
	if (t.picker && (t.picker.missing.length || t.picker.extra.length)) out.push(`  picker: missing ${t.picker.missing.length} (${t.picker.missing.slice(0, 8).join(' ')}), not items ${t.picker.extra.length} (${t.picker.extra.slice(0, 8).join(' ')})`);
	const inWorld = t.items.filter((i) => i.inWorld);
	if (inWorld.length) {
		const stacks = inWorld.reduce((a, i) => a + i.inWorld, 0);
		const missing = inWorld.filter(noPicture).reduce((a, i) => a + i.inWorld, 0);
		out.push(`  in the world: ${inWorld.length} kinds, ${stacks} stacks, ${pct(missing, stacks)} of stacks without a picture`);
	}
	const mods = new Map<string, { n: number; none: number; guessed: number; fromId: number }>();
	for (const i of t.items) {
		if (i.mod === 'minecraft') continue;
		const m = mods.get(i.mod) ?? { n: 0, none: 0, guessed: 0, fromId: 0 };
		m.n++;
		if (noPicture(i)) m.none++;
		if (i.spec && !i.exact) m.guessed++;
		if (i.nameFrom === 'id') m.fromId++;
		mods.set(i.mod, m);
	}
	if (mods.size) {
		out.push('  mods with the most items without a picture (items | no picture | guessed | named from the id):');
		for (const [mod, m] of [...mods].sort((a, b) => b[1].none - a[1].none).slice(0, 25)) out.push(`    ${mod.slice(0, 48).padEnd(48)} ${String(m.n).padStart(6)} ${String(m.none).padStart(6)} (${pct(m.none, m.n)}) ${String(m.guessed).padStart(6)} ${String(m.fromId).padStart(6)}`);
	}
	return out;
}

/** What changed since an earlier run: pictures lost or gained, names changed. */
function compare(t: Target, before: Target): string[] {
	const old = new Map(before.items.map((i) => [i.key, i]));
	const lost: string[] = [];
	const gained: string[] = [];
	const renamed: string[] = [];
	let redrawn = 0;
	for (const i of t.items) {
		const b = old.get(i.key);
		if (!b) continue;
		if (!noPicture(b) && noPicture(i)) lost.push(i.key);
		if (noPicture(b) && !noPicture(i)) gained.push(i.key);
		if (b.name !== i.name) renamed.push(`${i.key}: "${b.name}" -> "${i.name}"`);
		else if (JSON.stringify(b.spec) !== JSON.stringify(i.spec)) redrawn++;
	}
	const out = [`  since the baseline: ${gained.length} more with a picture, ${lost.length} lost one, ${renamed.length} renamed, ${redrawn} drawn differently`];
	if (lost.length) out.push(`    lost: ${lost.slice(0, 30).join(' ')}${lost.length > 30 ? ' ...' : ''}`);
	if (renamed.length) out.push(`    renamed: ${renamed.slice(0, 20).join('; ')}${renamed.length > 20 ? ' ...' : ''}`);
	return out;
}

export async function main(args: string[], { repo, cache }: { repo: string; cache: string }): Promise<number> {
	const o = parse(args, cache);
	await fs.mkdir(o.out, { recursive: true });
	const targets: { name: string; dir: string | null; version: string }[] = [];
	for (const v of o.vanilla) {
		const version = v === 'latest' ? await latestRelease(cache) : v;
		targets.push({ name: `vanilla-${version}`, dir: null, version });
	}
	for (const i of o.instances) targets.push({ name: path.basename(i.dir), dir: i.dir, version: i.version });
	if (!targets.length) throw new Error('Nothing to check (see tests/itemicons/README.md).');
	let lostAny = false;
	for (const spec of targets) {
		const started = Date.now();
		const { target, textures } = await check(o, cache, spec);
		const sheets = o.render ? await render(o, repo, target, textures) : [];
		await fs.writeFile(path.join(o.out, `${target.name}.json`), JSON.stringify(target));
		console.log(summary(target).join('\n'));
		if (o.baseline) {
			const before = await fs.readFile(path.join(o.baseline, `${target.name}.json`), 'utf8').then((t) => JSON.parse(t) as Target, () => null);
			if (before) {
				const diff = compare(target, before);
				lostAny ||= diff.length > 1 && diff[1].startsWith('    lost');
				console.log(diff.join('\n'));
			} else console.log('  (not in the baseline)');
		}
		if (sheets.length) console.log(`  sheets: ${sheets.join(' ')}`);
		console.log(`  ${((Date.now() - started) / 1000).toFixed(1)} s`);
	}
	await fs.rm(path.join(o.out, '.render'), { recursive: true, force: true });
	console.log(`\nReport: ${o.out} (pass it as --baseline next time to see what changed)`);
	return lostAny ? 2 : 0;
}
