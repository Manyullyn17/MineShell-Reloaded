import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, BlockedDownloadError, downloadFile } from './download';
import { allowAddress, allowedAddresses, recentRefusals, removeAllowedAddress, withoutAllowed } from './downloadaccess';
import { getTask, startTask } from './tasks';
import { POLICY } from './access/policy';
import * as allowedApi from '../../routes/api/downloads/allowed/+server';
import { ls, tempDir } from '../../../tests/helpers/fs';

const guard = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = guard;
	for (const a of allowedAddresses()) removeAllowedAddress(a.address);
});

/** Answers each URL from the map; anything else is a test failure. */
function serve(responses: Record<string, () => Response>): string[] {
	const asked: string[] = [];
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		asked.push(url);
		const respond = responses[url];
		if (!respond) throw new Error(`unexpected fetch ${url}`);
		return respond();
	}) as typeof fetch;
	return asked;
}

describe('assertPublicUrl', () => {
	it('refuses this machine, the local network and link-local addresses', async () => {
		for (const url of [
			'http://127.0.0.1:3000/api',
			'http://2130706433/',
			'http://10.1.2.3/',
			'http://192.168.1.10/',
			'http://172.20.0.1/',
			'http://169.254.169.254/latest/meta-data/',
			'http://0.0.0.0/',
			'http://[::1]/',
			'http://[::ffff:127.0.0.1]/',
			'http://[fd00::1]/',
			'http://[fe80::1]/'
		]) {
			await expect(assertPublicUrl(url), url).rejects.toThrow(BlockedDownloadError);
		}
	});

	it('refuses schemes other than http and https', async () => {
		await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/only http and https/);
		await expect(assertPublicUrl('ftp://example.com/a.jar')).rejects.toThrow(/only http and https/);
	});

	it('refuses a name that resolves to a private address', async () => {
		vi.mocked(dns.lookup).mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as never);
		await expect(assertPublicUrl('https://internal.example.com/a.jar')).rejects.toThrow(/internal\.example\.com is 10\.0\.0\.5, an address on your local network/);
	});

	it('names the refused host and address, and keeps it among the recent refusals', async () => {
		const err = await assertPublicUrl('http://127.0.0.1:8080/x.jar').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(BlockedDownloadError);
		expect((err as BlockedDownloadError).blocked).toEqual({ host: '127.0.0.1', address: '127.0.0.1', kind: 'this machine' });
		expect(recentRefusals()[0]).toMatchObject({ host: '127.0.0.1', address: '127.0.0.1', url: 'http://127.0.0.1:8080/x.jar' });
	});

	it('lets an allowed address through, that exact one only', async () => {
		vi.mocked(dns.lookup).mockResolvedValue([{ address: '192.168.1.20', family: 4 }] as never);
		try {
			allowAddress('192.168.1.20', 'mirror.lan');
			await expect(assertPublicUrl('http://mirror.lan/a.jar')).resolves.toBeUndefined();
			await expect(assertPublicUrl('http://192.168.1.21/a.jar')).rejects.toThrow(BlockedDownloadError);
			// Allowing takes it off the refusals and off tasks' questions.
			expect(recentRefusals().some((r) => r.address === '192.168.1.20')).toBe(false);
			const blocked = [{ host: 'mirror.lan', address: '192.168.1.20', kind: 'x' }, { host: 'b', address: '10.0.0.9', kind: 'y' }];
			expect(withoutAllowed({ blocked }).blocked.map((b) => b.address)).toEqual(['10.0.0.9']);
			removeAllowedAddress('192.168.1.20');
			await expect(assertPublicUrl('http://mirror.lan/a.jar')).rejects.toThrow(BlockedDownloadError);
		} finally {
			vi.mocked(dns.lookup).mockReset();
			vi.mocked(dns.lookup).mockImplementation((async () => [{ address: '203.0.113.10', family: 4 }]) as never);
		}
	});

	it('does not refuse the benchmarking range, which fake-IP proxies answer every name from', async () => {
		await expect(assertPublicUrl('http://198.18.0.5/a.jar')).resolves.toBeUndefined();
	});

	it('lets public addresses through', async () => {
		await expect(assertPublicUrl('https://cdn.modrinth.com/data/a.jar')).resolves.toBeUndefined();
		await expect(assertPublicUrl('https://[2606:4700::1]/a.jar')).resolves.toBeUndefined();
	});
});

describe('allowing an address', () => {
	it('is for global admins only', () => {
		expect(POLICY['/api/downloads/allowed']).toEqual({ methods: { POST: 'globalAdmin', DELETE: 'globalAdmin' } });
	});

	it('takes exact non-public addresses, never public ones', async () => {
		const post = (body: unknown) =>
			allowedApi.POST({ request: new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }) } as never);
		await expect(post({ address: '8.8.8.8' })).rejects.toMatchObject({ status: 400 });
		await expect(post({ address: '10.0.0.0/8' })).rejects.toMatchObject({ status: 400 });
		await post({ address: '10.0.0.7', host: 'nas.lan' });
		expect(allowedAddresses()).toMatchObject([{ address: '10.0.0.7', host: 'nas.lan' }]);
		await allowedApi.DELETE({ url: new URL('http://x/?address=10.0.0.7') } as never);
		expect(allowedAddresses()).toEqual([]);
	});

	it('asks on the task the refusal happened in', async () => {
		const id = startTask({ label: 'test' }, async () => {
			await assertPublicUrl('http://[fd00::1]/a.jar');
		});
		await vi.waitFor(() => expect(getTask(id)?.state).toBe('failed'));
		expect(getTask(id)?.blocked).toEqual([{ host: 'fd00::1', address: 'fd00::1', kind: 'an address on your local network' }]);
	});
});

describe('downloadFile', () => {
	it('follows redirects to public hosts', async () => {
		const asked = serve({
			'https://edge.example.com/a.jar': () => new Response(null, { status: 302, headers: { location: 'https://files.example.com/a.jar' } }),
			'https://files.example.com/a.jar': () => new Response('jar')
		});
		const dir = await tempDir();
		await downloadFile('https://edge.example.com/a.jar', path.join(dir, 'a.jar'));
		expect(await fs.readFile(path.join(dir, 'a.jar'), 'utf8')).toBe('jar');
		expect(asked).toEqual(['https://edge.example.com/a.jar', 'https://files.example.com/a.jar']);
	});

	it('does not follow a redirect to a private address', async () => {
		// A pack's public URL can redirect anywhere; fetch's own redirect handling would follow it unchecked.
		const asked = serve({
			'https://evil.example.com/a.jar': () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3000/api/instances' } })
		});
		const dir = await tempDir();
		await expect(downloadFile('https://evil.example.com/a.jar', path.join(dir, 'a.jar'))).rejects.toThrow(BlockedDownloadError);
		expect(asked).toEqual(['https://evil.example.com/a.jar']);
		expect(await ls(dir)).toEqual([]);
	});
});
