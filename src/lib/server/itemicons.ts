import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerInstance } from './db/schema';
import { CACHE_DIR } from './config';
import { downloadFile } from './download';
import { minecraftClientDownload } from './modloaders';
import { DISABLED_SUFFIX, modsDir } from './mods';
import { getMapSettings } from './worldmap';
import { openZipFile } from './zip';
import { child, parseNbt, str } from './nbt';
import { compareVersions } from './java';
import { serverWorldName } from './packworld';
import { bannerIcon, bedIcon, chestIcon, conduitIcon, decoratedPotIcon, headIcon, statueIcon, type HeadKind } from './entityicons';

/**
 * Item icons for the player editor (ROADMAP, "Item icons in the player
 * editor"). Textures and models are Mojang's and the mods' own, so nothing is
 * shipped: they are read from the server's mod jars and from the Minecraft
 * client jar, downloaded once per version into the cache - only once the
 * server's EULA question (shared with the Map tab) has been answered yes.
 *
 * An item resolves to an IconSpec the browser draws: flat layers (most
 * items) or a block's boxes with a texture per face (3D, as in the
 * inventory). What Minecraft draws in code (chests, beds, heads: "builtin/
 * entity", 1.21.4's "special") has no spec, and keeps its name as text.
 *
 * 1.12 and older: many items are one id with variants by damage. Vanilla's
 * are in a table here; a mod's mapping lives in its code, so the usual model
 * names are tried and a variant found that way, or the base model used in
 * its place, is reported as not exact (the user's call: best guess, flagged).
 */

export const CLIENT_DIR = path.join(CACHE_DIR, 'minecraft-client');

export type FaceSpec = { texture: string; uv: [number, number, number, number]; tint: string | null };
export type Side = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
/** The sides block models are drawn with: the bottom never shows from above. */
type ModelSide = Exclude<Side, 'down'>;
export type ElementSpec = {
	from: [number, number, number];
	to: [number, number, number];
	/** Which ones show depends on the rotation (block models leave the bottom out: it never does). */
	faces: Partial<Record<Side, FaceSpec>>;
};
/**
 * One face of a model the game draws in code (entityicons.ts), placed: the
 * corners its texture's top left, top right and bottom left go on, and which
 * way it faces.
 */
export type Quad = {
	corners: [[number, number, number], [number, number, number], [number, number, number]];
	normal: [number, number, number];
	face: FaceSpec;
	/** The box it belongs to: boxes are drawn back to front as wholes. */
	group: number;
};
export type IconSpec =
	| { kind: 'flat'; layers: { texture: string; tint: string | null }[] }
	/**
	 * `rotation`: the model's inventory view, degrees about x, y, z as the game applies them;
	 * `scale`: the size against a block's (1); `center`: the point drawn in the middle (8, 8, 8).
	 */
	| {
			kind: 'block';
			elements: ElementSpec[];
			quads?: Quad[];
			rotation: [number, number, number];
			scale?: number;
			center?: [number, number, number];
	  };

/** Minecraft's block/block.json: how blocks are turned in the inventory, unless a model says otherwise (stairs: 135). */
const GUI_ROTATION: [number, number, number] = [30, 225, 0];

/**
 * Shulker boxes are drawn in code too (ShulkerModel, the same box layout as
 * the chests): a 16x12x16 lid at texture (0,0) over a 16x8x16 base at (0,28),
 * the base's top half inside the lid. The lid's lowest rows have holes the
 * base shows through, so the base is the whole 8 high box, set back a hair so
 * the lid's faces are in front of it. Turned as the item's model says (30, 45).
 */
function shulkerSpec(texture: string): IconSpec {
	const face = (u1: number, v1: number, u2: number, v2: number): FaceSpec => ({ texture, uv: [u1 / 4, v1 / 4, u2 / 4, v2 / 4], tint: null });
	const sides = (top: number, bottom: number) => ({
		west: face(0, top, 16, bottom),
		south: face(16, top, 32, bottom),
		east: face(32, top, 48, bottom),
		north: face(48, top, 64, bottom)
	});
	return {
		kind: 'block',
		elements: [
			{ from: [0.05, 0, 0.05], to: [15.95, 8, 15.95], faces: sides(44, 52) },
			{ from: [0, 4, 0], to: [16, 16, 16], faces: { up: face(16, 0, 32, 16), ...sides(16, 28) } }
		],
		rotation: [30, 45, 0]
	};
}

/** A shulker box by its entity texture (shulker_red; the undyed one is shulker, 1.12's light gray shulker_silver). */
function vanillaShulker(res: Resources, texture: string): IconSpec | null {
	return res.has(`minecraft/textures/entity/shulker/${texture}.png`) ? shulkerSpec(`minecraft:entity/shulker/${texture}`) : null;
}

/**
 * The shield, drawn in code as well (ShieldModel): a 12x22x1 plate at texture
 * (0,0) and a 2x6x6 handle at (26,0) behind it, in the same box layout; the
 * front is the plate's (1,1) square. The item's view is (15, -25, -5); the
 * turn here (220: the front turned about 50 degrees, its edge and the handle
 * showing on the right) was matched to the game's icon by eye (the user's
 * screenshot, 2026-10-09), as the -5 about z is left out.
 */
function shieldSpec(texture: string): IconSpec {
	const face = (u1: number, v1: number, u2: number, v2: number): FaceSpec => ({ texture, uv: [u1 / 4, v1 / 4, u2 / 4, v2 / 4], tint: null });
	return {
		kind: 'block',
		elements: [
			{
				from: [7, 5, 7],
				to: [9, 11, 13],
				faces: { up: face(32, 0, 34, 6), east: face(26, 6, 32, 12), north: face(32, 6, 34, 12), west: face(34, 6, 40, 12), south: face(40, 6, 42, 12) }
			},
			{
				from: [2, -3, 6],
				to: [14, 19, 7],
				faces: { up: face(1, 0, 13, 1), east: face(0, 1, 1, 23), north: face(1, 1, 13, 23), west: face(13, 1, 14, 23), south: face(14, 1, 26, 23) }
			}
		],
		rotation: [15, 220, 0]
	};
}

/** The plain shield's texture: entity/ before 26.x, entity/shield/ since. */
function vanillaShield(res: Resources): IconSpec | null {
	for (const texture of ['entity/shield/shield_base_nopattern', 'entity/shield_base_nopattern']) {
		if (res.has(`minecraft/textures/${texture}.png`)) return shieldSpec(`minecraft:${texture}`);
	}
	return null;
}

/** 1.12's numbered variants of code-drawn items: skulls by kind, banners by dye number (black first), beds by colour (white first). */
const SKULLS_112: HeadKind[] = ['skeleton', 'wither_skeleton', 'zombie', 'player', 'creeper', 'dragon'];
const COLOURS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const HEAD_ITEMS: Record<string, HeadKind> = {
	skeleton_skull: 'skeleton',
	wither_skeleton_skull: 'wither_skeleton',
	zombie_head: 'zombie',
	player_head: 'player',
	creeper_head: 'creeper',
	piglin_head: 'piglin',
	dragon_head: 'dragon'
};

/**
 * Vanilla items drawn in code from entity models (entityicons.ts), by their
 * 1.21.4+ special model or, before item definitions, by id and 1.12 damage.
 */
function entityItem(res: Resources, special: Record<string, unknown> | null, itemPath: string, damage: number | null): IconSpec | null | undefined {
	const has = (texture: string) => res.has(`minecraft/textures/${texture}.png`);
	// 1.12 calls light gray silver.
	const colourTexture = (dir: string, colour: string) => (has(`${dir}/${colour}`) || colour !== 'light_gray' ? colour : 'silver');
	if (special) {
		const type = String(special.type).replace(/^minecraft:/, '');
		const field = (key: string) => (typeof special[key] === 'string' ? split(special[key] as string)[1] : '');
		if (type === 'head') return headIcon(field('kind') as HeadKind, has);
		if (type === 'player_head') return headIcon('player', has);
		if (type === 'banner') return bannerIcon(field('color'), has);
		if (type === 'bed') return bedIcon(field('texture'), has);
		if (type === 'conduit') return conduitIcon(has);
		if (type === 'decorated_pot') return decoratedPotIcon(has);
		if (type === 'copper_golem_statue') return statueIcon(field('texture').replace(/^textures\//, '').replace(/\.png$/, ''), has);
		return undefined;
	}
	if (HEAD_ITEMS[itemPath]) return headIcon(HEAD_ITEMS[itemPath], has);
	if (itemPath === 'skull') return headIcon(SKULLS_112[damage ?? 0] ?? 'skeleton', has);
	if (itemPath === 'conduit') return conduitIcon(has);
	if (itemPath === 'decorated_pot') return decoratedPotIcon(has);
	const banner = itemPath === 'banner' ? [...COLOURS].reverse()[damage ?? 0] : itemPath.match(/^(\w+)_banner$/)?.[1];
	if (banner && DYE_NAMES.has(banner)) return bannerIcon(banner, has);
	const bed = itemPath === 'bed' ? COLOURS[damage ?? 0] : itemPath.match(/^(\w+)_bed$/)?.[1];
	if (bed && DYE_NAMES.has(bed)) return bedIcon(colourTexture('entity/bed', bed), has);
	return undefined;
}
const DYE_NAMES = new Set(COLOURS);

/** Vanilla's code-drawn chests before 1.21.4's item definitions, by their entity texture. */
const CHESTS: Record<string, string> = { chest: 'normal', trapped_chest: 'trapped', ender_chest: 'ender' };

function vanillaChest(res: Resources, texture: string): IconSpec | null {
	if (!res.has(`minecraft/textures/entity/chest/${texture}.png`)) return null;
	return chestIcon(`minecraft:entity/chest/${texture}`, res.has('minecraft/textures/entity/chest/normal_left.png'));
}
/**
 * `exact`: false when the picture is a guess. `variant`: the 1.12 damage value
 * picks a variant (vanilla's table, a mod's variant model), rather than being
 * wear - what the tooltip calls it.
 */
/**
 * `variantOf`: the 1.12 variant the damage picked, by its own name (a
 * blockstate's `type` value like `jsu`, or the model's name); `name`: that
 * variant's English name, when the lang files have it (iconsFor).
 */
export type ItemIcon = { spec: IconSpec | null; exact: boolean; variant?: boolean; variantOf?: string; name?: string };

// ------------------------------------------------------------- resources ---

/** Reads one indexed file, from a jar or a folder. */
type Source = () => Promise<Buffer | null>;

/** `<namespace>/<path>` keys for what is indexed: models, item definitions, textures, blockstates and the English lang file. */
function indexKey(ns: string, rest: string): string | null {
	if (/^(?:models|items|textures|blockstates)\/.+\.(?:json|png)$/.test(rest)) return `${ns}/${rest}`;
	if (/^lang\/en_us\.(?:json|lang)$/i.test(rest)) return `${ns}/${rest.toLowerCase()}`;
	return null;
}

/**
 * Every model, item definition and texture the server's jars hold, by
 * `<namespace>/<kind>/<path>` (`minecraft/models/item/diamond.json`). The
 * pack's own asset folders first (they override mods in the game), then mods,
 * vanilla last; the first to have a file wins.
 */
export class Resources {
	private constructor(
		private readonly files: Map<string, Source>,
		/** Every English lang file, in the same order: the game merges them key by key. */
		private readonly langs: { json: boolean; read: Source }[],
		readonly hasVanilla: boolean
	) {}

	/** `dirs` hold namespace folders (`<dir>/<namespace>/textures/...`), as a pack's resources/ or kubejs/assets/ does. */
	static async load(jars: string[], clientJar: string | null, dirs: string[] = []): Promise<Resources> {
		const files = new Map<string, Source>();
		const langs: { json: boolean; read: Source }[] = [];
		const add = (key: string | null, read: Source) => {
			if (!key) return;
			if (/\/lang\/en_us\.(json|lang)$/.test(key)) langs.push({ json: key.endsWith('.json'), read });
			else if (!files.has(key)) files.set(key, read);
		};
		for (const dir of dirs) {
			const found = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[]);
			for (const rel of found.sort()) {
				const [ns, ...rest] = rel.split(path.sep);
				add(rest.length ? indexKey(ns, rest.join('/')) : null, () => fs.readFile(path.join(dir, rel)).catch(() => null));
			}
		}
		for (const jar of clientJar ? [...jars, clientJar] : jars) {
			const zip = await openZipFile(jar).catch(() => null);
			if (!zip) continue;
			for (const entry of zip.entries) {
				const m = entry.name.match(/^assets\/([^/]+)\/(.+)$/);
				add(m && indexKey(m[1], m[2]), () => zip.read(entry));
			}
		}
		return new Resources(files, langs, !!clientJar);
	}

	has(key: string): boolean {
		return this.files.has(key);
	}

	private nestedIndex: Map<string, string[]> | undefined;

	/**
	 * Item models in subfolders, by `<namespace>/<file name>`
	 * (aoa3's models/item/weapons/bows/predatious_bow): model refs. Built once.
	 */
	nestedItemModels(ns: string, name: string): string[] {
		if (!this.nestedIndex) {
			this.nestedIndex = new Map();
			for (const key of this.files.keys()) {
				const m = key.match(/^([^/]+)\/models\/(item\/.+\/([^/]+))\.json$/);
				if (!m) continue;
				const at = `${m[1]}/${m[3]}`;
				this.nestedIndex.set(at, [...(this.nestedIndex.get(at) ?? []), `${m[1]}:${m[2]}`]);
			}
		}
		return this.nestedIndex.get(`${ns}/${name}`) ?? [];
	}

	private numberedIndex: Map<string, Map<number, string>> | undefined;

	/**
	 * Item textures named with a number (`projecte/.../stars/klein_star_6`,
	 * `enderutilities/.../handybag_1`), by `<namespace>/<name without it>`:
	 * number -> texture ref. Built once.
	 */
	numbered(ns: string, name: string): Map<number, string> | undefined {
		if (!this.numberedIndex) {
			this.numberedIndex = new Map();
			for (const key of this.files.keys()) {
				const m = key.match(/^([^/]+)\/textures\/(items?\/(?:.+\/)?([^/]+)_(\d+))\.png$/);
				if (!m) continue;
				const at = `${m[1]}/${m[3]}`;
				if (!this.numberedIndex.has(at)) this.numberedIndex.set(at, new Map());
				this.numberedIndex.get(at)!.set(Number(m[4]), `${m[1]}:${m[2]}`);
			}
		}
		return this.numberedIndex.get(`${ns}/${name}`);
	}

	async read(key: string): Promise<Buffer | null> {
		return (await this.files.get(key)?.()) ?? null;
	}

	async json(key: string): Promise<Record<string, unknown> | null> {
		const data = await this.read(key);
		if (!data) return null;
		try {
			return JSON.parse(data.toString('utf8').replace(/^﻿/, ''));
		} catch {
			return null;
		}
	}

	/**
	 * Item ids for the picker, `ns:path`: a namespace's 1.21.4+ item
	 * definitions where it has them (exactly the items), else its item models
	 * minus the shared bases models are built on.
	 */
	itemNames(): string[] {
		const defined = new Set<string>();
		const modelled = new Set<string>();
		for (const key of this.files.keys()) {
			const def = key.match(/^([^/]+)\/items\/([^/.]+)\.json$/);
			if (def) defined.add(`${def[1]}:${def[2]}`);
			const model = key.match(/^([^/]+)\/models\/item\/([^/.]+)\.json$/);
			if (model && !/^(generated|handheld|handheld_rod|template_.*|.*_template)$/.test(model[2])) modelled.add(`${model[1]}:${model[2]}`);
		}
		const withDefinitions = new Set([...defined].map((id) => id.split(':')[0]));
		return [...defined, ...[...modelled].filter((id) => !withDefinitions.has(id.split(':')[0]))].sort();
	}

	/** Every en_us line of every jar and asset folder: 1.13+'s JSON and 1.12's .lang. The first to set a key wins. */
	lang(): Promise<Map<string, string>> {
		// Read once: every variant's name looks in it, and a big pack has ~100k lines.
		return (this.langRead ??= this.readLang());
	}

	private langRead: Promise<Map<string, string>> | undefined;

	private async readLang(): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		for (const { json, read } of this.langs) {
			const text = (await read())?.toString('utf8').replace(/^\uFEFF/, '') ?? '';
			if (json) {
				try {
					for (const [k, v] of Object.entries(JSON.parse(text) as Record<string, unknown>)) if (typeof v === 'string' && !out.has(k)) out.set(k, v);
				} catch {
					/* not JSON after all */
				}
			} else {
				for (const line of text.split(/\r?\n/)) {
					const at = line.indexOf('=');
					// Keys are properties-style: item.ebwizardry\:charm_flight.name is item.ebwizardry:charm_flight.name.
					const key = line.slice(0, at).trim().replace(/\\(.)/g, '$1');
					if (at > 0 && !line.startsWith('#') && !out.has(key)) out.set(key, line.slice(at + 1).trim());
				}
			}
		}
		return out;
	}
}

/** `items/diamond` -> `minecraft:items/diamond`. */
const withNamespace = (ref: string) => (ref.includes(':') ? ref : `minecraft:${ref}`);
const split = (ref: string): [string, string] => {
	const [ns, p] = withNamespace(ref).split(':');
	return [ns, p];
};

// -------------------------------------------------------------- the jars ---

/** The Minecraft client jar for a version, from the cache or Mojang. Null when it cannot be had. */
export async function clientJar(minecraftVersion: string): Promise<string | null> {
	const file = path.join(CLIENT_DIR, `${minecraftVersion}.jar`);
	if (await fs.access(file).then(() => true, () => false)) return file;
	const download = await minecraftClientDownload(minecraftVersion).catch(() => null);
	if (!download) return null;
	await downloadFile(download.url, file, { hash: { algo: 'sha1', value: download.sha1 } });
	return file;
}

const cache = new Map<string, { key: string; resources: Promise<Resources> }>();

/**
 * Folders a pack puts its own assets in: resources/ (ResourceLoader, which
 * ContentTweaker items use on 1.12) and kubejs/assets/.
 */
const ASSET_DIRS = ['resources', path.join('kubejs', 'assets')];

/**
 * The server's resources, kept while mods/ and the asset folders are
 * unchanged. Vanilla only with the EULA answered yes; mods' own textures need
 * no download.
 */
export async function serverResources(instance: ServerInstance): Promise<Resources> {
	const mods = modsDir(instance.path);
	const dirs = ASSET_DIRS.map((d) => path.join(instance.path, d));
	const stamps = await Promise.all([mods, ...dirs].map((d) => fs.stat(d).then((s) => s.mtimeMs, () => 0)));
	const eula = getMapSettings(instance.id).eulaAccepted;
	const key = `${stamps.join(',')}:${eula}:${instance.minecraftVersion}`;
	const hit = cache.get(instance.id);
	if (hit?.key === key) return hit.resources;
	const resources = (async () => {
		const jars = (await fs.readdir(mods).catch(() => [] as string[]))
			.filter((n) => n.endsWith('.jar') && !n.endsWith(DISABLED_SUFFIX))
			.sort()
			.map((n) => path.join(mods, n));
		const client = eula ? await clientJar(instance.minecraftVersion).catch(() => null) : null;
		return Resources.load(jars, client, dirs);
	})();
	cache.set(instance.id, { key, resources });
	resources.catch(() => cache.delete(instance.id));
	return resources;
}

// ------------------------------------------------------------ resolution ---

type Model = {
	textures: Record<string, string>;
	elements: unknown[] | null;
	flat: boolean;
	entity: boolean;
	/** display.gui.rotation, the nearest one up the chain. */
	gui: [number, number, number] | null;
};

const cube = (faces: Record<ModelSide, string>) => ({
	elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(Object.entries(faces).map(([side, t]) => [side, { texture: t }])) }]
});

/**
 * Minecraft's base models that mods build on, by shape only (no textures of
 * Mojang's), for when the client jar is not there (no EULA answer): mods'
 * own items and blocks still get pictures. The jar's own files win.
 */
const BASE_MODELS: Record<string, Record<string, unknown>> = {
	'item/generated': { parent: 'builtin/generated' },
	'item/handheld': { parent: 'item/generated' },
	'item/handheld_rod': { parent: 'item/handheld' },
	'block/cube': cube({ up: '#up', north: '#north', south: '#south', east: '#east', west: '#west' }),
	'block/cube_all': { parent: 'block/cube', textures: { up: '#all', north: '#all', south: '#all', east: '#all', west: '#all' } },
	'block/cube_column': { parent: 'block/cube', textures: { up: '#end', north: '#side', south: '#side', east: '#side', west: '#side' } },
	'block/cube_bottom_top': { parent: 'block/cube', textures: { up: '#top', north: '#side', south: '#side', east: '#side', west: '#side' } },
	'block/cube_top': { parent: 'block/cube', textures: { up: '#top', north: '#side', south: '#side', east: '#side', west: '#side' } },
	'block/orientable': { parent: 'block/cube', textures: { up: '#top', north: '#front', south: '#side', east: '#side', west: '#side' } }
};

/** A model with its parents' textures and elements folded in. Null when it cannot be read. */
async function loadModel(res: Resources, ref: string, depth = 0): Promise<Model | null> {
	if (depth > 12) return null;
	const [ns, p] = split(ref);
	if (`${ns}:${p}` === 'minecraft:builtin/generated') return { textures: {}, elements: null, flat: true, entity: false, gui: null };
	if (`${ns}:${p}` === 'minecraft:builtin/entity') return { textures: {}, elements: null, flat: false, entity: true, gui: null };
	const json = (await res.json(`${ns}/models/${p}.json`)) ?? (ns === 'minecraft' ? BASE_MODELS[p.replace(/^(blocks?|items?)\//, (m) => (m.startsWith('b') ? 'block/' : 'item/'))] : undefined);
	if (!json) return null;
	const parent = typeof json.parent === 'string' ? await loadModel(res, json.parent, depth + 1) : null;
	if (typeof json.parent === 'string' && !parent) return null;
	// 26.x can give a texture as { sprite, force_translucent } (glass) instead of its name.
	const own = Object.fromEntries(
		Object.entries((json.textures ?? {}) as Record<string, unknown>).flatMap(([key, value]) => {
			const name = typeof value === 'string' ? value : (value as { sprite?: unknown } | null)?.sprite;
			return typeof name === 'string' ? [[key, name]] : [];
		})
	);
	const textures = { ...(parent?.textures ?? {}), ...own };
	const elements = Array.isArray(json.elements) ? json.elements : (parent?.elements ?? null);
	const display = json.display as { gui?: { rotation?: unknown } } | undefined;
	const rotation = display?.gui?.rotation;
	const gui = Array.isArray(rotation) && rotation.length === 3 && rotation.every((n) => typeof n === 'number') ? (rotation as [number, number, number]) : (parent?.gui ?? null);
	return { textures, elements, flat: !Array.isArray(json.elements) && (parent?.flat ?? false), entity: parent?.entity ?? false, gui };
}

/** "#all" -> the texture it names, followed through other references. */
function texture(model: Model, ref: string | undefined): string | null {
	let current = ref;
	for (let i = 0; current?.startsWith('#') && i < 10; i++) current = model.textures[current.slice(1)];
	return current && !current.startsWith('#') ? withNamespace(current) : null;
}

type Tints = (string | null)[];

const DEFAULT_TINT: Record<string, string> = {
	grass: '#7cbd6b',
	foliage: '#48b518'
};

/** 1.21.4's tint sources, as a colour per tintindex. */
function tintsOf(def: Record<string, unknown>): Tints {
	const tints = Array.isArray(def.tints) ? (def.tints as Record<string, unknown>[]) : [];
	return tints.map((t) => {
		const type = String(t.type ?? '').replace(/^minecraft:/, '');
		const value = typeof t.value === 'number' ? t.value : typeof t.default === 'number' ? t.default : null;
		if (value !== null) return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
		return DEFAULT_TINT[type] ?? null;
	});
}

/** Before 1.21.4 tints are set in code: the vanilla ones that matter, by item path. */
function legacyTint(itemPath: string): string | null {
	if (/leaves|vine|lily_pad|waterlily/.test(itemPath)) return DEFAULT_TINT.foliage;
	if (/^(grass|grass_block|tall_grass|tallgrass|fern|large_fern|double_plant)$/.test(itemPath)) return DEFAULT_TINT.grass;
	return null;
}

/** The game's default uv for a face, from the element's box. */
const UV: Record<ModelSide, (f: number[], t: number[]) => [number, number, number, number]> = {
	up: (f, t) => [f[0], f[2], t[0], t[2]],
	north: (f, t) => [16 - t[0], 16 - t[1], 16 - f[0], 16 - f[1]],
	south: (f, t) => [f[0], 16 - t[1], t[0], 16 - f[1]],
	west: (f, t) => [f[2], 16 - t[1], t[2], 16 - f[1]],
	east: (f, t) => [16 - t[2], 16 - t[1], 16 - f[2], 16 - f[1]]
};

function specOf(model: Model, tints: Tints, fallbackTint: string | null): IconSpec | null {
	const tint = (index: unknown) => (typeof index === 'number' ? (tints[index] ?? fallbackTint) : null);
	if (model.entity) return null;
	if (model.flat || !model.elements) {
		const layers: { texture: string; tint: string | null }[] = [];
		for (let i = 0; i < 8; i++) {
			const t = texture(model, model.textures[`layer${i}`]);
			if (!t) break;
			layers.push({ texture: t, tint: tint(i) });
		}
		return layers.length ? { kind: 'flat', layers } : null;
	}
	const elements: ElementSpec[] = [];
	for (const raw of model.elements as Record<string, unknown>[]) {
		const from = raw.from as [number, number, number];
		const to = raw.to as [number, number, number];
		if (!Array.isArray(from) || !Array.isArray(to)) continue;
		const faces: ElementSpec['faces'] = {};
		for (const side of ['up', 'north', 'south', 'east', 'west'] as const) {
			const face = (raw.faces as Record<string, Record<string, unknown>> | undefined)?.[side];
			const t = face && texture(model, face.texture as string);
			if (!face || !t) continue;
			faces[side] = {
				texture: t,
				uv: Array.isArray(face.uv) ? (face.uv as [number, number, number, number]) : UV[side](from, to),
				tint: tint(face.tintindex)
			};
		}
		if (Object.keys(faces).length) elements.push({ from, to, faces });
	}
	return elements.length ? { kind: 'block', elements, rotation: model.gui ?? GUI_ROTATION } : null;
}

/** The model a 1.21.4+ item definition names: a plain or special model, or the fallback / first case of the rest. */
function definitionModel(def: Record<string, unknown> | undefined, depth = 0): Record<string, unknown> | null {
	if (!def || depth > 6) return null;
	const type = String(def.type ?? '').replace(/^minecraft:/, '');
	if (type === 'model' || type === 'special') return def;
	if (type === 'composite') return definitionModel((def.models as Record<string, unknown>[] | undefined)?.[0], depth + 1);
	if (type === 'condition') return definitionModel((def.on_false ?? def.on_true) as Record<string, unknown>, depth + 1);
	// By where it is shown (the trident: a flat picture in the inventory, the 3D one in hand): the inventory's.
	const cases = def.cases as { when?: unknown; model?: Record<string, unknown> }[] | undefined;
	if (type === 'select' && Array.isArray(cases)) {
		const gui = cases.find((c) => (Array.isArray(c.when) ? c.when : [c.when]).includes('gui'));
		if (gui?.model) return definitionModel(gui.model, depth + 1);
	}
	const nested = (def.fallback ?? (def.cases as { model: Record<string, unknown> }[] | undefined)?.[0]?.model ?? (def.entries as { model: Record<string, unknown> }[] | undefined)?.[0]?.model) as
		| Record<string, unknown>
		| undefined;
	return definitionModel(nested, depth + 1);
}

/** Resolves one item, by id and (1.12 and older) damage. */
export async function resolveIcon(res: Resources, id: string, damage: number | null = null): Promise<ItemIcon> {
	const [ns, itemPath] = split(id);
	const definition = await res.json(`${ns}/items/${itemPath}.json`);
	if (definition) {
		const model = definitionModel(definition.model as Record<string, unknown>);
		const special = model?.type === 'minecraft:special' || model?.type === 'special' ? (model.model as Record<string, unknown> | undefined) : null;
		const specialType = special ? String(special.type).replace(/^minecraft:/, '') : null;
		if (specialType === 'chest' && typeof special!.texture === 'string') {
			return { spec: vanillaChest(res, split(special!.texture)[1]), exact: true };
		}
		if (specialType === 'shulker_box' && typeof special!.texture === 'string') {
			return { spec: vanillaShulker(res, split(special!.texture)[1]), exact: true };
		}
		if (specialType === 'shield') return { spec: vanillaShield(res), exact: true };
		const drawn = special ? entityItem(res, special, itemPath, null) : undefined;
		if (drawn !== undefined) return { spec: drawn, exact: true };
		if (!model || typeof model.model !== 'string') return { spec: null, exact: true };
		const loaded = await loadModel(res, model.model);
		return { spec: loaded ? specOf(loaded, tintsOf(model), null) : null, exact: true };
	}
	if (ns === 'minecraft' && CHESTS[itemPath]) {
		const chest = vanillaChest(res, CHESTS[itemPath]);
		if (chest) return { spec: chest, exact: true };
	}
	if (ns === 'minecraft') {
		const drawn = entityItem(res, null, itemPath, damage);
		if (drawn) return { spec: drawn, exact: true, variant: !!damage && ['skull', 'banner', 'bed'].includes(itemPath) };
	}
	if (ns === 'minecraft' && itemPath === 'shield') {
		const shield = vanillaShield(res);
		if (shield) return { spec: shield, exact: true };
	}
	const shulker = ns === 'minecraft' ? itemPath.match(/^(?:(\w+)_)?shulker_box$/) : null;
	if (shulker) {
		const box = vanillaShulker(res, shulker[1] ? `shulker_${shulker[1]}` : 'shulker');
		if (box) return { spec: box, exact: true };
	}
	const candidates = variantModels(ns, itemPath, damage);
	// A mod's own name pattern for the variant, before its blockstate file and the base model.
	const patterns = ns === 'minecraft' ? candidates : candidates.slice(0, -1);
	for (const [i, name] of patterns.entries()) {
		if (!res.has(`${ns}/models/item/${name}.json`)) continue;
		const loaded = await loadModel(res, `${ns}:item/${name}`);
		if (!loaded) continue;
		const spec = specOf(loaded, [], legacyTint(itemPath));
		// Vanilla is known: its table, or damage that is wear (tools, armour). A
		// mod's damage may be a variant whose model only its code knows: a guess.
		const variant = !!damage && (ns === 'minecraft' ? !!VANILLA_112[itemPath] : candidates.length > 1);
		return { spec, exact: !damage || ns === 'minecraft' || (i === 0 && candidates.length === 1), variant, ...(name !== itemPath ? { variantOf: name } : {}) };
	}
	if (ns !== 'minecraft') {
		const fromState = await blockstateIcon(res, ns, itemPath, damage ?? 0, legacyTint(itemPath));
		if (fromState) return { ...fromState, variant: !!damage && !fromState.exact };
		if (res.has(`${ns}/models/item/${itemPath}.json`)) {
			// A plain item model and a damage value is nearly always wear (tools,
			// armour): not flagged, or every worn tool would carry the mark.
			const loaded = await loadModel(res, `${ns}:item/${itemPath}`);
			if (loaded) return { spec: specOf(loaded, [], legacyTint(itemPath)), exact: true };
		}
		// Models registered in code from a subfolder: by file name, when only one has it.
		const nested = res.nestedItemModels(ns, itemPath);
		if (nested.length === 1) {
			const loaded = await loadModel(res, nested[0]);
			const spec = loaded && specOf(loaded, [], legacyTint(itemPath));
			if (spec) return { spec, exact: true };
		}
		const numbered = numberedTexture(res, ns, itemPath, damage ?? 0);
		if (numbered) return numbered;
	}
	return { spec: null, exact: true };
}

/**
 * The last resort for a 1.12 mod item whose models are picked in code: a
 * texture named after it with the damage as a number - from 0, or from 1 when
 * the series starts there (projecte:item.pe_klein_star damage 5 is
 * klein_star_6, its name item.pe_klein_star_6.name; enderutilities:handybag
 * damage 1 is handybag_1). A guess, flagged.
 */
function numberedTexture(res: Resources, ns: string, itemPath: string, damage: number): ItemIcon | null {
	const bare = itemPath.replace(/^(item|tile)\./, '');
	// ProjectE's ids carry the mod's prefix (pe_) that its file names drop.
	for (const name of new Set([bare, bare.replace(/^[a-z]{1,4}_/, '')])) {
		const series = res.numbered(ns, name);
		if (!series) continue;
		// A plain texture beside the series makes the numbers frames or overlays
		// (AoA's bows: predatious_bow and predatious_bow_0..2 drawn back): that one.
		const plain = [...series.values()][0].replace(/_\d+$/, '');
		if (res.has(`${split(plain)[0]}/textures/${split(plain)[1]}.png`)) return { spec: { kind: 'flat', layers: [{ texture: plain, tint: null }] }, exact: true };
		const n = series.has(0) ? damage : damage + 1;
		const texture = series.get(n);
		if (!texture) continue;
		return { spec: { kind: 'flat', layers: [{ texture, tint: null }] }, exact: false, variant: series.size > 1, variantOf: `${itemPath}_${n}` };
	}
	return null;
}

type Variant = { model?: string; textures?: Record<string, string> };

/**
 * 1.12 mods often describe items in a blockstate file instead of an item
 * model: Forge's format (`forge_marker`: defaults plus variants per
 * property value) or vanilla's (`"type=oak": {model}`), with an
 * `inventory` or `normal` variant for the item. Which damage value is which
 * variant is in the mod's code: the variant in that position is a guess
 * unless there is only one.
 */
async function blockstateIcon(res: Resources, ns: string, itemPath: string, damage: number, fallbackTint: string | null): Promise<ItemIcon | null> {
	const state = await res.json(`${ns}/blockstates/${itemPath}.json`);
	if (!state || typeof state.variants !== 'object' || !state.variants) return null;
	const first = (v: unknown): Variant | null => (Array.isArray(v) ? (v[0] as Variant) : v && typeof v === 'object' ? (v as Variant) : null);
	const variants = state.variants as Record<string, unknown>;
	const defaults = (state.defaults ?? {}) as Variant;
	let chosen: Variant | null = null;
	let exact = true;
	let variantOf: string | undefined;
	const named = first(variants.inventory) ?? first(variants.normal);
	if (named) chosen = named;
	else if (state.forge_marker) {
		// Either { property: { value: {...} } } - the first property's values, in
		// file order - or the variants listed directly: { name: [{...}] }.
		const isDefinition = (v: unknown) => Array.isArray(v) || (!!v && typeof v === 'object' && ('model' in v || 'textures' in v));
		const entries = Object.values(variants);
		const property = entries.find((v) => v && typeof v === 'object' && !isDefinition(v)) as Record<string, unknown> | undefined;
		const names = property ? Object.keys(property) : Object.keys(variants).filter((k) => isDefinition(variants[k]));
		const values = property ? Object.values(property) : entries.filter(isDefinition);
		chosen = first(values[damage] ?? values[0]);
		exact = values.length <= 1;
		if (values.length > 1) variantOf = names[damage] ?? names[0];
	} else {
		const keys = Object.keys(variants);
		chosen = first(variants[keys[damage] ?? keys[0]]);
		exact = keys.length <= 1;
		// "type=oak,axis=y": the first property's value.
		if (keys.length > 1) variantOf = (keys[damage] ?? keys[0]).split(',')[0].split('=').pop();
	}
	const model = chosen?.model ?? defaults.model;
	if (!model) return null;
	const loaded = await loadBlockstateModel(res, ns, model);
	if (!loaded) return null;
	loaded.textures = { ...loaded.textures, ...(defaults.textures ?? {}), ...(chosen?.textures ?? {}) };
	return { spec: specOf(loaded, [], fallbackTint), exact, ...(variantOf ? { variantOf } : {}) };
}

/**
 * Blockstate files name models under models/block/ unless they say
 * otherwise. Without a namespace a name is Minecraft's (Forge's rule:
 * "cube_all"), though some mods mean their own.
 */
async function loadBlockstateModel(res: Resources, ns: string, ref: string): Promise<Model | null> {
	const [refNs, refPath] = split(ref);
	if (refPath === 'builtin/generated' || refPath === 'item/generated') return loadModel(res, `minecraft:${refPath}`);
	// Forge's own layered item models: flat, layer0 and up.
	if (refNs === 'forge' && /^item-(layer|generated)$/.test(refPath)) return loadModel(res, 'minecraft:builtin/generated');
	const namespaces = ref.includes(':') ? [refNs] : ['minecraft', ns];
	for (const space of namespaces) {
		for (const candidate of refPath.includes('/') ? [refPath, `block/${refPath}`] : [`block/${refPath}`, `item/${refPath}`]) {
			if (res.has(`${space}/models/${candidate}.json`)) return loadModel(res, `${space}:${candidate}`);
		}
	}
	return null;
}

// ------------------------------------------------------ 1.12 variants ---

const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'silver', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak'];

/** Vanilla 1.12's item models by damage, where they are not "<id>". */
const VANILLA_112: Record<string, (d: number) => string | null> = {
	wool: (d) => `${COLORS[d]}_wool`,
	stained_glass: (d) => `${COLORS[d]}_stained_glass`,
	stained_glass_pane: (d) => `${COLORS[d]}_stained_glass_pane`,
	stained_hardened_clay: (d) => `${COLORS[d]}_stained_hardened_clay`,
	carpet: (d) => `${COLORS[d]}_carpet`,
	concrete: (d) => `${COLORS[d]}_concrete`,
	concrete_powder: (d) => `${COLORS[d]}_concrete_powder`,
	dye: (d) => `dye_${COLORS[15 - d]}`,
	planks: (d) => `${WOODS[d]}_planks`,
	sapling: (d) => `${WOODS[d & 7]}_sapling`,
	wooden_slab: (d) => `${WOODS[d & 7]}_slab`,
	log: (d) => `${WOODS[d & 3]}_log`,
	log2: (d) => `${WOODS[4 + (d & 1)]}_log`,
	leaves: (d) => `${WOODS[d & 3]}_leaves`,
	leaves2: (d) => `${WOODS[4 + (d & 1)]}_leaves`,
	stone: (d) => ['stone', 'granite', 'granite_smooth', 'diorite', 'diorite_smooth', 'andesite', 'andesite_smooth'][d] ?? null,
	sand: (d) => ['sand', 'red_sand'][d] ?? null,
	dirt: (d) => ['dirt', 'coarse_dirt', 'podzol'][d] ?? null,
	coal: (d) => ['coal', 'charcoal'][d] ?? null,
	fish: (d) => ['cod', 'salmon', 'clownfish', 'pufferfish'][d] ?? null,
	cooked_fish: (d) => ['cooked_cod', 'cooked_salmon'][d] ?? null,
	sandstone: (d) => ['sandstone', 'chiseled_sandstone', 'smooth_sandstone'][d] ?? null,
	red_sandstone: (d) => ['red_sandstone', 'chiseled_red_sandstone', 'smooth_red_sandstone'][d] ?? null,
	stonebrick: (d) => ['stonebrick', 'mossy_stonebrick', 'cracked_stonebrick', 'chiseled_stonebrick'][d] ?? null,
	stone_slab: (d) => ['stone_slab', 'sandstone_slab', 'stone_slab', 'cobblestone_slab', 'brick_slab', 'stone_brick_slab', 'nether_brick_slab', 'quartz_slab'][d & 7] ?? null,
	quartz_block: (d) => ['quartz_block', 'chiseled_quartz_block', 'quartz_column'][d] ?? null,
	prismarine: (d) => ['prismarine', 'prismarine_bricks', 'dark_prismarine'][d] ?? null,
	sponge: (d) => ['sponge', 'sponge_wet'][d] ?? null,
	anvil: (d) => ['anvil_intact', 'anvil_slightly_damaged', 'anvil_very_damaged'][d] ?? null,
	golden_apple: () => 'golden_apple',
	cobblestone_wall: (d) => ['cobblestone_wall', 'mossy_cobblestone_wall'][d] ?? null,
	skull: (d) => ['skull_skeleton', 'skull_wither', 'skull_zombie', 'skull_char', 'skull_creeper', 'skull_dragon'][d] ?? null,
	tallgrass: (d) => ['dead_bush', 'tall_grass', 'fern'][d] ?? null,
	yellow_flower: () => 'dandelion',
	red_flower: (d) => ['poppy', 'blue_orchid', 'allium', 'houstonia', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy'][d] ?? null,
	double_plant: (d) => ['sunflower', 'syringa', 'double_grass', 'double_fern', 'double_rose', 'paeonia'][d & 7] ?? null,
	monster_egg: (d) => ['stone_monster_egg', 'cobblestone_monster_egg', 'stone_brick_monster_egg', 'mossy_brick_monster_egg', 'cracked_brick_monster_egg', 'chiseled_brick_monster_egg'][d] ?? null,
	// Single ids that 1.12 still names by the wood: no damage involved.
	fence: () => 'oak_fence',
	fence_gate: () => 'oak_fence_gate',
	wooden_door: () => 'oak_door',
	boat: () => 'oak_boat',
	trapdoor: () => 'trapdoor'
};

/**
 * Item model names to try, best first. Without a damage value (or 1.13+),
 * just the id. With one: vanilla's table, then names mods commonly use, and
 * last the base model.
 */
export function variantModels(ns: string, itemPath: string, damage: number | null): string[] {
	if (!damage && !(ns === 'minecraft' && VANILLA_112[itemPath])) return [itemPath];
	const d = damage ?? 0;
	const out: string[] = [];
	if (ns === 'minecraft') {
		const name = VANILLA_112[itemPath]?.(d);
		if (name) out.push(name);
	} else {
		out.push(
			`${itemPath}_${d}`,
			`${itemPath}${d}`,
			`${itemPath}/${d}`,
			`${itemPath}.${d}`,
			...(d < 16 ? [`${COLORS[d]}_${itemPath}`, `${itemPath}_${COLORS[d]}`] : [])
		);
	}
	out.push(itemPath);
	return [...new Set(out)];
}

// ------------------------------------------------------------- the API ---

const resolved = new WeakMap<Resources, Map<string, Promise<ItemIcon>>>();

/**
 * Icons for a batch of items. `vanilla` says whether Minecraft's own
 * textures are there (the EULA question answered yes); without them only
 * mods' items get pictures.
 */
/** 1.12's lang names for the sixteen colours, by wool's damage order (white first). */
const LANG_COLORS = ['white', 'orange', 'magenta', 'lightBlue', 'yellow', 'lime', 'pink', 'gray', 'silver', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const WOOD_KEYS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'big_oak'];
const pick = (prefix: string, names: string[]) => (d: number) => (names[d] ? `${prefix}.${names[d]}` : null);

/**
 * Vanilla 1.12's lang key (without .name) for an item's damage: the keys
 * follow the game's code, not the ids (minecraft:stone damage 1 is
 * tile.stone.granite, planks are tile.wood.*, wool tile.cloth.*). Dye and
 * banners count colours from black.
 */
const VANILLA_112_NAMES: Record<string, (d: number) => string | null> = {
	stone: pick('tile.stone', ['stone', 'granite', 'graniteSmooth', 'diorite', 'dioriteSmooth', 'andesite', 'andesiteSmooth']),
	dirt: pick('tile.dirt', ['default', 'coarse', 'podzol']),
	planks: pick('tile.wood', WOOD_KEYS),
	sapling: pick('tile.sapling', WOOD_KEYS),
	sand: pick('tile.sand', ['default', 'red']),
	log: pick('tile.log', WOOD_KEYS.slice(0, 4)),
	log2: pick('tile.log', WOOD_KEYS.slice(4)),
	leaves: pick('tile.leaves', WOOD_KEYS.slice(0, 4)),
	leaves2: pick('tile.leaves', WOOD_KEYS.slice(4)),
	wooden_slab: pick('tile.woodSlab', WOOD_KEYS),
	sponge: pick('tile.sponge', ['dry', 'wet']),
	sandstone: pick('tile.sandStone', ['default', 'chiseled', 'smooth']),
	red_sandstone: pick('tile.redSandStone', ['default', 'chiseled', 'smooth']),
	tallgrass: pick('tile.tallgrass', ['shrub', 'grass', 'fern']),
	yellow_flower: pick('tile.flower1', ['dandelion']),
	red_flower: pick('tile.flower2', ['poppy', 'blueOrchid', 'allium', 'houstonia', 'tulipRed', 'tulipOrange', 'tulipWhite', 'tulipPink', 'oxeyeDaisy']),
	double_plant: pick('tile.doublePlant', ['sunflower', 'syringa', 'grass', 'fern', 'rose', 'paeonia']),
	stone_slab: pick('tile.stoneSlab', ['stone', 'sand', 'wood', 'cobble', 'brick', 'smoothStoneBrick', 'netherBrick', 'quartz']),
	stone_slab2: pick('tile.stoneSlab2', ['red_sandstone']),
	stonebrick: pick('tile.stonebricksmooth', ['default', 'mossy', 'cracked', 'chiseled']),
	monster_egg: pick('tile.monsterStoneEgg', ['stone', 'cobble', 'brick', 'mossybrick', 'crackedbrick', 'chiseledbrick']),
	cobblestone_wall: pick('tile.cobbleWall', ['normal', 'mossy']),
	quartz_block: pick('tile.quartzBlock', ['default', 'chiseled', 'lines']),
	prismarine: pick('tile.prismarine', ['rough', 'bricks', 'dark']),
	anvil: pick('tile.anvil', ['intact', 'slightlyDamaged', 'veryDamaged']),
	wool: pick('tile.cloth', LANG_COLORS),
	carpet: pick('tile.woolCarpet', LANG_COLORS),
	stained_hardened_clay: pick('tile.clayHardenedStained', LANG_COLORS),
	stained_glass: pick('tile.stainedGlass', LANG_COLORS),
	stained_glass_pane: pick('tile.thinStainedGlass', LANG_COLORS),
	concrete: pick('tile.concrete', LANG_COLORS),
	concrete_powder: pick('tile.concretePowder', LANG_COLORS),
	bed: pick('item.bed', LANG_COLORS),
	dye: pick('item.dyePowder', [...LANG_COLORS].reverse()),
	banner: pick('item.banner', [...LANG_COLORS].reverse()),
	skull: pick('item.skull', ['skeleton', 'wither', 'zombie', 'char', 'creeper', 'dragon']),
	coal: (d) => (d === 1 ? 'item.charcoal' : null),
	fish: (d) => (['cod', 'salmon', 'clownfish', 'pufferfish'][d] ? `item.fish.${['cod', 'salmon', 'clownfish', 'pufferfish'][d]}.raw` : null),
	cooked_fish: (d) => (['cod', 'salmon'][d] ? `item.fish.${['cod', 'salmon'][d]}.cooked` : null)
};

/**
 * A 1.12 item whose damage picks a variant is named by that variant, when the
 * lang files have it: by the variant alone (enderutilities:storage_0 damage 7
 * is jsu, tile.enderutilities.jsu.name) or under the id
 * (item.thermalfoundation.material.dustPetrotheum.name). Otherwise the id's
 * name stays.
 */
async function withVariantName(res: Resources, id: string, damage: number | null, icon: ItemIcon): Promise<ItemIcon> {
	const [ns, itemPath] = split(id);
	if (damage === null) return icon;
	if (ns === 'minecraft') {
		const key = VANILLA_112_NAMES[itemPath]?.(damage);
		const name = key ? (await res.lang()).get(`${key}.name`) : undefined;
		return name ? { ...icon, name } : icon;
	}
	if (!icon.variantOf) return icon;
	const lang = await res.lang();
	const name = langName(`${ns}:${icon.variantOf}`, lang) ?? langName(`${ns}:${itemPath}.${icon.variantOf}`, lang);
	return name ? { ...icon, name } : icon;
}

export async function iconsFor(
	instance: ServerInstance,
	items: { id: string; damage: number | null }[]
): Promise<{ icons: Record<string, ItemIcon>; vanilla: boolean }> {
	const res = await serverResources(instance);
	let memo = resolved.get(res);
	if (!memo) resolved.set(res, (memo = new Map()));
	const icons: Record<string, ItemIcon> = {};
	// The page sends at most ICON_BATCH (lib/shared/itemicon.svelte.ts) per request,
	// resolved side by side: one after another, 500 took 20 s on a big pack.
	await Promise.all(
		items.slice(0, 500).map(async ({ id, damage }) => {
			if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$|^[a-z0-9_./-]+$/.test(id)) return;
			const key = iconKey(id, damage);
			if (!memo.has(key)) memo.set(key, resolveIcon(res, id, damage).then((icon) => withVariantName(res, id, damage, icon)).catch(() => ({ spec: null, exact: true })));
			icons[key] = await memo.get(key)!;
		})
	);
	return { icons, vanilla: res.hasVanilla };
}

export const iconKey = (id: string, damage: number | null) => (damage ? `${id}@${damage}` : id);

/** A texture by its reference (`minecraft:block/stone`), as PNG bytes. */
export async function iconTexture(instance: ServerInstance, ref: string): Promise<Buffer | null> {
	if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(ref) || ref.includes('..')) return null;
	const [ns, p] = split(ref);
	return (await serverResources(instance)).read(`${ns}/textures/${p}.png`);
}

// ------------------------------------------------------------ the picker ---

export type ItemChoice = { id: string; name: string };

/**
 * Forge's registry in level.dat (FML > Registries > minecraft:items > ids):
 * on 1.12 and older every item id the world knows, the most exact list
 * there is. Null without it (vanilla, 1.13+).
 */
async function registryItems(worldDir: string): Promise<string[] | null> {
	try {
		const level = parseNbt(await fs.readFile(path.join(worldDir, 'level.dat')));
		const ids = child(child(child(child(level.root, 'FML'), 'Registries'), 'minecraft:items'), 'ids');
		if (ids?.type !== 'list') return null;
		const out = ids.value.map((e) => str(child(e, 'K'))).filter((k): k is string => !!k);
		return out.length ? out.sort() : null;
	} catch {
		return null;
	}
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** "chest_sack" -> "Chest Sack". */
const humanize = (p: string) =>
	p
		.split('/')
		.pop()!
		.split(/[_\s]+/)
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(' ');

const lowerCased = new WeakMap<Map<string, string>, Map<string, string>>();

/**
 * An item's English name: the keys the game uses (1.13+), the ones 1.12 mods
 * usually use, else its id tidied up. 1.12 ids are lower case while mods' keys
 * often are not (botania:manaringgreater is item.botania:manaRingGreater.name),
 * so a key that does not match exactly is looked up ignoring case. Some ids
 * already start with item. (projecte:item.pe_life_stone: item.pe_life_stone.name).
 */
export function itemName(id: string, lang: Map<string, string>): string {
	return langName(id, lang) ?? humanize(split(id)[1].replace(/^(item|tile)\./, ''));
}

/**
 * 1.12 vanilla ids whose key is another item's: tile.stonebrick.name is
 * Cobblestone (cobblestone's key); Stone Bricks are stonebricksmooth.
 */
const VANILLA_112_KEYS: Record<string, string> = { stonebrick: 'stonebricksmooth' };

/**
 * A lang value as a name. Some are templates the mod fills in its code
 * ("%1$s Dust", "Vial of %s (%s)"): the gaps show as "…". One that is only
 * gaps (crafting_on_a_stick's "%1$s%2$s%3$s") says nothing: null.
 */
function filled(value: string | undefined): string | null {
	if (!value) return null;
	const gap = /%(\d+\$)?[sd]/g;
	if (!gap.test(value)) return value;
	if (!/[\p{L}\p{N}]/u.test(value.replace(gap, ''))) return null;
	return value.replace(gap, '…').replace(/%%/g, '%');
}

/** itemName's lookup alone: null when the lang files do not have it. */
function langName(id: string, lang: Map<string, string>): string | null {
	const [ns, path] = split(id);
	const p = (ns === 'minecraft' && lang.has(`tile.${VANILLA_112_KEYS[path]}.name`) && VANILLA_112_KEYS[path]) || path;
	const keys = [
		`item.${ns}.${p}`,
		`block.${ns}.${p}`,
		// The mod's own keys before bare ones: appliedenergistics2:chest is tile.appliedenergistics2.chest.name
		// ("ME Chest"), while tile.chest.name is vanilla's chest.
		...[`${ns}.${p}`, `${ns}:${p}`, `${ns}.${camel(p)}`, p, camel(p)].flatMap((n) => [`item.${n}.name`, `tile.${n}.name`]),
		`${p}.name`
	];
	for (const key of keys) {
		const found = filled(lang.get(key));
		if (found) return found;
	}
	let lower = lowerCased.get(lang);
	if (!lower) {
		lower = new Map();
		for (const [k, v] of lang) if (!lower.has(k.toLowerCase())) lower.set(k.toLowerCase(), v);
		lowerCased.set(lang, lower);
	}
	for (const key of keys) {
		const found = filled(lower.get(key.toLowerCase()));
		if (found) return found;
	}
	return null;
}

const choicesCache = new WeakMap<Resources, Promise<ItemChoice[]>>();

/** Every item the server knows, with its name, for the picker. */
export async function itemChoices(instance: ServerInstance): Promise<ItemChoice[]> {
	const res = await serverResources(instance);
	let hit = choicesCache.get(res);
	if (!hit) {
		hit = (async () => {
			const registry = compareVersions(instance.minecraftVersion, '1.13') < 0 ? await registryItems(path.join(instance.path, await serverWorldName(instance.path))) : null;
			const ids = registry ?? res.itemNames();
			const lang = await res.lang();
			return ids.map((id) => ({ id, name: itemName(id, lang) }));
		})();
		choicesCache.set(res, hit);
	}
	return hit;
}

