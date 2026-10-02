import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';

/**
 * Real API responses, recorded once and replayed offline.
 *
 *   useRecordedHttp('modrinth');          // at the top of a test file
 *
 * Replays tests/fixtures/http/<name>.json and fails on any request that was
 * not recorded. To record (or re-record after an API changed), run the file
 * against the live APIs:
 *
 *   RECORD_HTTP=1 npx vitest run src/lib/server/mods/modrinth.test.ts
 *
 * Without useRecordedHttp, any fetch throws (see tests/setup.ts).
 */

type Recorded = { status: number; contentType: string | null; json?: unknown; body?: string };
export type FetchCall = { method: string; url: string };

const FIXTURES = path.resolve('tests/fixtures/http');
export const fetchCalls: FetchCall[] = [];

function keyFor(method: string, url: string, body: unknown): string {
	if (body === undefined || body === null) return `${method} ${url}`;
	const digest = crypto.createHash('sha1').update(String(body)).digest('hex').slice(0, 12);
	return `${method} ${url} #${digest}`;
}

export function useRecordedHttp(
	name: string,
	opts: { extra?: Record<string, () => Response | Promise<Response>> } = {}
): void {
	const file = path.join(FIXTURES, `${name}.json`);
	const recording = process.env.RECORD_HTTP === '1';
	const store: Record<string, Recorded> = recording
		? {}
		: fs.existsSync(file)
			? JSON.parse(fs.readFileSync(file, 'utf8'))
			: {};
	const realFetch = (globalThis as { __realFetch?: typeof fetch }).__realFetch!;
	const guard = globalThis.fetch;

	const replay: typeof fetch = async (input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? 'GET').toUpperCase();
		fetchCalls.push({ method, url });
		const extra = opts.extra?.[url];
		if (extra) return extra();
		const key = keyFor(method, url, init?.body);

		if (recording) {
			const res = await realFetch(input, init);
			const text = await res.text();
			const contentType = res.headers.get('content-type');
			let json: unknown;
			try {
				json = JSON.parse(text);
			} catch {
				json = undefined;
			}
			store[key] = json === undefined ? { status: res.status, contentType, body: text } : { status: res.status, contentType, json };
			return new Response(text, { status: res.status, headers: contentType ? { 'content-type': contentType } : {} });
		}

		const rec = store[key];
		if (!rec) {
			throw new Error(
				`No recorded response for ${key} in tests/fixtures/http/${name}.json. Re-record with RECORD_HTTP=1 npx vitest run <this test file>.`
			);
		}
		const body = rec.json !== undefined ? JSON.stringify(rec.json) : (rec.body ?? '');
		return new Response(body, {
			status: rec.status,
			headers: rec.contentType ? { 'content-type': rec.contentType } : {}
		});
	};

	beforeAll(() => {
		fetchCalls.length = 0;
		globalThis.fetch = replay;
	});
	afterAll(() => {
		globalThis.fetch = guard;
		if (recording) {
			fs.mkdirSync(FIXTURES, { recursive: true });
			const sorted = Object.fromEntries(Object.entries(store).sort(([a], [b]) => a.localeCompare(b)));
			fs.writeFileSync(file, JSON.stringify(sorted, null, 1) + '\n');
		}
	});
}
