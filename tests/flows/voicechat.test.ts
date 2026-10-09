import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const voice = await import('#lib/server/voicechat.js');
const { createInstance } = await import('../helpers/instances');

const CONFIG = 'config/voicechat/voicechat-server.properties';
const server = (files: Record<string, string> = {}) => createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1' }, files);

/** Holds a UDP port for the test, as another program would. */
async function holdUdp(port: number): Promise<dgram.Socket> {
	const socket = dgram.createSocket('udp4');
	await new Promise<void>((resolve) => socket.bind(port, '0.0.0.0', resolve));
	return socket;
}

describe('Simple Voice Chat', () => {
	it('is found by its jar or its config, and its port read (-1 is the game port)', async () => {
		expect(await voice.voiceChat(await server({ 'mods/sodium.jar': 'x' }))).toBeNull();
		expect(await voice.voiceChat(await server({ 'mods/sodium.jar': 'x', 'mods/voicechat-fabric-1.21.1-2.5.30.jar.disabled': 'x' }))).toBeNull();
		// Before its first start: no config yet, the default port.
		expect(await voice.voiceChat(await server({ 'mods/voicechat-fabric-1.21.1-2.5.30.jar': 'x' }))).toEqual({ port: 24454, host: '' });
		expect(await voice.voiceChat(await server({ [CONFIG]: '# Simple Voice Chat\nport=24460\nvoice_host=voice.example:1234\n' }))).toEqual({
			port: 24460,
			host: 'voice.example:1234'
		});
		const shared = await server({ [CONFIG]: 'port=-1\n' });
		expect((await voice.voiceChat(shared))?.port).toBe(shared.serverPort);
	});

	it('changes the port and voice_host, keeping every other line', async () => {
		const s = await server({ [CONFIG]: '# comment\nmax_voice_distance=48.0\nport=24454\n' });
		await voice.setVoiceConfig(s, { port: 24470, host: 'x.ply.gg:5000' });
		expect(await fs.readFile(path.join(s.path, CONFIG), 'utf8')).toBe('# comment\nmax_voice_distance=48.0\nport=24470\nvoice_host=x.ply.gg:5000\n');
	});

	it('refuses a start when a running server or another program has the port', async () => {
		const a = await server({ [CONFIG]: 'port=24481\n' });
		const b = await server({ [CONFIG]: 'port=24481\n' });
		const others = [a, b];
		expect(await voice.voicePortProblem(b, others, async (id) => id === a.id)).toMatch(new RegExp(`used by ${a.name}, which is running`));
		// The other one stopped: free.
		expect(await voice.voicePortProblem(b, others, async () => false)).toBeNull();

		const held = await holdUdp(24482);
		try {
			const c = await server({ [CONFIG]: 'port=24482\n' });
			expect(await voice.voicePortProblem(c, [c], async () => false)).toMatch(/in use by something else/);
		} finally {
			held.close();
		}
	});

	it("gives a copy or a second install of a pack its own port, and leaves a free one alone", async () => {
		const first = await server({ [CONFIG]: `port=${24490}\n` });
		const copy = await server({ [CONFIG]: `# kept\nport=${24490}\n` });
		const port = await voice.claimVoicePort(copy, [first, copy]);
		expect(port).not.toBeNull();
		expect(port).not.toBe(24490);
		expect((await voice.voiceChat(copy))?.port).toBe(port);
		expect(await fs.readFile(path.join(copy.path, CONFIG), 'utf8')).toContain('# kept');

		const alone = await server({ [CONFIG]: 'port=24495\n' });
		expect(await voice.claimVoicePort(alone, [first, copy, alone])).toBeNull();
		expect(await voice.claimVoicePort(await server({ 'mods/sodium.jar': 'x' }), [first])).toBeNull();
	});
});
