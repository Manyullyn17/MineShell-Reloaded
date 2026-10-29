import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const { deleteInstance, getInstance } = await import('#lib/server/instances.js');
const { beginOperation, endOperation } = await import('#lib/server/operations.js');
const { db } = await import('#lib/server/db/index.js');
const { operations } = await import('#lib/server/db/schema.js');
const { startTask } = await import('#lib/server/tasks.js');
const { createInstance, systemdStopped, waitForTask } = await import('../helpers/instances');
const { spawnCalls } = await import('../helpers/process');

async function server() {
	systemdStopped();
	return createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' }, { 'world/level.dat': 'level' });
}

describe('deleting a server', () => {
	it('waits for a task still running on it', async () => {
		const s = await server();
		let finish = () => {};
		const taskId = startTask({ label: 'Install Some Pack', instanceId: s.id }, () => new Promise<void>((resolve) => (finish = resolve)));

		// The install would carry on writing into a folder that is gone.
		await expect(deleteInstance(s, { deleteFiles: true })).rejects.toThrow(/"Install Some Pack" is still running/);
		expect(getInstance(s.id)).toBeDefined();
		expect(await fs.readFile(path.join(s.path, 'world/level.dat'), 'utf8')).toBe('level');

		finish();
		await waitForTask(taskId);
		await deleteInstance(s, { deleteFiles: true });
		expect(getInstance(s.id)).toBeUndefined();
		await expect(fs.access(s.path)).rejects.toThrow();
	});

	it('waits for a journalled change under way', async () => {
		const s = await server();
		beginOperation(s.id, { kind: 'create' });
		await expect(deleteInstance(s, { deleteFiles: true })).rejects.toThrow(/still under way/);
		expect(getInstance(s.id)).toBeDefined();
		endOperation(s.id);
		await deleteInstance(s, { deleteFiles: true });
		expect(getInstance(s.id)).toBeUndefined();
	});

	// Clicked again while the server stopped (a big world's last save): each
	// click was one more deletion waiting behind the stop, all going through.
	it('is refused a second time while the first waits for the server to stop', async () => {
		const s = await server();
		const first = deleteInstance(s, { deleteFiles: true });
		await expect(deleteInstance(s, { deleteFiles: false })).rejects.toThrow(/already being deleted/);
		expect(() => beginOperation(s.id, { kind: 'create' })).toThrow(/being deleted/);
		await first;
		expect(getInstance(s.id)).toBeUndefined();
		expect(spawnCalls.filter((c) => c.args.includes('stop'))).toHaveLength(1);
	});

	it('stops short when a task starts while the server stops', async () => {
		const s = await server();
		const first = deleteInstance(s, { deleteFiles: true });
		let finish = () => {};
		const taskId = startTask({ label: 'Export', instanceId: s.id }, () => new Promise<void>((resolve) => (finish = resolve)));
		await expect(first).rejects.toThrow(/"Export" started while the server stopped/);
		expect(getInstance(s.id)).toBeDefined();
		expect(await fs.readFile(path.join(s.path, 'world/level.dat'), 'utf8')).toBe('level');
		finish();
		await waitForTask(taskId);
		await deleteInstance(s, { deleteFiles: true });
		expect(getInstance(s.id)).toBeUndefined();
	});

	// A recovery that failed at boot keeps its journal: the server must stay deletable.
	it('is not held up by a journal an earlier MineShell left', async () => {
		const s = await server();
		beginOperation(s.id, { kind: 'create' });
		db.update(operations).set({ process: 'an-earlier-process' }).run();
		await deleteInstance(s, { deleteFiles: true });
		expect(getInstance(s.id)).toBeUndefined();
	});
});
