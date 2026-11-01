import { describe, expect, it, vi } from 'vitest';
import { OWNER_PASSWORD, owner } from '../../../tests/helpers/auth';
import { cookieJar, load, post } from '../../../tests/helpers/routes';

// Tests run with MINESHELL_AUTH=off (vite.config.ts), where /setup is never offered anyway.
// `fresh` stands in for an install nobody has set up yet (the test database keeps its owner).
let fresh = false;
vi.mock('#lib/server/auth.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('#lib/server/auth.js')>();
	return { ...real, authEnabled: () => true, ownerExists: () => !fresh && real.ownerExists() };
});

const page = await import('./+page.server');
const { actions } = page;
const { verifyLogin } = await import('#lib/server/auth.js');

/**
 * /setup sets the owner's password and signs in without one: once there is an
 * owner, it must do neither, or anyone reaching it would take MineShell over.
 */
describe('setup once there is an owner', () => {
	it('is not offered', async () => {
		owner();
		expect(await load(page)).toEqual({ redirect: '/' });
	});

	it('changes no password and signs nobody in', async () => {
		owner();
		const cookies = cookieJar();
		const result = await post(actions.default, { fields: { password: 'taken-over-now', confirm: 'taken-over-now' }, cookies });
		expect(result).toEqual({ redirect: '/login' });
		expect(cookies.values.size).toBe(0);
		expect(verifyLogin('admin', 'taken-over-now')).toBeNull();
		expect(verifyLogin('admin', OWNER_PASSWORD)).toMatchObject({ isOwner: true });
	});
});

/**
 * Before setup, whoever reached /setup first became the owner: on a public
 * address, any scanner. The code only someone on the machine can read stops that.
 */
describe('setup before there is an owner', () => {
	it('asks for the setup code, and signs nobody in without it', async () => {
		fresh = true;
		try {
			for (const code of [undefined, '', 'AAAA-BBBB-CCCC']) {
				const cookies = cookieJar();
				const fields: Record<string, string> = { password: 'taken-over-now', confirm: 'taken-over-now' };
				if (code !== undefined) fields.code = code;
				const result = await post(actions.default, { fields, cookies });
				expect(result).toMatchObject({ status: 400, data: { message: expect.stringContaining('setup code') } });
				expect(cookies.values.size).toBe(0);
			}
		} finally {
			fresh = false;
		}
		expect(verifyLogin('admin', 'taken-over-now')).toBeNull();
	});
});
