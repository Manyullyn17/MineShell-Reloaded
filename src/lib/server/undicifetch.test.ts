import { afterEach, describe, expect, it, vi } from 'vitest';
import { FormData as UndiciFormData } from 'undici';

const undiciFetch = vi.hoisted(() => vi.fn(async () => new Response('answered')));
vi.mock('undici', async (importOriginal) => ({ ...(await importOriginal<typeof import('undici')>()), fetch: undiciFetch }));
const { useUndiciFetch } = await import('./undicifetch');

const guard = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = guard;
});

describe('useUndiciFetch', () => {
	it("puts the undici package's fetch in place of Node's, and only fetch", async () => {
		const { Request, Response, Headers, FormData } = globalThis;
		useUndiciFetch();
		expect(await (await globalThis.fetch('https://example.com/', { method: 'POST', body: 'x' })).text()).toBe('answered');
		expect(undiciFetch).toHaveBeenCalledWith('https://example.com/', { method: 'POST', body: 'x' });
		expect([globalThis.Request, globalThis.Response, globalThis.Headers, globalThis.FormData]).toEqual([Request, Response, Headers, FormData]);
	});

	it("copies Node's FormData into undici's, which would send it as \"[object FormData]\"", async () => {
		useUndiciFetch();
		const form = new FormData();
		form.append('a', '1');
		form.append('file', new Blob(['jar']), 'mod.jar');
		await globalThis.fetch('https://example.com/', { method: 'POST', body: form });
		const sent = (undiciFetch.mock.calls.at(-1) as unknown as [string, RequestInit])[1].body;
		expect(sent).toBeInstanceOf(UndiciFormData);
		expect((sent as unknown as UndiciFormData).get('a')).toBe('1');
		expect(((sent as unknown as UndiciFormData).get('file') as File).name).toBe('mod.jar');
	});

	it('is a release with the fix (8.12 on), not one Node itself bundles', async () => {
		const { version } = (await import('undici/package.json', { with: { type: 'json' } })).default;
		const [major, minor] = version.split('.').map(Number);
		expect(major > 8 || (major === 8 && minor >= 12)).toBe(true);
	});
});
