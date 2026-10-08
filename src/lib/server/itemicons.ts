import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerInstance } from './db/schema';
import { CACHE_DIR } from './config';
import { downloadFile } from './download';
import { minecraftClientDownload } from './modloaders';
import { DISABLED_SUFFIX, modsDir } from './mods';
import { getMapSettings } from './worldmap';
import { openZipFile, type ZipEntry, type ZipFile } from './zip';
import { child, parseNbt, str } from './nbt';
import { compareVersions } from './java';
import { serverWorldName } from './packworld';

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
export type Side = 'up' | 'north' | 'south' | 'east' | 'west';
export type ElementSpec = {
	from: [number, number, number];
	to: [number, number, number];
	/** Every side but the bottom; which ones show depends on the rotation. */
	faces: Partial<Record<Side, FaceSpec>>;
};
export type IconSpec =
	| { kind: 'flat'; layers: { texture: string; tint: string | null }[] }
	/** `rotation`: the model's inventory view, degrees about x, y, z as the game applies them. */
	| { kind: 'block'; elements: ElementSpec[]; rotation: [number, number, number] };

/** Minecraft's block/block.json: how blocks are turned in the inventory, unless a model says otherwise (stairs: 135). */
const GUI_ROTATION: [number, number, number] = [30, 225, 0];
/**
 * `exact`: false when the picture is a guess. `variant`: the 1.12 damage value
 * picks a variant (vanilla's table, a mod's variant model), rather than being
 * wear - what the tooltip calls it.
 */
export type ItemIcon = { spec: IconSpec | null; exact: boolean; variant?: boolean };

// ------------------------------------------------------------- resources ---

type Source = { jar: string; zip: ZipFile; entries: Map<string, ZipEntry> };

/**
 * Every model, item definition and texture the server's jars hold, by
 * `<namespace>/<kind>/<path>` (`minecraft/models/item/diamond.json`). Mods
 * first, vanilla last; the first jar to have a file wins.
 */
export class Resources {
	private constructor(
		private readonly files: Map<string, Source>,
		readonly hasVanilla: boolean
	) {}

	static async load(jars: string[], clientJar: string | null): Promise<Resources> {
		const files = new Map<string, Source>();
		for (const jar of clientJar ? [...jars, clientJar] : jars) {
			const zip = await openZipFile(jar).catch(() => null);
			if (!zip) continue;
			const entries = new Map<string, ZipEntry>();
			for (const entry of zip.entries) {
				const m =
					entry.name.match(/^assets\/([^/]+)\/((?:models|items|textures|blockstates)\/.+\.(?:json|png))$/) ??
					entry.name.match(/^assets\/([^/]+)\/(lang\/en_us\.(?:json|lang))$/i);
				if (!m) continue;
				const key = `${m[1]}/${m[2].toLowerCase().startsWith('lang/') ? m[2].toLowerCase() : m[2]}`;
				entries.set(key, entry);
			}
			const source = { jar, zip, entries };
			for (const key of entries.keys()) if (!files.has(key)) files.set(key, source);
		}
		return new Resources(files, !!clientJar);
	}

	has(key: string): boolean {
		return this.files.has(key);
	}

	async read(key: string): Promise<Buffer | null> {
		const source = this.files.get(key);
		const entry = source?.entries.get(key);
		return source && entry ? source.zip.read(entry) : null;
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

	/** Every en_us line of every jar: 1.13+'s JSON and 1.12's .lang. The first jar to set a key wins. */
	async lang(): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		for (const key of this.files.keys()) {
			if (!/\/lang\/en_us\.(json|lang)$/.test(key)) continue;
			const text = (await this.read(key))?.toString('utf8').replace(/^\uFEFF/, '') ?? '';
			if (key.endsWith('.json')) {
				try {
					for (const [k, v] of Object.entries(JSON.parse(text) as Record<string, unknown>)) if (typeof v === 'string' && !out.has(k)) out.set(k, v);
				} catch {
					/* not JSON after all */
				}
			} else {
				for (const line of text.split(/\r?\n/)) {
					const at = line.indexOf('=');
					if (at > 0 && !line.startsWith('#') && !out.has(line.slice(0, at).trim())) out.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
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
 * The server's resources, kept while mods/ is unchanged. Vanilla only with
 * the EULA answered yes; mods' own textures need no download.
 */
export async function serverResources(instance: ServerInstance): Promise<Resources> {
	const mods = modsDir(instance.path);
	const stat = await fs.stat(mods).catch(() => null);
	const eula = getMapSettings(instance.id).eulaAccepted;
	const key = `${stat?.mtimeMs ?? 0}:${eula}:${instance.minecraftVersion}`;
	const hit = cache.get(instance.id);
	if (hit?.key === key) return hit.resources;
	const resources = (async () => {
		const jars = (await fs.readdir(mods).catch(() => [] as string[]))
			.filter((n) => n.endsWith('.jar') && !n.endsWith(DISABLED_SUFFIX))
			.sort()
			.map((n) => path.join(mods, n));
		const client = eula ? await clientJar(instance.minecraftVersion).catch(() => null) : null;
		return Resources.load(jars, client);
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

const cube = (faces: Record<Side, string>) => ({
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
	const own = (json.textures ?? {}) as Record<string, string>;
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
const UV: Record<Side, (f: number[], t: number[]) => [number, number, number, number]> = {
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

/** The model a 1.21.4+ item definition names: a plain model, or the fallback / first case of the rest. */
function definitionModel(def: Record<string, unknown> | undefined, depth = 0): Record<string, unknown> | null {
	if (!def || depth > 6) return null;
	const type = String(def.type ?? '').replace(/^minecraft:/, '');
	if (type === 'model') return def;
	if (type === 'special') return null;
	if (type === 'composite') return definitionModel((def.models as Record<string, unknown>[] | undefined)?.[0], depth + 1);
	if (type === 'condition') return definitionModel((def.on_false ?? def.on_true) as Record<string, unknown>, depth + 1);
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
		if (!model || typeof model.model !== 'string') return { spec: null, exact: true };
		const loaded = await loadModel(res, model.model);
		return { spec: loaded ? specOf(loaded, tintsOf(model), null) : null, exact: true };
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
		return { spec, exact: !damage || ns === 'minecraft' || (i === 0 && candidates.length === 1), variant };
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
	}
	return { spec: null, exact: true };
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
	const named = first(variants.inventory) ?? first(variants.normal);
	if (named) chosen = named;
	else if (state.forge_marker) {
		// Either { property: { value: {...} } } - the first property's values, in
		// file order - or the variants listed directly: { name: [{...}] }.
		const isDefinition = (v: unknown) => Array.isArray(v) || (!!v && typeof v === 'object' && ('model' in v || 'textures' in v));
		const entries = Object.values(variants);
		const property = entries.find((v) => v && typeof v === 'object' && !isDefinition(v)) as Record<string, unknown> | undefined;
		const values = property ? Object.values(property) : entries.filter(isDefinition);
		chosen = first(values[damage] ?? values[0]);
		exact = values.length <= 1;
	} else {
		const keys = Object.keys(variants);
		chosen = first(variants[keys[damage] ?? keys[0]]);
		exact = keys.length <= 1;
	}
	const model = chosen?.model ?? defaults.model;
	if (!model) return null;
	const loaded = await loadBlockstateModel(res, ns, model);
	if (!loaded) return null;
	loaded.textures = { ...loaded.textures, ...(defaults.textures ?? {}), ...(chosen?.textures ?? {}) };
	return { spec: specOf(loaded, [], fallbackTint), exact };
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
export async function iconsFor(
	instance: ServerInstance,
	items: { id: string; damage: number | null }[]
): Promise<{ icons: Record<string, ItemIcon>; vanilla: boolean }> {
	const res = await serverResources(instance);
	let memo = resolved.get(res);
	if (!memo) resolved.set(res, (memo = new Map()));
	const icons: Record<string, ItemIcon> = {};
	for (const { id, damage } of items.slice(0, 500)) {
		if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$|^[a-z0-9_./-]+$/.test(id)) continue;
		const key = iconKey(id, damage);
		if (!memo.has(key)) memo.set(key, resolveIcon(res, id, damage).catch(() => ({ spec: null, exact: true })));
		icons[key] = await memo.get(key)!;
	}
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

/** An item's English name: the keys the game uses (1.13+), the ones 1.12 mods usually use, else its id tidied up. */
export function itemName(id: string, lang: Map<string, string>): string {
	const [ns, p] = split(id);
	const keys = [
		`item.${ns}.${p}`,
		`block.${ns}.${p}`,
		...[p, camel(p), `${ns}.${p}`, `${ns}:${p}`, `${ns}.${camel(p)}`].flatMap((n) => [`item.${n}.name`, `tile.${n}.name`])
	];
	for (const key of keys) {
		const found = lang.get(key);
		if (found) return found;
	}
	return humanize(p);
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

