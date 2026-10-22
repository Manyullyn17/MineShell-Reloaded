import { afterEach, describe, expect, it } from 'vitest';
import { actions } from './+page.server';
import { encryptSecret } from '#lib/server/crypto.js';
import { invalidateUnitState } from '#lib/server/systemd.js';
import { listTasks } from '#lib/server/tasks.js';
import { createInstance, waitForTask } from '../../../../../tests/helpers/instances';
import { fakeProcesses, resetProcesses } from '../../../../../tests/helpers/process';
import { post } from '../../../../../tests/helpers/routes';

afterEach(resetProcesses);

const server = () =>
	createInstance(
		{ modloader: 'fabric', minecraftVersion: '1.21.1', rconPasswordEnc: encryptSecret('rcon') },
		{ 'server.properties': 'level-name=world\n', 'world/level.dat': 'level' }
	);

describe('Snapshot now', () => {
	it('says the server keeps running when it snapshots a running one', async () => {
		invalidateUnitState();
		fakeProcesses((cmd, args) => {
			if (cmd === 'journalctl') return { stdout: '[12:00:00] [Server thread/INFO]: Done (3.1s)! For help, type "help"\n' };
			return args.includes('show') ? { stdout: 'ActiveState=active\nSubState=running\nMainPID=4242\n' } : {};
		});
		const instance = await server();
		const answer = await post(actions.snapshot, { params: { id: instance.id } });
		expect(answer).toMatchObject({ ok: true, message: expect.stringMatching(/while it runs/) });
		expect(answer).not.toMatchObject({ message: expect.stringMatching(/stays stopped/) });
		// The copy itself fails here (nothing answers RCON); only the answer is checked, then the task let finish.
		const task = listTasks().find((t) => t.instanceId === instance.id);
		if (task) await waitForTask(task.id, 10_000).catch(() => undefined);
	});
});
