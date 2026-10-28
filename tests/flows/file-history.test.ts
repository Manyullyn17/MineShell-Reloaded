import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Earlier versions of edited files (filehistory.ts): kept on save, pruned, left out of copies. */

const { keepVersion, listVersions, readVersion, KEEP } = await import('#lib/server/filehistory.js');
const { writeTextFile } = await import('#lib/server/files.js');
const { cloneSkips } = await import('#lib/server/instances.js');
const { diskBreakdown } = await import('#lib/server/diskusage.js');
const { createInstance } = await import('../helpers/instances');

const DAY = 24 * 3600_000;
const server = () => createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' }, { 'config/a.toml': 'a = 1\r\nb = 2\r\n', 'run.sh': 'java -jar x\n' });

/** What the Files save action does. */
async function save(root: string, file: string, text: string, now: number) {
	await keepVersion(root, file, text, now);
	await writeTextFile(root, file, text);
}

describe('earlier versions of edited files', () => {
	it('keeps the text a save replaced, byte for byte, newest first', async () => {
		const { path: root } = await server();
		await save(root, 'config/a.toml', 'a = 1\nb = 3\n', 1000);
		await save(root, 'config/a.toml', 'a = 2\nb = 3\n', 2000);
		expect((await listVersions(root, 'config/a.toml')).map((v) => v.savedAt)).toEqual([2000, 1000]);
		// The first kept its CRLF: the old bytes as they were.
		expect(await readVersion(root, 'config/a.toml', '1000')).toBe('a = 1\r\nb = 2\r\n');
		expect(await readVersion(root, 'config/a.toml', '2000')).toBe('a = 1\r\nb = 3\r\n');
	});

	it('keeps nothing for a new file or a save that changes nothing (line endings aside)', async () => {
		const { path: root } = await server();
		expect(await keepVersion(root, 'config/new.json', '{}', 1)).toBe(false);
		expect(await keepVersion(root, 'config/a.toml', 'a = 1\nb = 2\n', 1)).toBe(false);
		expect(await listVersions(root, 'config/a.toml')).toEqual([]);
	});

	it(`keeps ${KEEP} per file, and drops those older than 90 days apart from the newest 3`, async () => {
		const { path: root } = await server();
		for (let i = 0; i < KEEP + 5; i++) await save(root, 'run.sh', `java -jar x ${i}\n`, 1000 + i);
		const kept = await listVersions(root, 'run.sh');
		expect(kept).toHaveLength(KEEP);
		expect(kept[0].savedAt).toBe(1000 + KEEP + 4);
		// Much later: everything older than 90 days goes but the newest 3 (the one just kept among them).
		await save(root, 'run.sh', 'java -jar y\n', 1000 + 200 * DAY);
		expect((await listVersions(root, 'run.sh')).map((v) => v.savedAt)).toEqual([1000 + 200 * DAY, 1000 + KEEP + 4, 1000 + KEEP + 3]);
	});

	it('refuses a version id or a path that is not one', async () => {
		const { path: root } = await server();
		await expect(readVersion(root, 'config/a.toml', '../../run.sh')).rejects.toThrow();
		await expect(listVersions(root, '../../etc/passwd')).rejects.toThrow();
		await expect(keepVersion(root, '../outside.txt', 'x')).rejects.toThrow();
	});

	it('is left out of copies and exports, and named on the disk usage page', async () => {
		const instance = await server();
		await save(instance.path, 'config/a.toml', 'changed\n', 1000);
		expect(cloneSkips('.mineshell/file-history')).toBe(true);
		const usage = await diskBreakdown(instance);
		const item = usage.groups.flatMap((g) => g.items).find((i) => i.path === path.join('.mineshell', 'file-history'));
		expect(item?.label).toBe('Earlier versions of files edited in MineShell');
		expect(await fs.readdir(path.join(instance.path, '.mineshell', 'file-history', 'config'))).toEqual(['a.toml.versions']);
	});
});
