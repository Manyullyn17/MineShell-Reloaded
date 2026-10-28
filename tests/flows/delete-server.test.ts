import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const { deleteInstance, getInstance } = await import('#lib/server/instances.js');
const { beginOperation, endOperation } = await import('#lib/server/operations.js');
const { startTask } = await import('#lib/server/tasks.js');
const { createInstance, systemdStopped, waitForTask } = await import('../helpers/instances');

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
});
