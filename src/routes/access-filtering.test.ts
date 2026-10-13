import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Access, InstanceGrant } from '#lib/shared/access.js';
import { FULL_ACCESS } from '#lib/shared/access.js';

// A last run that crashed, without a journal to read it from.
vi.mock('#lib/server/lastcrash.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/lastcrash.js')>()),
	lastCrash: async () => ({ log: 'line one\n[Server thread/ERROR]: player 1.2.3.4 broke it', diagnosis: Promise.resolve([]) })
}));

const layout = await import('./+layout.server');
const dashboard = await import('./+page.server');
const tasksApi = await import('./api/tasks/+server');
const overview = await import('./instances/[id]/+page.server');
const players = await import('./instances/[id]/players/+page.server');
const settings = await import('./instances/[id]/settings/+page.server');
const ports = await import('./api/instances/[id]/ports/+server');
const appSettings = await import('./settings/+page.server');
const { startTask } = await import('#lib/server/tasks.js');
const { addScheduledCommand } = await import('#lib/server/scheduledcommands.js');
const { createInstance } = await import('../../tests/helpers/instances');
const { fakeProcesses, resetProcesses } = await import('../../tests/helpers/process');
const { testPorts } = await import('../../tests/helpers/ports');

/** What each account's page data holds: other servers, and secrets, left out. */

afterEach(resetProcesses);
const stopped = () => fakeProcesses(() => ({ stdout: 'ActiveState=inactive\nSubState=dead\n' }));

const access = (grants: Record<string, Partial<InstanceGrant>>, flags: Partial<Access> = {}): Access => ({
	owner: false,
	globalAdmin: false,
	canCreate: false,
	...flags,
	instances: Object.fromEntries(
		Object.entries(grants).map(([id, g]) => [id, { admin: false, permissions: [], playerView: 'none', playerEdit: 'none', ...g }])
	)
});

async function server(files: Record<string, string> = {}) {
	return createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', ...testPorts() }, files);
}

const load = (module: { load?: unknown }, event: Record<string, unknown>) =>
	(module.load as (e: never) => Promise<Record<string, unknown>>)({ url: new URL('http://localhost/'), ...event } as never);

describe('lists show only the servers an account may see', () => {
	it('the rail, the server list and the task count', async () => {
		stopped();
		const mine = await server();
		const other = await server();
		const locals = { authenticated: true, authRequired: true, access: access({ [mine.id]: { permissions: ['view'] } }) };
		const rail = (await load(layout, { locals })) as { railInstances: { id: string }[] };
		expect(rail.railInstances.map((i) => i.id)).toContain(mine.id);
		expect(rail.railInstances.map((i) => i.id)).not.toContain(other.id);
		const list = (await load(dashboard, { locals })) as { instances: { id: string }[] };
		expect(list.instances.map((i) => i.id)).toEqual([mine.id]);
	});

	it("Activity: a server's tasks to whoever sees the server, tasks of no server to global admins", async () => {
		const mine = await server();
		const other = await server();
		const own = startTask({ label: 'mine', instanceId: mine.id }, () => new Promise(() => undefined));
		const theirs = startTask({ label: 'theirs', instanceId: other.id }, () => new Promise(() => undefined));
		const global = startTask({ label: 'java', instanceId: null }, () => new Promise(() => undefined));
		const seen = async (who: Access) => {
			const response = await (tasksApi.GET as (e: never) => Promise<Response>)({ url: new URL('http://localhost/api/tasks'), locals: { authenticated: true, access: who } } as never);
			return ((await response.json()) as { tasks: { id: string }[] }).tasks.map((t) => t.id);
		};
		const ids = await seen(access({ [mine.id]: { permissions: ['view'] } }));
		expect(ids).toContain(own);
		expect(ids).not.toContain(theirs);
		expect(ids).not.toContain(global);
		expect(await seen(access({}, { globalAdmin: true }))).toEqual(expect.arrayContaining([own, theirs, global]));
	});
});

describe('page data leaves out what the account may not read', () => {
	it("the overview: the crash shows, its log lines only with console access", async () => {
		stopped();
		const { id } = await server();
		const crash = async (who: Access) =>
			(await (await load(overview, { params: { id }, locals: { access: who } })).crash) as { tail: string | null } | null;
		expect(await crash(access({ [id]: { permissions: ['view'] } }))).toEqual({ tail: null });
		expect((await crash(access({ [id]: { permissions: ['console.read'] } })))?.tail).toContain('1.2.3.4');
	});

	it('Players: IP bans only for whoever manages bans', async () => {
		stopped();
		const { id } = await server({ 'banned-ips.json': JSON.stringify([{ ip: '1.2.3.4', reason: 'x', created: '', source: '', expires: 'forever' }]) });
		const ipBans = async (who: Access) => ((await load(players, { params: { id }, locals: { access: who } })).lists as { ipBans: unknown[] }).ipBans;
		expect(await ipBans(access({ [id]: { permissions: ['view'] } }))).toEqual([]);
		expect(await ipBans(access({ [id]: { permissions: ['players.manage'] } }))).toHaveLength(1);
	});

	it('Settings: scheduled commands only with console access', async () => {
		stopped();
		const { id } = await server();
		addScheduledCommand(id, 'say hello', { everyMinutes: 60 });
		const commands = async (who: Access) => (await load(settings, { params: { id }, locals: { access: who } })).scheduledCommands;
		expect(await commands(access({ [id]: { permissions: ['settings.view'] } }))).toEqual([]);
		expect(await commands(access({ [id]: { permissions: ['settings.view', 'console.read'] } }))).toHaveLength(1);
	});

	it('MineShell settings: the playit.gg account links only for the owner', async () => {
		stopped();
		const playit = async (who: Access) =>
			(await load(appSettings, { locals: { access: who, user: null } })).playit as { dashboard: string | null; owner: boolean };
		expect(await playit(access({}, { globalAdmin: true }))).toMatchObject({ dashboard: null, owner: false });
		expect((await playit(FULL_ACCESS)).dashboard).toMatch(/^https:\/\/playit\.gg/);
	});
});

describe("another server's ports", () => {
	it('are not named to an account that cannot see it, nor moved by one that cannot change it', async () => {
		stopped();
		const mine = await server();
		const other = await server();
		const who = access({ [mine.id]: { permissions: ['settings.edit'] } });
		const check = await (ports.GET as (e: never) => Promise<Response>)({
			params: { id: mine.id },
			url: new URL(`http://localhost/?port=${other.serverPort}&field=game`),
			locals: { authenticated: true, access: who }
		} as never);
		expect(((await check.json()) as { other: unknown }).other).toMatchObject({ name: 'Another server', movable: false });

		const form = new FormData();
		form.set('serverPort', String(other.serverPort));
		form.set('rconPort', String(mine.rconPort));
		form.set('moveGame', 'swap');
		const result = await (settings.actions.network as (e: never) => unknown)({
			params: { id: mine.id },
			request: new Request('http://localhost/', { method: 'POST', body: form }),
			locals: { access: who }
		} as never);
		expect(result).toMatchObject({ status: 400, data: { message: expect.stringMatching(/^Another server .* may not change that server/) } });
	});
});
