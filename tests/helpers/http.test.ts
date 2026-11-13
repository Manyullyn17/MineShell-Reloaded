import { describe, expect, it } from 'vitest';
import { fetchThroughRateLimit } from './http';

const answers = (...statuses: number[]) => {
	const calls: string[] = [];
	const fake = (async (input: Parameters<typeof fetch>[0]) => {
		calls.push(String(input));
		const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
		return new Response(status === 204 ? null : `answer ${calls.length}`, { status });
	}) as typeof fetch;
	return { fake, calls };
};

describe('recording against live APIs', () => {
	it('asks again while the API answers 429, instead of testing or recording that', async () => {
		const { fake, calls } = answers(429, 429, 200);
		const waits: number[] = [];
		const res = await fetchThroughRateLimit(fake, 'https://api.example/x', undefined, async (ms) => void waits.push(ms));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('answer 3');
		expect(calls).toHaveLength(3);
		expect(waits).toEqual([1_000, 2_000]);
	});

	it('gives up after a few tries with the last answer, and leaves other answers alone', async () => {
		const limited = answers(429);
		const res = await fetchThroughRateLimit(limited.fake, 'https://api.example/x', undefined, async () => {});
		expect(res.status).toBe(429);
		expect(limited.calls).toHaveLength(5);

		const missing = answers(404);
		expect((await fetchThroughRateLimit(missing.fake, 'https://api.example/x', undefined, async () => {})).status).toBe(404);
		expect(missing.calls).toHaveLength(1);
	});
});
