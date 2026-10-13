import { describe, expect, it } from 'vitest';
import { can, FULL_ACCESS, type Access, type InstanceGrant } from './access';

const STEVE = '8667ba71-b85a-4004-af54-457a9734eed7';
const ALEX = 'ec561538-f3fd-461d-aff5-086b22154bce';

const account = (grant: Partial<InstanceGrant>): Access => ({
	owner: false,
	globalAdmin: false,
	canCreate: false,
	instances: { a: { admin: false, permissions: [], playerView: 'none', playerEdit: 'none', ...grant } }
});

describe('can', () => {
	it('gives the owner and global admins everything, on every server', () => {
		expect(can(FULL_ACCESS, 'any-server', 'delete')).toBe(true);
		expect(can({ ...account({}), globalAdmin: true }, 'other', 'admin')).toBe(true);
	});

	it('gives an instance admin everything on that server only', () => {
		const access = account({ admin: true });
		expect(can(access, 'a', 'files')).toBe(true);
		expect(can(access, 'a', 'admin')).toBe(true);
		expect(can(access, 'a', 'players.data.edit', ALEX)).toBe(true);
		expect(can(access, 'b', 'view')).toBe(false);
	});

	it('gives a listed permission, what it implies and view, and nothing else', () => {
		const access = account({ permissions: ['settings.edit'] });
		expect(can(access, 'a', 'settings.edit')).toBe(true);
		expect(can(access, 'a', 'settings.view')).toBe(true);
		expect(can(access, 'a', 'view')).toBe(true);
		expect(can(access, 'a', 'power')).toBe(false);
		expect(can(access, 'a', 'admin')).toBe(false);
		expect(can(account({ permissions: ['settings.view'] }), 'a', 'settings.edit')).toBe(false);
	});

	it('limits player data to the chosen UUIDs, which never grow to include later players', () => {
		const access = account({ playerView: [STEVE] });
		expect(can(access, 'a', 'players.data.view', STEVE)).toBe(true);
		expect(can(access, 'a', 'players.data.view', STEVE.toUpperCase())).toBe(true);
		expect(can(access, 'a', 'players.data.view', ALEX)).toBe(false);
		expect(can(access, 'a', 'players.data.view', 'any')).toBe(true);
		expect(can(access, 'a', 'players.data.view', 'all')).toBe(false);
		expect(can(access, 'a', 'players.data.edit', STEVE)).toBe(false);
		// "all" covers whoever joins next.
		expect(can(account({ playerView: 'all' }), 'a', 'players.data.view', ALEX)).toBe(true);
	});

	it('counts editing a player as viewing that player', () => {
		const access = account({ playerEdit: [STEVE] });
		expect(can(access, 'a', 'players.data.view', STEVE)).toBe(true);
		expect(can(access, 'a', 'players.data.edit', STEVE)).toBe(true);
		expect(can(access, 'a', 'players.data.view', ALEX)).toBe(false);
	});

	it('gives nothing on a server without a grant', () => {
		expect(can(account({ permissions: ['power'] }), 'b', 'view')).toBe(false);
	});
});
