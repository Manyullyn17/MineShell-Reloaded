import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	deleteToTrash,
	emptyTrash,
	expireTrash,
	listTrash,
	purgeTrashItem,
	restoreFromTrash,
	setTrashDays,
	trashDays,
	TRASH_DIR
} from '#lib/server/trash.js';
import { cloneSkips } from '#lib/server/instances.js';
import { diskBreakdown } from '#lib/server/diskusage.js';
import { createInstance } from '../helpers/instances';

const server = () =>
	createInstance(
		{ modloader: 'fabric', minecraftVersion: '1.21.1' },
		{
			'config/jei/settings.toml': 'a=1\n',
			'config/other.json': '{}',
			'mods/a.jar': 'jar'
		}
	);

const read = (root: string, rel: string) => fs.readFile(path.join(root, rel), 'utf8');
const gone = (root: string, rel: string) => fs.access(path.join(root, rel)).then(() => false, () => true);

afterEach(() => {
	setTrashDays(7);
	vi.restoreAllMocks();
});

describe('the Files trash', () => {
	it('moves a deleted folder to the trash and puts it back where it was', async () => {
		const { path: root } = await server();
		const item = await deleteToTrash(root, 'config/jei');
		expect(item).toMatchObject({ path: 'config/jei', isDirectory: true, bytes: 4 });
		expect(await gone(root, 'config/jei')).toBe(true);
		expect((await listTrash(root)).map((i) => i.path)).toEqual(['config/jei']);

		expect(await restoreFromTrash(root, item!.id)).toBe('config/jei');
		expect(await read(root, 'config/jei/settings.toml')).toBe('a=1\n');
		expect(await listTrash(root)).toEqual([]);
	});

	it('restores beside whatever took the place since, and makes missing folders again', async () => {
		const { path: root } = await server();
		const first = await deleteToTrash(root, 'config/other.json');
		await fs.writeFile(path.join(root, 'config/other.json'), 'new');
		expect(await restoreFromTrash(root, first!.id)).toBe('config/other (restored).json');
		expect(await read(root, 'config/other.json')).toBe('new');
		expect(await read(root, 'config/other (restored).json')).toBe('{}');

		const jei = await deleteToTrash(root, 'config/jei/settings.toml');
		await fs.rm(path.join(root, 'config'), { recursive: true });
		expect(await restoreFromTrash(root, jei!.id)).toBe('config/jei/settings.toml');
		expect(await read(root, 'config/jei/settings.toml')).toBe('a=1\n');
	});

	it('keeps two deletes of the same name in one millisecond apart', async () => {
		const { path: root } = await server();
		vi.spyOn(Date, 'now').mockReturnValue(1_791_000_000_000);
		const a = await deleteToTrash(root, 'mods/a.jar');
		await fs.writeFile(path.join(root, 'mods/a.jar'), 'second');
		const b = await deleteToTrash(root, 'mods/a.jar');
		expect(a!.id).not.toBe(b!.id);
		expect(await listTrash(root)).toHaveLength(2);
		await restoreFromTrash(root, b!.id);
		expect(await read(root, 'mods/a.jar')).toBe('second');
	});

	it('deletes the trash itself, what is inside it, and everything when the trash is off, for good', async () => {
		const { path: root } = await server();
		const item = await deleteToTrash(root, 'mods/a.jar');
		expect(await deleteToTrash(root, `${TRASH_DIR}/${item!.id}`)).toBeNull();
		expect(await listTrash(root)).toEqual([]);
		await deleteToTrash(root, 'config/other.json');
		expect(await deleteToTrash(root, TRASH_DIR)).toBeNull();
		expect(await gone(root, TRASH_DIR)).toBe(true);

		setTrashDays(0);
		expect(trashDays()).toBe(0);
		expect(await deleteToTrash(root, 'config/jei')).toBeNull();
		expect(await gone(root, 'config/jei')).toBe(true);
		expect(await gone(root, TRASH_DIR)).toBe(true);
	});

	it('never deletes the server folder or reaches outside it', async () => {
		const { path: root } = await server();
		await expect(deleteToTrash(root, '')).rejects.toThrow();
		await expect(deleteToTrash(root, '../x')).rejects.toThrow();
		await expect(restoreFromTrash(root, '../../x')).rejects.toThrow();
		await expect(purgeTrashItem(root, '../config')).rejects.toThrow();
		expect(await read(root, 'config/other.json')).toBe('{}');
	});

	it('empties items past the kept days, one by one or all at once', async () => {
		const { path: root } = await server();
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now - 8 * 86_400_000);
		await deleteToTrash(root, 'mods/a.jar');
		vi.mocked(Date.now).mockReturnValue(now);
		const recent = await deleteToTrash(root, 'config/jei');
		const other = await deleteToTrash(root, 'config/other.json');

		expect(await expireTrash(root, now)).toBe(1);
		expect((await listTrash(root)).map((i) => i.id).sort()).toEqual([recent!.id, other!.id].sort());
		setTrashDays(1);
		expect(await expireTrash(root, now + 2 * 86_400_000)).toBe(2);

		await deleteToTrash(root, 'config');
		await purgeTrashItem(root, (await listTrash(root))[0].id);
		expect(await listTrash(root)).toEqual([]);
		await fs.writeFile(path.join(root, 'b.txt'), 'b');
		await deleteToTrash(root, 'b.txt');
		expect(await emptyTrash(root)).toBe(1);
		expect(await gone(root, TRASH_DIR)).toBe(true);
	});

	it('is shown as the trash in disk usage, not as a leftover, and is not cloned', async () => {
		const instance = await server();
		await deleteToTrash(instance.path, 'config');
		const usage = await diskBreakdown(instance);
		const item = usage.groups.flatMap((g) => g.items).find((i) => i.path === TRASH_DIR);
		expect(item?.label).toBe('Deleted files in the trash');
		expect(usage.suggestions.find((s) => s.href?.tab === 'trash')).toBeTruthy();
		expect(usage.suggestions.some((s) => s.text.includes('did not finish'))).toBe(false);
		expect(cloneSkips(TRASH_DIR)).toBe(true);
	});
});
