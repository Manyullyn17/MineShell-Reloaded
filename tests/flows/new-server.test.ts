import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createFromLoader } = await import('#lib/server/instances.js');
const { instanceDir } = await import('#lib/server/config.js');
const { LOADERS } = await import('#lib/server/modloaders.js');
const { addJava, clearJava, systemdStopped, waitForTask } = await import('../helpers/instances');

afterEach(() => {
	vi.restoreAllMocks();
	clearJava();
});

describe('a new server', () => {
	it('does not adopt the folder a deleted server left behind', async () => {
		// "Delete server" without deleting files: the folder stays, the row goes.
		const kept = instanceDir('survival');
		await fs.mkdir(path.join(kept, 'world'), { recursive: true });
		await fs.writeFile(path.join(kept, 'world/level.dat'), 'the old world');

		systemdStopped();
		addJava(21);
		vi.spyOn(LOADERS.fabric, 'install').mockImplementation(async (ctx) => {
			await fs.writeFile(path.join(ctx.dir, 'server.jar'), 'fabric');
			return { launchArgs: '-jar server.jar nogui', loaderVersion: '0.16.0' };
		});
		const { instance, taskId } = await createFromLoader({ name: 'Survival', minecraftVersion: '1.21.1', modloader: 'fabric' });
		expect((await waitForTask(taskId)).state).toBe('done');

		expect(instance.id).toBe('survival-2');
		expect(await fs.readdir(kept)).toEqual(['world']);
		await expect(fs.access(path.join(instance.path, 'world'))).rejects.toThrow();
	});
});
