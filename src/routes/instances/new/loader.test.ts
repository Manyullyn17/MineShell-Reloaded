import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { actions } from './+page.server';
import { actions as settings } from '../[id]/settings/+page.server';
import { GET as migratePlan } from '../../api/instances/[id]/migrate/+server';
import { db } from '#lib/server/db/index.js';
import { serverInstances } from '#lib/server/db/schema.js';
import { addJava, clearJava, createInstance, reload, systemdStopped } from '../../../../tests/helpers/instances';
import { resetProcesses } from '../../../../tests/helpers/process';
import { call, post } from '../../../../tests/helpers/routes';

afterEach(() => {
	resetProcesses();
	clearJava();
});

/** A new server from a mod loader: what the form posts is checked before any server is made. */

let counter = 0;
const named = () => `Loader form ${process.pid}-${++counter}`;
const made = (name: string) => db.select().from(serverInstances).where(eq(serverInstances.name, name)).all();

async function refused(fields: Record<string, string>, message: string | RegExp) {
	const name = fields.name ?? named();
	const result = await post(actions.loader, { fields: { name, minecraftVersion: '1.21.1', modloader: 'fabric', ...fields } });
	expect(result).toMatchObject({ data: { ok: false, message: typeof message === 'string' ? message : expect.stringMatching(message) } });
	// The asker's mistake, not MineShell's: never a 500.
	expect((result as { status: number }).status).toBe(400);
	if (name) expect(made(name)).toEqual([]);
}

describe('a new server from a mod loader', () => {
	it('needs a name and a Minecraft version', async () => {
		await refused({ name: '  ' }, 'Give the server a name.');
		await refused({ minecraftVersion: '' }, 'Pick a Minecraft version.');
	});

	it('needs a loader MineShell has, whatever the name', async () => {
		addJava(21);
		for (const modloader of ['paper', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) {
			await refused({ modloader }, `Unknown mod loader "${modloader}".`);
		}
	});

	it('refuses a loader on a Minecraft version it does not run on', async () => {
		await refused({ modloader: 'cleanroom', minecraftVersion: '1.20.1' }, /^Cleanroom only runs on Minecraft 1\.12\.2/);
	});

	it('refuses a game port that is not one', async () => {
		addJava(21);
		for (const serverPort of ['abc', '0', '70000', '25565.5']) {
			await refused({ serverPort }, 'The game port is a number from 1 to 65535.');
		}
	});
});

describe("moving a server to another loader (Settings' migrate)", () => {
	it('needs a loader MineShell has, whatever the name', async () => {
		systemdStopped();
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' });
		for (const loader of ['paper', 'toString', 'constructor', '__proto__']) {
			const result = await post(settings.migrate, { params: { id: instance.id }, fields: { minecraft: '1.21.1', loader, snapshot: 'no' } });
			expect(result, loader).toMatchObject({ status: 400, data: { message: 'Pick a Minecraft version and a loader.' } });
		}
		expect(reload(instance.id)).toMatchObject({ modloader: 'fabric', status: 'ready' });
	});

	it('previews only a loader MineShell has', async () => {
		const instance = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' });
		for (const loader of ['paper', 'toString', 'constructor']) {
			const response = await call(migratePlan, { params: { id: instance.id }, url: `http://localhost/?mc=1.21.1&loader=${loader}` });
			expect(response.status, loader).toBe(400);
			expect(await response.json()).toMatchObject({ message: 'Pick a Minecraft version and a loader.' });
		}
	});
});
