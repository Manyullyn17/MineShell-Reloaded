import fs from 'node:fs/promises';
import path from 'node:path';
import { child, num, parseNbt, str } from './nbt';
import { LEGACY_ENCHANTMENTS } from './playeritems';
import { openZipFile } from './zip';

/**
 * 1.12 and older store an item's enchantments as numbers. The numbers are
 * per world: Forge hands them out when a mod registers its enchantments and
 * records the table in level.dat (FML > Registries > minecraft:enchantments >
 * ids, each {K: "<mod>:<name>", V: <number>}). Reading that table turns
 * "97" into "cofhcore:soulbound" exactly; a vanilla server has no table and
 * only vanilla's fixed numbers.
 *
 * Display names come from the mods' own en_us.lang files. The lang key is
 * chosen by the mod's code, not derived from the id, so likely keys are
 * tried (enchantment.<mod>.<name>, enchantment.<name>, ...) and the name is
 * otherwise made from the id ("last_stand" -> "Last Stand"). Measured on
 * MeatballCraft: 132 enchantments, three in four of the mod ones named by
 * their lang file.
 */

export type EnchantmentInfo = { id: string; name: string };

/** Vanilla's names; its 1.12 lang keys (enchantment.damage.all) follow no rule. */
const VANILLA_NAMES: Record<string, string> = {
	protection: 'Protection',
	fire_protection: 'Fire Protection',
	feather_falling: 'Feather Falling',
	blast_protection: 'Blast Protection',
	projectile_protection: 'Projectile Protection',
	respiration: 'Respiration',
	aqua_affinity: 'Aqua Affinity',
	thorns: 'Thorns',
	depth_strider: 'Depth Strider',
	frost_walker: 'Frost Walker',
	binding_curse: 'Curse of Binding',
	sharpness: 'Sharpness',
	smite: 'Smite',
	bane_of_arthropods: 'Bane of Arthropods',
	knockback: 'Knockback',
	fire_aspect: 'Fire Aspect',
	looting: 'Looting',
	sweeping: 'Sweeping Edge',
	efficiency: 'Efficiency',
	silk_touch: 'Silk Touch',
	unbreaking: 'Unbreaking',
	fortune: 'Fortune',
	power: 'Power',
	punch: 'Punch',
	flame: 'Flame',
	infinity: 'Infinity',
	luck_of_the_sea: 'Luck of the Sea',
	lure: 'Lure',
	mending: 'Mending',
	vanishing_curse: 'Curse of Vanishing'
};

/** "enchant_reaper" or "enchantment.autosmelt" -> "Reaper", "Autosmelt". */
export function nameFromId(id: string): string {
	const bare = id
		.slice(id.indexOf(':') + 1)
		.replace(/^(enchantment|enchant)[._]/i, '')
		.split('.')
		.pop()!;
	const words = bare
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.split(/[\s_-]+/)
		.filter(Boolean);
	return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || id;
}

/** The lang keys a mod might have used for an enchantment id. */
export function langKeysFor(id: string): string[] {
	const [mod, name] = id.includes(':') ? id.split(':', 2) : ['minecraft', id];
	const keys = [
		`enchantment.${mod}.${name}`,
		`enchantment.${name}`,
		`enchantment.${mod}:${name}`,
		`enchantment.${mod}_${name}`,
		`enchantment.${mod}.${name}.name`,
		`enchantment.${name}.name`
	];
	return [...new Set([...keys, ...keys.map((k) => k.toLowerCase())])];
}

/** The world's number -> id table, or null when level.dat has none (vanilla, unreadable). */
export async function readEnchantmentRegistry(worldDir: string): Promise<Map<number, string> | null> {
	try {
		const level = parseNbt(await fs.readFile(path.join(worldDir, 'level.dat')));
		const ids = child(child(child(child(level.root, 'FML'), 'Registries'), 'minecraft:enchantments'), 'ids');
		if (ids?.type !== 'list') return null;
		const table = new Map<number, string>();
		for (const entry of ids.value) {
			const id = str(child(entry, 'K'));
			const number = num(child(entry, 'V'));
			if (id && number !== null) table.set(number, id);
		}
		return table.size ? table : null;
	} catch {
		return null;
	}
}

const langCache = new Map<string, { key: string; names: Map<string, string> }>();

/** Every `enchantment.*` line of the en_us.lang files in mods/, cached until the folder changes. */
async function modLangNames(instancePath: string): Promise<Map<string, string>> {
	const dir = path.join(instancePath, 'mods');
	const jars = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => /\.jar(\.disabled)?$/i.test(f)).sort();
	const stats = await Promise.all(jars.map((f) => fs.stat(path.join(dir, f)).catch(() => null)));
	const key = jars.map((f, i) => `${f}:${stats[i]?.size}:${stats[i]?.mtimeMs}`).join('|');
	const cached = langCache.get(instancePath);
	if (cached?.key === key) return cached.names;

	const names = new Map<string, string>();
	for (const file of jars) {
		const zip = await openZipFile(path.join(dir, file)).catch(() => null);
		for (const entry of zip?.entries ?? []) {
			if (!/^assets\/[^/]+\/lang\/en_us\.lang$/i.test(entry.name)) continue;
			const text = (await zip!.read(entry).catch(() => Buffer.alloc(0))).toString('utf8');
			for (const line of text.split(/\r?\n/)) {
				const at = line.indexOf('=');
				if (line.startsWith('enchantment.') && at > 0) names.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
			}
		}
	}
	langCache.set(instancePath, { key, names });
	return names;
}

function displayName(id: string, lang: Map<string, string>): string {
	const [mod, name] = id.includes(':') ? id.split(':', 2) : ['minecraft', id];
	if (mod === 'minecraft' && VANILLA_NAMES[name]) return VANILLA_NAMES[name];
	for (const key of langKeysFor(id)) {
		const found = lang.get(key);
		if (found) return found;
	}
	return nameFromId(id);
}

/** Vanilla's fixed numbers with their names: what a world without Forge's table has. */
export function vanillaEnchantmentTable(): Record<number, EnchantmentInfo> {
	const out: Record<number, EnchantmentInfo> = {};
	for (const [n, name] of Object.entries(LEGACY_ENCHANTMENTS)) out[Number(n)] = { id: `minecraft:${name}`, name: VANILLA_NAMES[name] ?? nameFromId(name) };
	return out;
}

/**
 * The enchantments a 1.12-or-older world knows, by number, with display
 * names: its own table from level.dat, or vanilla's fixed numbers.
 */
export async function legacyEnchantmentTable(instancePath: string, worldDir: string): Promise<Record<number, EnchantmentInfo>> {
	const registry = await readEnchantmentRegistry(worldDir);
	if (!registry) return vanillaEnchantmentTable();
	const lang = await modLangNames(instancePath);
	const out: Record<number, EnchantmentInfo> = {};
	for (const [number, id] of registry) out[number] = { id, name: displayName(id, lang) };
	return out;
}
