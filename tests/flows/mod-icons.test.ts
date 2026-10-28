import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

/** The Mods tab's pictures (modicons.ts): project icons kept in the cache, jars' own logos. */

const { modIcon, resetModIcons } = await import('#lib/server/modicons.js');
const { db } = await import('#lib/server/db/index.js');
const { instanceMods, mods } = await import('#lib/server/db/schema.js');
const { createInstance } = await import('../helpers/instances');
const { fetchCalls, useRecordedHttp } = await import('../helpers/http');
const { zipBuffer } = await import('../helpers/fs');

const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`picture of ${tag}`)]);
const ICON = 'https://cdn.example/icons/sodium.png';
const SVG = 'https://cdn.example/icons/evil.svg';
useRecordedHttp('none', {
	extra: {
		[ICON]: () => new Response(new Uint8Array(png('sodium'))),
		[SVG]: () => new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
	}
});

async function server() {
	const instance = await createInstance(
		{ modloader: 'fabric', minecraftVersion: '1.21.1' },
		{
			'mods/sodium.jar': zipBuffer({ 'fabric.mod.json': JSON.stringify({ id: 'sodium' }), 'assets/sodium/icon.png': png('sodium jar') }),
			'mods/sized.jar.disabled': zipBuffer({
				'fabric.mod.json': JSON.stringify({ id: 'sized', icon: { '16': 'small.png', '128': 'big.png' } }),
				'small.png': png('small'),
				'big.png': png('big')
			}),
			'mods/forge.jar': zipBuffer({ 'META-INF/mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="thing"\nlogoFile="logo.png"\n', 'logo.png': png('forge') }),
			'mods/plain.jar': zipBuffer({ 'fabric.mod.json': JSON.stringify({ id: 'plain', icon: 'missing.png' }) }),
			'mods/evil.jar': zipBuffer({ 'fabric.mod.json': JSON.stringify({ id: 'evil' }) })
		}
	);
	const modId = (slug: string, iconUrl: string) =>
		db.insert(mods).values({ source: 'modrinth', slug, name: slug, iconUrl }).returning({ id: mods.id }).get().id;
	const row = { instanceId: instance.id, installedAt: 1, version: '1', versionId: 'v', hash: null, hashAlgo: null };
	db.insert(instanceMods)
		.values([
			{ ...row, modId: modId(`sodium-${instance.id}`, ICON), filePath: 'mods/sodium.jar' },
			{ ...row, modId: modId(`evil-${instance.id}`, SVG), filePath: 'mods/evil.jar' }
		])
		.run();
	return instance;
}

const text = (icon: { bytes: Buffer } | null) => icon?.bytes.subarray(8).toString();

describe('mod icons', () => {
	beforeEach(() => resetModIcons());

	it("downloads a project's icon once and keeps it", async () => {
		const instance = await server();
		const before = fetchCalls.filter((c) => c.url === ICON).length;
		expect(await modIcon(instance, 'sodium.jar')).toMatchObject({ type: 'image/png' });
		expect(text(await modIcon(instance, 'sodium.jar'))).toBe('picture of sodium');
		expect(fetchCalls.filter((c) => c.url === ICON).length - before).toBe(1);
	});

	it("takes a jar's own picture otherwise: Fabric's largest, Forge's logoFile", async () => {
		const instance = await server();
		expect(text(await modIcon(instance, 'sized.jar.disabled'))).toBe('picture of big');
		expect(text(await modIcon(instance, 'forge.jar'))).toBe('picture of forge');
		expect(await modIcon(instance, 'plain.jar')).toBeNull();
	});

	it('never serves anything but a picture, nor anything outside mods/', async () => {
		const instance = await server();
		// The SVG is not kept; the jar has no picture of its own.
		expect(await modIcon(instance, 'evil.jar')).toBeNull();
		expect(await modIcon(instance, '../server.properties')).toBeNull();
		expect(await modIcon(instance, '../../other/mods/sodium.jar')).toBeNull();
		expect(await modIcon(instance, 'nothing.jar')).toBeNull();
		expect(db.select().from(instanceMods).where(eq(instanceMods.instanceId, instance.id)).all()).toHaveLength(2);
	});
});
