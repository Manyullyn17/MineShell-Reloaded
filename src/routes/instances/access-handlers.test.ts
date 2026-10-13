import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type { Access, InstanceGrant } from '#lib/shared/access.js';

// The install action's catalog and installers, so it decides mod or data pack without the network.
const installs = vi.hoisted(() => ({ mods: [] as string[], datapacks: [] as string[] }));
vi.mock('#lib/server/mods/index.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/mods/index.js')>()),
	getModProvider: () => ({
		id: 'modrinth',
		getProject: async (id: string) => ({ id, slug: id, name: id, projectUrl: null, iconUrl: null }),
		getVersion: async (id: string) => ({ id: `${id}-1`, loaders: id === 'terralith' ? ['datapack'] : ['fabric'] })
	}),
	installModVersion: async (_: unknown, __: unknown, meta: { name: string }) => (installs.mods.push(meta.name), meta.name)
}));
vi.mock('#lib/server/mods/datapacks.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/mods/datapacks.js')>()),
	installDatapackVersion: async (_: unknown, __: unknown, meta: { name: string }) => (installs.datapacks.push(meta.name), meta.name)
}));

const players = await import('./[id]/players/+page.server');
const world = await import('./[id]/world/+page.server');
const mods = await import('./[id]/mods/+page.server');
const tasks = await import('../tasks/+page.server');
const settings = await import('./[id]/settings/+page.server');
const { startTask } = await import('#lib/server/tasks.js');
const { createInstance } = await import('../../../tests/helpers/instances');

/**
 * The checks the access policy leaves to handlers (policy.ts, `handler(...)`):
 * what was posted decides the permission.
 */

const access = (id: string, grant: Partial<InstanceGrant>): Access => ({
	owner: false,
	globalAdmin: false,
	canCreate: false,
	instances: { [id]: { admin: false, permissions: [], playerView: 'none', playerEdit: 'none', ...grant } }
});

async function post(action: unknown, id: string | undefined, who: Access, fields: Record<string, string>) {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	const request = new Request('http://localhost/', { method: 'POST', body: form });
	try {
		return await (action as (event: never) => unknown)({ params: { id }, request, locals: { access: who } } as never);
	} catch (err) {
		if (isHttpError(err)) return { refused: err.status };
		throw err;
	}
}

const server = () => createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' });

describe('access checked in handlers', () => {
	it('the ops list needs console access as well as player management', async () => {
		const { id } = await server();
		expect(await post(players.actions.add, id, access(id, { permissions: ['players.manage'] }), { list: 'ops', name: 'Steve' })).toEqual({ refused: 403 });
		expect(await post(players.actions.remove, id, access(id, { permissions: ['players.manage'] }), { list: 'ops', name: 'Steve' })).toEqual({ refused: 403 });
		// Past the check (the name lookup then fails offline, which is not a refusal).
		expect(await post(players.actions.add, id, access(id, { permissions: ['players.manage', 'console.command'] }), { list: 'ops', name: 'Steve' })).not.toEqual({ refused: 403 });
		expect(await post(players.actions.remove, id, access(id, { permissions: ['players.manage'] }), { list: 'bans', name: 'Steve' })).not.toEqual({ refused: 403 });
	});

	it('unpinning a snapshot needs backup deletion; pinning only backup creation', async () => {
		const { id } = await server();
		const creator = access(id, { permissions: ['backups.create'] });
		expect(await post(world.actions.pinSnapshot, id, creator, { id: 'x', pinned: 'false' })).toEqual({ refused: 403 });
		expect(await post(world.actions.pinSnapshot, id, creator, { id: 'x', pinned: 'true' })).not.toEqual({ refused: 403 });
		expect(await post(world.actions.pinSnapshot, id, access(id, { permissions: ['backups.delete'] }), { id: 'x', pinned: 'false' })).not.toEqual({ refused: 403 });
	});

	it('installing needs mods for a mod and datapacks for a data pack', async () => {
		const { id } = await server();
		const datapacker = access(id, { permissions: ['datapacks'] });
		expect(await post(mods.actions.install, id, datapacker, { projectId: 'sodium', versionId: 'sodium-1' })).toEqual({ refused: 403 });
		expect(installs.mods).toEqual([]);
		expect(await post(mods.actions.install, id, datapacker, { projectId: 'terralith', versionId: 'terralith-1' })).toMatchObject({ ok: true });
		expect(installs.datapacks).toEqual(['terralith']);
		expect(await post(mods.actions.install, id, access(id, { permissions: ['mods'] }), { projectId: 'terralith', versionId: 'terralith-1' })).toEqual({ refused: 403 });
	});

	it("copying a server's access list along needs a global admin", async () => {
		const { id } = await server();
		const who = { ...access(id, { permissions: ['duplicate', 'files'] }), canCreate: true };
		expect(await post(settings.actions.clone, id, who, { name: 'Copy', copyAccess: 'on' })).toEqual({ refused: 403 });
	});

	it("cancelling a task needs admin of its server; one of no server needs a global admin", async () => {
		const { id } = await server();
		const stuck = startTask({ label: 'test', instanceId: id }, () => new Promise(() => undefined));
		const global = startTask({ label: 'test', instanceId: null }, () => new Promise(() => undefined));
		expect(await post(tasks.actions.cancel, undefined, access(id, { permissions: ['power', 'mods'] }), { id: stuck })).toEqual({ refused: 403 });
		expect(await post(tasks.actions.cancel, undefined, access(id, { admin: true }), { id: stuck })).toMatchObject({ ok: true });
		expect(await post(tasks.actions.cancel, undefined, access(id, { admin: true }), { id: global })).toEqual({ refused: 403 });
	});
});
