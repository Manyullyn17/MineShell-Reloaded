import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { operatorCommand, serveOverTailscale, serveState, stopServingOverTailscale, tailscaleState } from './tailscale';
import { fakeProcesses, spawnCalls, type FakeResult } from '../../../tests/helpers/process';

const NAME = 'box.tail1234.ts.net';
const status = (state = 'Running', certs: string[] = [NAME]) =>
	JSON.stringify({ BackendState: state, Self: { DNSName: `${NAME}.`, TailscaleIPs: ['100.64.0.7', 'fd7a:115c:a1e0::7'] }, CertDomains: certs });
const ME = os.userInfo().username;
const served = (proxy: string, funnel = false) =>
	JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: proxy } } } }, ...(funnel ? { AllowFunnel: { [`${NAME}:443`]: true } } : {}) });

/** `tailscale` answering as given; `serve` for every change it is asked to make. */
function tailscale(answers: { status?: FakeResult; serveStatus?: string; serve?: FakeResult; prefs?: FakeResult }) {
	fakeProcesses((cmd, args) => {
		if (cmd !== 'tailscale') return {};
		if (args[0] === 'status') return answers.status ?? { stdout: status() };
		if (args[0] === 'debug' && args[1] === 'prefs') return answers.prefs ?? { stdout: JSON.stringify({ WantRunning: true, OperatorUser: ME }) };
		if (args[0] === 'serve' && args[1] === 'status') return { stdout: answers.serveStatus ?? '{}' };
		return answers.serve ?? {};
	});
}
const changes = () => spawnCalls.filter((c) => c.cmd === 'tailscale' && c.args[0] === 'serve' && c.args[1] !== 'status').map((c) => c.args.join(' '));

const port = process.env.PORT;
beforeEach(() => {
	process.env.PORT = '3000';
});
afterEach(() => {
	if (port === undefined) delete process.env.PORT;
	else process.env.PORT = port;
});

describe("what Tailscale's https port does", () => {
	it('is this MineShell when it forwards to its port on this machine', () => {
		for (const proxy of ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://127.0.0.1:3000/']) {
			expect(serveState(JSON.parse(served(proxy)), NAME, 3000), proxy).toEqual({ kind: 'ours', url: `https://${NAME}`, funnel: false });
		}
		expect(serveState(JSON.parse(served('http://127.0.0.1:3000', true)), NAME, 3000)).toMatchObject({ kind: 'ours', funnel: true });
	});

	it('is something else for another port, path or forward', () => {
		expect(serveState(JSON.parse(served('http://127.0.0.1:8080')), NAME, 3000)).toEqual({ kind: 'other', target: '/ -> http://127.0.0.1:8080' });
		expect(serveState({ TCP: { '443': { TCPForward: '127.0.0.1:22' } } }, NAME, 3000)).toEqual({ kind: 'other', target: 'tcp://127.0.0.1:22' });
		expect(serveState({}, NAME, 3000)).toEqual({ kind: 'free' });
		expect(serveState(null, NAME, 3000)).toEqual({ kind: 'free' });
	});
});

describe('Tailscale on this machine', () => {
	it('is missing, down or up with its name and whether it hands out certificates', async () => {
		tailscale({ status: { code: 127, stderr: 'spawn tailscale ENOENT' } });
		expect(await tailscaleState()).toEqual({ kind: 'missing' });
		tailscale({ status: { stdout: status('NeedsLogin'), code: 1 } });
		expect(await tailscaleState()).toMatchObject({ kind: 'down', message: expect.stringContaining('tailscale up') });
		tailscale({ status: { stdout: status('Running', []) } });
		expect(await tailscaleState()).toEqual({
			kind: 'up',
			name: NAME,
			https: false,
			serve: { kind: 'free' },
			port: 3000,
			operator: true,
			account: ME,
			admin: { machine: 'https://login.tailscale.com/admin/machines/100.64.0.7', machines: 'https://login.tailscale.com/admin/machines' }
		});
	});

	// Changing what Tailscale serves needs root or its operator: known before anyone tries.
	it('knows whether this account is Tailscale\'s operator, or that it cannot tell', async () => {
		tailscale({ prefs: { stdout: JSON.stringify({ WantRunning: true }) } });
		expect(await tailscaleState()).toMatchObject({ operator: false });
		tailscale({ prefs: { stdout: JSON.stringify({ OperatorUser: 'someone-else' }) } });
		expect(await tailscaleState()).toMatchObject({ operator: false });
		tailscale({ prefs: { code: 1, stderr: 'unknown subcommand' } });
		expect(await tailscaleState()).toMatchObject({ operator: null });
	});
});

describe('serving MineShell over Tailscale', () => {
	it("forwards Tailscale's https port to MineShell's, kept across reboots", async () => {
		tailscale({});
		expect(await serveOverTailscale()).toEqual({ ok: true, url: `https://${NAME}` });
		expect(changes()).toEqual(['serve --bg --https=443 http://127.0.0.1:3000']);
	});

	// A forward someone set up for another program is not MineShell's to replace.
	it('leaves a https port that serves something else alone, and does not stop it either', async () => {
		tailscale({ serveStatus: served('http://127.0.0.1:8080') });
		expect(await serveOverTailscale()).toMatchObject({ ok: false, message: expect.stringContaining('http://127.0.0.1:8080') });
		expect(await stopServingOverTailscale()).toMatchObject({ ok: false });
		expect(changes()).toEqual([]);
	});

	it('says what to run once when Tailscale refuses a non-operator', async () => {
		tailscale({ serve: { code: 1, stderr: 'Access denied: serve config denied\n\nUse \'sudo tailscale serve ...\'' } });
		expect(await serveOverTailscale()).toMatchObject({ ok: false, message: expect.stringContaining(operatorCommand()) });
	});

	it('does not try before this account is the operator, and says what to run', async () => {
		tailscale({ prefs: { stdout: JSON.stringify({ OperatorUser: '' }) } });
		expect(await serveOverTailscale()).toMatchObject({ ok: false, message: expect.stringContaining(`--operator=${ME}`) });
		expect(changes()).toEqual([]);
	});

	it('needs the tailnet to hand out certificates first', async () => {
		tailscale({ status: { stdout: status('Running', []) } });
		expect(await serveOverTailscale()).toMatchObject({ ok: false, message: expect.stringContaining('HTTPS certificates') });
		expect(changes()).toEqual([]);
	});

	it('stops only its own forward', async () => {
		tailscale({ serveStatus: served('http://127.0.0.1:3000') });
		expect(await stopServingOverTailscale()).toEqual({ ok: true });
		expect(changes()).toEqual(['serve --https=443 off']);
	});
});
