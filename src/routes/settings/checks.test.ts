import { afterEach, describe, expect, it } from 'vitest';
import { actions } from './+page.server';
import { getSftpSettings, saveSftpSettings } from '#lib/server/sftp.js';
import { logKeepDays, setLogKeepDays } from '#lib/server/logretention.js';
import { createInstance, reload, systemdStopped } from '../../../tests/helpers/instances';
import { testPorts } from '../../../tests/helpers/ports';
import { resetProcesses } from '../../../tests/helpers/process';
import { post } from '../../../tests/helpers/routes';

afterEach(() => {
	resetProcesses();
	saveSftpSettings({ enabled: true, host: null, port: null, user: null });
	setLogKeepDays(0);
});

/** MineShell settings that take a number or a name: refused unless it is one, saving nothing. */

describe("moving a server's port from the port overview", () => {
	it('moves only ports that have their own setting, to a real port, not one the server already has', async () => {
		systemdStopped();
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', ...testPorts() });
		const move = (fields: Record<string, string>) => post(actions.portChange, { fields: { instanceId: instance.id, ...fields } });

		expect(await post(actions.portChange, { fields: { instanceId: 'no-such-server', kind: 'game', port: '30000' } })).toMatchObject({ status: 404 });
		for (const kind of ['query', 'toString', '']) {
			expect(await move({ kind, port: '30000' }), kind).toMatchObject({
				status: 400,
				data: { message: 'That port follows the game port; change the game port instead.' }
			});
		}
		for (const port of ['', 'abc', '0', '70000', '30000.5']) {
			expect(await move({ kind: 'game', port }), port).toMatchObject({ status: 400, data: { message: 'Ports go from 1 to 65535.' } });
		}
		expect(await move({ kind: 'game', port: String(instance.rconPort) })).toMatchObject({ status: 400, data: { message: "That is this server's RCON port." } });
		expect(reload(instance.id)).toMatchObject({ serverPort: instance.serverPort, rconPort: instance.rconPort });

		expect(await move({ kind: 'game', port: String(instance.serverPort + 4) })).toMatchObject({ ok: true });
		expect(reload(instance.id).serverPort).toBe(instance.serverPort + 4);
	});
});

describe('the SFTP address shown under Files', () => {
	it('takes a host name or address, an account name and a port, nothing else', async () => {
		const sftp = (fields: Record<string, string>) => post(actions.sftp, { fields: { sftpEnabled: 'on', ...fields } });
		const refusals: [Record<string, string>, string][] = [
			[{ sftpHost: 'host; rm -rf ~' }, 'The host is a name or an IP address, nothing else.'],
			[{ sftpHost: 'user@host' }, 'The host is a name or an IP address, nothing else.'],
			[{ sftpUser: 'root;id' }, 'That is not an account name.'],
			[{ sftpUser: '-oProxyCommand=x' }, 'That is not an account name.'],
			[{ sftpPort: '0' }, 'The port is a number from 1 to 65535.'],
			[{ sftpPort: '22x' }, 'The port is a number from 1 to 65535.']
		];
		for (const [fields, message] of refusals) {
			expect(await sftp(fields), JSON.stringify(fields)).toMatchObject({ status: 400, data: { message } });
		}
		expect(getSftpSettings()).toEqual({ enabled: true, host: null, port: null, user: null });

		expect(await sftp({ sftpHost: ' nas.lan ', sftpUser: 'minecraft', sftpPort: '2222' })).toMatchObject({ ok: true });
		expect(getSftpSettings()).toEqual({ enabled: true, host: 'nas.lan', port: 2222, user: 'minecraft' });
		expect(await post(actions.sftp, { fields: { sftpHost: '', sftpUser: '', sftpPort: '' } })).toMatchObject({ ok: true });
		expect(getSftpSettings()).toEqual({ enabled: false, host: null, port: null, user: null });
	});
});

describe('how long old logs are kept', () => {
	it('takes a whole number of days from 0 to 3650, saving nothing else', async () => {
		const save = (logDays: string) => post(actions.logDays, { fields: { logDays } });
		for (const bad of ['', 'abc', '-1', '1.5', '3651']) {
			expect(await save(bad), bad).toMatchObject({ status: 400, data: { message: 'Keep logs 0 to 3650 days (0 keeps them all).' } });
		}
		expect(logKeepDays()).toBe(0);
		expect(await save(' 90 ')).toMatchObject({ ok: true });
		expect(logKeepDays()).toBe(90);
		expect(await save('0')).toMatchObject({ ok: true });
		expect(logKeepDays()).toBe(0);
	});
});
