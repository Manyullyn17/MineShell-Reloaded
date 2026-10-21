import { describe, expect, it, vi } from 'vitest';
import { OWNER_PASSWORD, owner } from '../../../tests/helpers/auth';
import { cookieJar, load, post } from '../../../tests/helpers/routes';

// Tests run with MINESHELL_AUTH=off (vite.config.ts), where /setup is never offered anyway.
vi.mock('#lib/server/auth.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/auth.js')>()),
	authEnabled: () => true
}));

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
