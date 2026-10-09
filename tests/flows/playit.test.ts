import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { useRecordedHttp } from '../helpers/http';
import { fakeProcesses, spawnCalls } from '../helpers/process';

/**
 * playit.gg (playit.ts): linking by claim, the agent's unit, tunnels per
 * server. playit's API is faked here with the answers the real one gave on
 * a free account (ROADMAP, "playit.gg tunnels"); nothing reaches playit.
 */

const API = 'https://api.playit.gg';
const AGENT_ID = '4be858c1-1ac1-45ed-ad5f-d1eeada4b273';
const BINARY = Buffer.from('#!/bin/sh\necho fake playit agent\n');

type Tunnel = { id: string; name: string; display_address: string; tunnel_type: string; agent_config: { fields: { name: string; value: string }[] }; disabled_reason: null };
const fake = {
	setupAnswers: [] as string[],
	tunnels: [] as Tunnel[],
	/** Made, but not in the agent's run data yet (playit lists new tunnels there a moment later). */
	unlisted: [] as Tunnel[],
	/** Answers for the next creates, before one succeeds. */
	createErrors: [] as string[],
	calls: [] as { route: string; body: Record<string, unknown>; key: string | null }[]
};

const json = (status: 'success' | 'fail', data: unknown) => new Response(JSON.stringify({ status, data }), { headers: { 'content-type': 'application/json' } });
function route(name: string, answer: (body: Record<string, unknown>) => Response) {
	return [
		`${API}${name}`,
		(init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? '{}'));
			const auth = new Headers(init?.headers).get('authorization');
			fake.calls.push({ route: name, body, key: auth?.replace('Agent-Key ', '') ?? null });
			return answer(body);
		}
	] as const;
}

const { AGENT_BINARIES, AGENT_UNIT, agentProblem, setRouting, AGENT_VERSION, PLAYIT_DIR, claimState, linkedAgent, makePrivate, makePublic, playitStatus, publicAddress, serverTunnel, startLink, syncTunnel, timing, unlink } =
	await import('#lib/server/playit.js');
const { systemdUnitDir } = await import('#lib/server/config.js');
const { deleteInstance } = await import('#lib/server/instances.js');
const { createInstance } = await import('../helpers/instances');

const arch = AGENT_BINARIES[process.arch];
useRecordedHttp('playit', {
	extra: Object.fromEntries([
		[`https://github.com/playit-cloud/playit-agent/releases/download/v${AGENT_VERSION}/${arch.file}`, () => new Response(BINARY)],
		route('/claim/setup', () => json('success', fake.setupAnswers.shift() ?? 'UserAccepted')),
		route('/claim/exchange', () => json('success', { secret_key: 'secret-agent-key' })),
		route('/v1/agents/rundata', () =>
			json('success', { agent_id: AGENT_ID, tunnels: fake.tunnels, pending: [], notices: [], permissions: { is_self_managed: true, has_premium: false, account_status: 'verified' } })
		),
		route('/tunnels/create', (body) => {
			const error = fake.createErrors.shift();
			if (error) return json('fail', error);
			if ((body.alloc as { details?: { region?: string } } | null)?.details?.region) return json('fail', 'RequiresPlayitPremium');
			const id = crypto.randomUUID();
			const origin = (body.origin as { data: { local_ip: string; local_port: number } }).data;
			fake.tunnels.push({
				id,
				name: String(body.name),
				display_address: `tunnel-${fake.tunnels.length}.tun.ply.gg`,
				tunnel_type: 'minecraft-java',
				agent_config: { fields: [{ name: 'local_ip', value: origin.local_ip }, { name: 'local_port', value: String(origin.local_port) }] },
				disabled_reason: null
			});
			return json('success', { id });
		}),
		route('/tunnels/update', (body) => {
			const tunnel = fake.tunnels.find((t) => t.id === body.tunnel_id);
			if (!tunnel) return json('fail', 'TunnelNotFound');
			tunnel.agent_config.fields = [{ name: 'local_ip', value: String(body.local_ip) }, { name: 'local_port', value: String(body.local_port) }];
			return json('success', null);
		}),
		route('/tunnels/list', (body) =>
			json('success', {
				tunnels: [...fake.tunnels, ...fake.unlisted]
					.filter((t) => !body.tunnel_id || t.id === body.tunnel_id)
					.map((t) => {
						const value = (name: string) => t.agent_config.fields.find((f) => f.name === name)?.value;
						return { id: t.id, origin: { type: 'agent', data: { agent_id: AGENT_ID, local_ip: value('local_ip'), local_port: Number(value('local_port')) } } };
					})
			})
		),
		route('/info/pops', () =>
			json('success', {
				pops: [
					{ pop: 'Germany', name: 'Germany', region: 'germany', online: true, ip4_premium: false },
					{ pop: 'Sydney', name: 'Sydney', region: 'australia', online: true, ip4_premium: false }
				]
			})
		),
		route('/agents/routing/set', () => json('success', null)),
		route('/tunnels/delete', (body) => {
			const before = fake.tunnels.length;
			fake.tunnels = fake.tunnels.filter((t) => t.id !== body.tunnel_id);
			return before === fake.tunnels.length ? json('fail', 'TunnelNotFound') : json('success', null);
		})
	])
});

/** systemctl: is-active answers active once the unit is enabled. */
let agentActive = false;
function fakeSystemctl() {
	fakeProcesses((cmd, args) => {
		if (cmd !== 'systemctl') return { code: 1 };
		if (args.includes('enable')) agentActive = true;
		if (args.includes('disable')) agentActive = false;
		if (args.includes('is-active')) return { stdout: agentActive && args.includes(AGENT_UNIT) ? 'active\n' : 'inactive\n', code: agentActive ? 0 : 3 };
		return {};
	});
}

beforeAll(() => {
	timing.pollMs = 1;
	// The fake binary's digest stands in for the release's.
	arch.sha256 = crypto.createHash('sha256').update(BINARY).digest('hex');
});

async function link() {
	fakeSystemctl();
	fake.setupAnswers = ['WaitingForUserVisit', 'WaitingForUser', 'UserAccepted'];
	const started = startLink();
	expect(started.url).toMatch(/^https:\/\/playit\.gg\/claim\/[0-9a-f]{10}$/);
	for (let i = 0; i < 200 && claimState()?.state !== 'linked' && claimState()?.state !== 'failed'; i++) await new Promise((r) => setTimeout(r, 5));
	expect(claimState()).toMatchObject({ state: 'linked' });
}

describe('playit.gg', () => {
	it('links by claim: approval, key, agent binary verified, unit enabled', async () => {
		await link();
		// Claimed as a self-managed agent, which may create tunnels.
		expect(fake.calls.find((c) => c.route === '/claim/setup')?.body).toMatchObject({ agent_type: 'self-managed', version: `playit ${AGENT_VERSION}` });
		expect(linkedAgent().agentId).toBe(AGENT_ID);
		const keyFile = path.join(PLAYIT_DIR, 'agent.key');
		expect(await fs.readFile(keyFile, 'utf8')).toBe('secret-agent-key');
		expect((await fs.stat(keyFile)).mode & 0o777).toBe(0o600);
		expect(await fs.readFile(path.join(PLAYIT_DIR, `playit-${AGENT_VERSION}`))).toEqual(BINARY);
		const unit = await fs.readFile(path.join(systemdUnitDir(), AGENT_UNIT), 'utf8');
		// The socket in the runtime dir: a path under the data dir can be too long for a socket.
		expect(unit).toContain(`--secret-path "${keyFile}" --socket-path %t/`);
		expect(spawnCalls).toContainEqual({ cmd: 'systemctl', args: ['--user', 'enable', '--now', AGENT_UNIT] });
		expect(() => startLink()).toThrow(/linked already/);
	});

	it('makes a server public, follows its port, and deletes the tunnel with it', async () => {
		if (!linkedAgent().agentId) await link();
		fakeSystemctl();
		agentActive = true;
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', serverPort: 25601 }, { 'server.properties': 'server-port=25601\n' });
		// Right after linking playit refuses until the agent has connected once.
		fake.createErrors = ['AgentVersionTooOld', 'AgentVersionTooOld'];
		const tunnel = await makePublic(instance);
		const created = fake.calls.filter((c) => c.route === '/tunnels/create').at(-1)!;
		expect(created.key).toBe('secret-agent-key');
		expect(created.body).toMatchObject({
			tunnel_type: 'minecraft-java',
			port_type: 'tcp',
			origin: { type: 'agent', data: { agent_id: AGENT_ID, local_ip: '127.0.0.1', local_port: 25601 } },
			alloc: null
		});
		expect(serverTunnel(instance.id)).toEqual(tunnel);
		expect(publicAddress(instance.id, await playitStatus({ fresh: true }))).toEqual({ address: expect.stringMatching(/\.tun\.ply\.gg$/), pending: false });

		// A fixed region on a free account.
		const other = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', serverPort: 25602 }, {});
		await expect(makePublic(other, 'europe')).rejects.toThrow('That needs playit Premium.');
		expect(serverTunnel(other.id)).toBeNull();

		// The port changed (applies on restart): before the start, the tunnel follows - same tunnel, same address.
		const moved = { ...instance, serverPort: 25611 };
		await syncTunnel(moved);
		expect(fake.calls.filter((c) => c.route === '/tunnels/update').at(-1)?.body).toMatchObject({ tunnel_id: tunnel.tunnelId, local_port: 25611 });
		expect(fake.tunnels.find((t) => t.id === tunnel.tunnelId)?.agent_config.fields).toContainEqual({ name: 'local_port', value: '25611' });

		await deleteInstance(instance, { deleteFiles: true });
		expect(fake.tunnels.some((t) => t.id === tunnel.tunnelId)).toBe(false);
		expect(serverTunnel(instance.id)).toBeNull();
	});

	it('forgets a tunnel deleted on playit.gg, and switching off deletes one', async () => {
		if (!linkedAgent().agentId) await link();
		fakeSystemctl();
		agentActive = true;
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', serverPort: 25603 }, {});
		const tunnel = await makePublic(instance);
		// Just made: not in the run data yet, but on the account. Kept (it was forgotten on the first start).
		fake.unlisted = fake.tunnels.filter((t) => t.id === tunnel.tunnelId);
		fake.tunnels = fake.tunnels.filter((t) => t.id !== tunnel.tunnelId);
		await syncTunnel(instance);
		expect(serverTunnel(instance.id)).toEqual(tunnel);
		// Deleted on playit.gg: forgotten.
		fake.unlisted = [];
		await syncTunnel(instance);
		expect(serverTunnel(instance.id)).toBeNull();

		await makePublic(instance);
		await makePrivate(instance.id);
		expect(serverTunnel(instance.id)).toBeNull();
		expect(fake.tunnels).toHaveLength(0);
	});

	it("explains playit turning a second agent away on a free account, until it connects", async () => {
		let log = '';
		fakeProcesses((cmd) => (cmd === 'journalctl' ? { stdout: log } : {}));
		// What the agent logged when an old agent was still on the account.
		log = 'ERROR playit_agent_core::agent_control: failed to sign and register error=Fail(AgentDisabledOverLimit)\n';
		expect(await agentProblem()).toMatch(/more agents than its plan allows/);
		// The old one removed on playit.gg: it connects by itself.
		log += 'INFO playitd::daemon: playit connected; tunnels loaded agent_id=x tunnel_count=0\n';
		expect(await agentProblem()).toBeNull();
	});

	it("sets where the agent connects through: a playit location or automatic", async () => {
		if (!linkedAgent().agentId) await link();
		await setRouting('Germany');
		expect(fake.calls.filter((c) => c.route === '/agents/routing/set').at(-1)).toMatchObject({
			key: 'secret-agent-key',
			body: { agent_id: AGENT_ID, routing: { type: 'Pop', details: 'Germany' } }
		});
		expect(linkedAgent().routing).toBe('Germany');
		await setRouting('Automatic');
		expect(fake.calls.filter((c) => c.route === '/agents/routing/set').at(-1)?.body.routing).toEqual({ type: 'Automatic' });
		await expect(setRouting('Atlantis')).rejects.toThrow('Unknown playit location.');
		expect(linkedAgent().routing).toBe('Automatic');
	});

	it('unlinks: tunnels deleted, agent stopped and removed, key gone', async () => {
		if (!linkedAgent().agentId) await link();
		fakeSystemctl();
		agentActive = true;
		const instance = await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1', serverPort: 25604 }, {});
		await makePublic(instance);
		await unlink();
		expect(fake.tunnels).toHaveLength(0);
		expect(serverTunnel(instance.id)).toBeNull();
		expect(linkedAgent().agentId).toBeNull();
		expect(spawnCalls).toContainEqual({ cmd: 'systemctl', args: ['--user', 'disable', '--now', AGENT_UNIT] });
		await expect(fs.access(path.join(systemdUnitDir(), AGENT_UNIT))).rejects.toThrow();
		await expect(fs.access(path.join(PLAYIT_DIR, 'agent.key'))).rejects.toThrow();
		await expect(makePublic(instance)).rejects.toThrow(/Link playit.gg first/);
	});
});
