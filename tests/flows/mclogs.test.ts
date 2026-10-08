import { describe, expect, it } from 'vitest';

const { useRecordedHttp, fetchCalls } = await import('../helpers/http');
const { analyseLog, prepareLog, shareLog, shareOf, unshareLog } = await import('#lib/server/mclogs.js');
const { createInstance } = await import('../helpers/instances');

const sent: { url: string; init?: RequestInit }[] = [];
let deleteAnswer = () => Response.json({ success: true });
const json = (url: string, make: () => Response) => (init?: RequestInit) => (sent.push({ url, init }), make());
useRecordedHttp('mclogs', {
	extra: {
		'https://api.mclo.gs/1/analyse': json('analyse', () =>
			Response.json({
				success: true,
				title: 'Fabric 1.20.1 Server Log',
				analysis: {
					problems: [{ message: "The mod 'Sodium' is missing the required mod 'fabric-api'.", counter: 1, entry: { lines: [{ number: 2 }] }, solutions: [{ message: "Install the mod 'fabric-api'." }] }],
					information: [{ message: 'Minecraft version: 1.20.1', label: 'Minecraft version', value: '1.20.1' }]
				}
			})
		),
		'https://api.mclo.gs/1/log': json('log', () =>
			Response.json({ success: true, id: 'WnMMikq', created: 1_791_000_000, expires: 1_798_776_000, url: 'https://mclo.gs/WnMMikq', token: 'secret-token' })
		),
		'https://api.mclo.gs/1/log/WnMMikq': json('delete', () => deleteAnswer())
	}
});

describe('mclo.gs', () => {
	it('reads its analysis: problems with solutions, and what it learned', async () => {
		expect(await analyseLog('[x] [main/ERROR]: Incompatible mods found!')).toEqual({
			title: 'Fabric 1.20.1 Server Log',
			problems: [{ message: "The mod 'Sodium' is missing the required mod 'fabric-api'.", solutions: ["Install the mod 'fabric-api'."], line: 2 }],
			information: [{ label: 'Minecraft version', value: '1.20.1' }]
		});
	});

	it('sends the end of a long log, within its limits, without colour codes', () => {
		const lines = Array.from({ length: 30_000 }, (_, i) => `\x1b[32mline ${i}\x1b[0m`);
		const out = prepareLog(lines.join('\n')).split('\n');
		expect(out).toHaveLength(25_000);
		expect(out.at(-1)).toBe('line 29999');
	});

	it('shares a log once, keeps the token, and deletes it with that token', async () => {
		const s = await createInstance({ modloader: 'fabric', minecraftVersion: '1.20.1' });
		const share = await shareLog(s, 'run', 'a'.repeat(32), 'log text');
		expect(share).toEqual({ url: 'https://mclo.gs/WnMMikq', createdAt: 1_791_000_000_000, expiresAt: 1_798_776_000_000 });
		expect(JSON.parse(String(sent.find((c) => c.url === 'log')!.init!.body))).toEqual({ content: 'log text', source: 'MineShell' });
		// Shared again: the same link, no second upload.
		const uploads = fetchCalls.filter((c) => c.url.endsWith('/1/log')).length;
		await shareLog(s, 'run', 'a'.repeat(32), 'log text');
		expect(fetchCalls.filter((c) => c.url.endsWith('/1/log')).length).toBe(uploads);

		await unshareLog(s.id, 'run', 'a'.repeat(32));
		const del = sent.find((c) => c.url === 'delete')!.init!;
		expect(del.method).toBe('DELETE');
		expect((del.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
		expect(shareOf(s.id, 'run', 'a'.repeat(32))).toBeNull();
	});

	it('forgets a share deleted on mclo.gs already, but keeps one it could not delete', async () => {
		const s = await createInstance({ modloader: 'fabric', minecraftVersion: '1.20.1' });
		await shareLog(s, 'file', 'logs/latest.log', 'x');
		deleteAnswer = () => Response.json({ success: false, error: 'Invalid token.' }, { status: 403 });
		await expect(unshareLog(s.id, 'file', 'logs/latest.log')).rejects.toThrow(/Invalid token/);
		expect(shareOf(s.id, 'file', 'logs/latest.log')).not.toBeNull();
		deleteAnswer = () => Response.json({ success: false, error: 'Log not found.' }, { status: 404 });
		await unshareLog(s.id, 'file', 'logs/latest.log');
		expect(shareOf(s.id, 'file', 'logs/latest.log')).toBeNull();
	});
});
