import { describe, expect, it } from 'vitest';

/** Mods that copy the world themselves (backupmods.ts), and where the disk usage page points at them. */

const { backupModsOf } = await import('#lib/server/backupmods.js');
const { diskBreakdown } = await import('#lib/server/diskusage.js');
const { createInstance } = await import('../helpers/instances');
const { zipBuffer } = await import('../helpers/fs');

const aroma = zipBuffer({ 'mcmod.info': JSON.stringify([{ modid: 'aromabackup', name: 'AromaBackup' }, { modid: 'aromabackuprecovery' }]) });
const simple = zipBuffer({ 'META-INF/neoforge.mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId = "simplebackups"\n[[dependencies.simplebackups]]\n    modId = "neoforge"\n' });
const AROMA_CFG = (location: string, delay = 30, onStartup = true) =>
	`backup_location {\n    S:location=${location}\n}\nbackup_schedule {\n    I:delay=${delay}\n    B:onStartup=${onStartup}\n}\n`;

const server = (files: Record<string, string | Buffer>) => createInstance({ modloader: 'cleanroom', minecraftVersion: '1.12.2' }, files);

describe('backup mods', () => {
	it("finds AromaBackup with its folder from the config, measured", async () => {
		const instance = await server({
			'mods/AromaBackup-1.12.2-2.1.1.4.jar': aroma,
			'config/aroma1997/aromabackup.cfg': AROMA_CFG('./backups'),
			'backups/world/Backup--world--2026-10-22--10-00.zip': 'x'.repeat(5000)
		});
		expect(await backupModsOf(instance)).toEqual([
			{ name: 'AromaBackup', fileName: 'AromaBackup-1.12.2-2.1.1.4.jar', when: expect.stringContaining('world loads'), folder: 'backups', bytes: 5000 }
		]);
		const usage = await diskBreakdown(instance);
		expect(usage.suggestions.find((s) => s.text.startsWith('AromaBackup'))).toMatchObject({ bytes: 5000, href: { tab: 'files', path: 'backups' } });
	});

	it('leaves out one switched off in its config, or disabled', async () => {
		const off = await server({ 'mods/aroma.jar': aroma, 'config/aroma1997/aromabackup.cfg': AROMA_CFG('./backups', 0, false) });
		expect(await backupModsOf(off)).toEqual([]);
		const disabled = await server({ 'mods/aroma.jar.disabled': aroma });
		expect(await backupModsOf(disabled)).toEqual([]);
		const simpleOff = await server({ 'mods/simple.jar': simple, 'config/simplebackups-common.toml': 'enabled = false\noutputPath = "simplebackups"\n' });
		expect(await backupModsOf(simpleOff)).toEqual([]);
	});

	it("takes Simple Backups' outputPath, its default without a config, and does not measure outside the server", async () => {
		const own = await server({ 'mods/simple.jar': simple, 'config/simplebackups-common.toml': 'enabled = true\noutputPath = "world-copies"\n' });
		expect(await backupModsOf(own)).toMatchObject([{ name: 'Simple Backups', folder: 'world-copies', bytes: 0 }]);
		const plain = await server({ 'mods/simple.jar': simple });
		expect(await backupModsOf(plain)).toMatchObject([{ folder: 'simplebackups' }]);
		const outside = await server({ 'mods/aroma.jar': aroma, 'config/aroma1997/aromabackup.cfg': AROMA_CFG('../../elsewhere') });
		const [found] = await backupModsOf(outside);
		expect(found.bytes).toBeNull();
		expect(found.folder.startsWith('/')).toBe(true);
		expect((await diskBreakdown(outside)).suggestions.find((s) => s.text.startsWith('AromaBackup'))?.href).toBeUndefined();
	});
});
