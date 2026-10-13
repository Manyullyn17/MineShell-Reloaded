import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, BlockedDownloadError, downloadFile } from './download';
import { ls, tempDir } from '../../../tests/helpers/fs';

const guard = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = guard;
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
		await expect(assertPublicUrl('https://internal.example.com/a.jar')).rejects.toThrow(/not a public address/);
	});

	it('lets public addresses through', async () => {
		await expect(assertPublicUrl('https://cdn.modrinth.com/data/a.jar')).resolves.toBeUndefined();
		await expect(assertPublicUrl('https://[2606:4700::1]/a.jar')).resolves.toBeUndefined();
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
