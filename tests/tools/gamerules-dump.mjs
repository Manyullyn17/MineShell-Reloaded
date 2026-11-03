#!/usr/bin/env node
/**
 * Where a world keeps its game rules, and what they are: level.dat's Data.GameRules (every
 * value a string, up to 1.21.10 or so), or data/minecraft/game_rules.dat (Minecraft 26, typed,
 * names with `minecraft:`). Also the spawn and border as level.dat or their own files hold
 * them. Read only; for checking what a version writes (with `mc-probe.mjs --keep`):
 *
 *   node tests/tools/gamerules-dump.mjs <world folder>
 */
import fs from 'node:fs';
import path from 'node:path';

const { parseNbt, child } = await import('../../src/lib/server/nbt.ts');
const world = process.argv[2];
if (!world) {
	console.error('Usage: node tests/tools/gamerules-dump.mjs <world folder>');
	process.exit(2);
}

/** @param {any} tag @returns {any} */
const plain = (tag) => {
	if (!tag) return tag;
	if (tag.type === 'compound') return Object.fromEntries(tag.value.map((/** @type {[string, any]} */ [k, v]) => [k, plain(v)]));
	if (tag.type === 'list') return tag.value.map(plain);
	if (tag.type === 'long') return String(tag.value);
	if (tag.type === 'longArray') return tag.value.map(String);
	return tag.value;
};
/** @param {string} rel */
const read = (rel) => {
	const file = path.join(world, rel);
	return fs.existsSync(file) ? parseNbt(fs.readFileSync(file)).root : null;
};

const level = read('level.dat');
const data = child(level ?? undefined, 'Data');
const out = {
	version: plain(child(child(data, 'Version'), 'Name')) ?? null,
	dataVersion: plain(child(data, 'DataVersion')) ?? null,
	levelDatRules: plain(child(data, 'GameRules')) ?? null,
	levelDatSpawn: {
		SpawnX: plain(child(data, 'SpawnX')),
		SpawnY: plain(child(data, 'SpawnY')),
		SpawnZ: plain(child(data, 'SpawnZ')),
		spawn: plain(child(data, 'spawn'))
	},
	levelDatBorder: Object.fromEntries(['BorderCenterX', 'BorderCenterZ', 'BorderSize'].map((k) => [k, plain(child(data, k))])),
	gameRulesDat: plain(read('data/minecraft/game_rules.dat') ?? undefined) ?? null,
	worldBorderDats: Object.fromEntries(
		['data/minecraft/world_border.dat', 'dimensions/minecraft/overworld/data/minecraft/world_border.dat']
			.filter((rel) => fs.existsSync(path.join(world, rel)))
			.map((rel) => [rel, plain(read(rel) ?? undefined)])
	)
};
console.log(JSON.stringify(out, null, 1));
