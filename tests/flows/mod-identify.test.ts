import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// Whether a working CurseForge key is set: the fingerprint lookup needs one.
const key = vi.hoisted(() => ({ valid: true }));
vi.mock('#lib/server/curseforge.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/curseforge.js')>()),
	getCurseforgeApiKey: () => 'test-key',
	curseforgeKeyValid: () => key.valid
}));

const { actions } = await import('../../src/routes/instances/[id]/mods/+page.server');
const { listInstanceMods, syncMods, trackManualJar } = await import('#lib/server/mods/index.js');
const { curseforgeFingerprint } = await import('#lib/server/mods/fingerprint.js');
const { db } = await import('#lib/server/db/index.js');
const { instanceMods } = await import('#lib/server/db/schema.js');
const { createInstance, systemdStopped } = await import('../helpers/instances');
const { fetchCalls, useRecordedHttp } = await import('../helpers/http');
const { zipBuffer } = await import('../helpers/fs');
const { post } = await import('../helpers/routes');

/** Jars MineShell has no record of, or recorded as manual (an upload): Sync and Upload name them. */

const jar = (id: string) => zipBuffer({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id, name: id }) });
// Only on Modrinth (Lithium, uploaded), only on CurseForge, and on neither.
const LITHIUM = jar('lithium');
const CF_ONLY = jar('cfonly');
const NOWHERE = jar('nowhere');
const sha512 = (b: Buffer) => crypto.createHash('sha512').update(b).digest('hex');

useRecordedHttp('none', {
	extra: {
		'https://api.modrinth.com/v2/version_files': () =>
			Response.json({
				[sha512(LITHIUM)]: {
					id: 'LITH-V', project_id: 'LITH', name: 'Lithium 0.21.1', version_number: '0.21.1', version_type: 'release',
					date_published: '2026-01-01T00:00:00Z', game_versions: ['1.21.11'], loaders: ['fabric'], changelog: null, files: [], dependencies: []
				}
			}),
		[`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent('["LITH"]')}`]: () =>
			Response.json([{ id: 'LITH', slug: 'lithium', title: 'Lithium', description: '', icon_url: null, downloads: 1, loaders: ['fabric'], game_versions: ['1.21.11'], team: 't' }]),
		'https://api.curseforge.com/v1/fingerprints/432': () =>
			Response.json({
				data: { exactMatches: [{ id: 990001, file: { id: 7001, modId: 990001, displayName: 'CF Only 2.0', fileName: 'cfonly.jar', fileFingerprint: curseforgeFingerprint(CF_ONLY) } }] }
			}),
		'https://api.curseforge.com/v1/mods': () =>
			Response.json({ data: [{ id: 990001, name: 'CF Only', slug: 'cf-only', summary: 'Only on CurseForge', authors: [{ name: 'someone' }], links: { websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/cf-only' } }] })
	}
});

const fabric = (files: Record<string, Buffer>) =>
	createInstance({ modloader: 'fabric', minecraftVersion: '1.21.11' }, Object.fromEntries(Object.entries(files).map(([name, b]) => [`mods/${name}`, b])));
const byFile = async (instance: Awaited<ReturnType<typeof fabric>>) =>
	Object.fromEntries((await listInstanceMods(instance)).map((r) => [r.fileName, { source: r.source, name: r.name, version: r.version, addedAt: r.addedAt }]));
const manualAt = (instanceId: string, at: number) => db.update(instanceMods).set({ installedAt: at }).where(eq(instanceMods.instanceId, instanceId)).run();

describe('identifying jars', () => {
	it('Sync names jars recorded as manual, by Modrinth hash and then CurseForge fingerprint, keeping when they were added', async () => {
		key.valid = true;
		const instance = await fabric({ 'lithium.jar': LITHIUM, 'cfonly.jar': CF_ONLY, 'nowhere.jar': NOWHERE });
		for (const file of ['lithium.jar', 'cfonly.jar', 'nowhere.jar']) await trackManualJar(instance, file);
		manualAt(instance.id, 1_700_000_000_000);
		await syncMods(instance, { fromPack: false });
		expect(await byFile(instance)).toEqual({
			'lithium.jar': { source: 'modrinth', name: 'Lithium', version: '0.21.1', addedAt: 1_700_000_000_000 },
			'cfonly.jar': { source: 'curseforge', name: 'CF Only', version: 'CF Only 2.0', addedAt: 1_700_000_000_000 },
			'nowhere.jar': { source: 'manual', name: 'nowhere', version: null, addedAt: 1_700_000_000_000 }
		});
	});

	it('does not ask CurseForge without a key', async () => {
		key.valid = false;
		const instance = await fabric({ 'cfonly.jar': CF_ONLY });
		await trackManualJar(instance, 'cfonly.jar');
		fetchCalls.length = 0;
		await syncMods(instance, { fromPack: false });
		expect(fetchCalls.filter((c) => c.url.startsWith('https://api.curseforge.com/'))).toEqual([]);
		expect((await byFile(instance))['cfonly.jar'].source).toBe('manual');
		key.valid = true;
	});

	it('Upload identifies the jars it adds', async () => {
		key.valid = true;
		systemdStopped();
		const instance = await fabric({});
		const result = await post(actions.upload, {
			params: { id: instance.id },
			fields: { jars: [new File([new Uint8Array(LITHIUM)], 'lithium.jar'), new File([new Uint8Array(CF_ONLY)], 'cfonly.jar')] }
		});
		expect(result).toMatchObject({ ok: true, message: 'Added 2 mods (identified 2 mods). Restart to load them.' });
		expect(await byFile(instance)).toMatchObject({
			'lithium.jar': { source: 'modrinth', name: 'Lithium' },
			'cfonly.jar': { source: 'curseforge', name: 'CF Only' }
		});
	});
});
