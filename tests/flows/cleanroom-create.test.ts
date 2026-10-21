import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A new plain Cleanroom server gets Fugue and Scalar Legacy at once: most
 * Forge mods need them, and Cleanroom 0.7 stops its first start to ask about
 * them otherwise. The adding itself (Modrinth, CurseForge) is cleanroom.test.ts's.
 */

const fixes = vi.hoisted(() => ({ calls: [] as string[], failures: [] as string[] }));
vi.mock('#lib/server/cleanroom.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/cleanroom.js')>()),
	applyCleanroomModFixes: async (instance: { id: string }) => {
		fixes.calls.push(instance.id);
		return { disabled: [], added: ['Fugue', 'Scalar Legacy'], failures: fixes.failures, advise: [] };
	}
}));

const { createFromLoader } = await import('#lib/server/instances.js');
const { LOADERS } = await import('#lib/server/modloaders.js');
const { addJava, clearJava, reload, systemdStopped, waitForTask } = await import('../helpers/instances');

afterEach(() => {
	vi.restoreAllMocks();
	clearJava();
	fixes.calls.length = 0;
	fixes.failures = [];
});

function fakeInstall(loader: 'cleanroom' | 'forge') {
	vi.spyOn(LOADERS[loader], 'install').mockImplementation(async (ctx) => {
		await fs.writeFile(path.join(ctx.dir, 'server.jar'), loader);
		return { launchArgs: '-jar server.jar nogui', loaderVersion: loader === 'cleanroom' ? '0.7.11-alpha' : '14.23.5.2859' };
	});
}

async function newServer(modloader: 'cleanroom' | 'forge') {
	systemdStopped();
	addJava(25);
	addJava(8);
	fakeInstall(modloader);
	const { instance, taskId } = await createFromLoader({ name: `New ${modloader}`, minecraftVersion: '1.12.2', modloader });
	expect((await waitForTask(taskId)).state).toBe('done');
	return reload(instance.id);
}

describe('a new Cleanroom server', () => {
	it('gets Fugue and Scalar Legacy while it is set up; a Forge one does not', async () => {
		const cleanroom = await newServer('cleanroom');
		expect(fixes.calls).toEqual([cleanroom.id]);
		expect(cleanroom).toMatchObject({ status: 'ready', statusMessage: null });

		await newServer('forge');
		expect(fixes.calls).toEqual([cleanroom.id]);
	});

	it('is ready all the same when one cannot be added, and says so', async () => {
		fixes.failures = ['Could not add Scalar Legacy: CurseForge did not answer.'];
		const server = await newServer('cleanroom');
		expect(server).toMatchObject({ status: 'ready', statusMessage: 'Could not add Scalar Legacy: CurseForge did not answer.' });
	});
});
