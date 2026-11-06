import { describe, expect, it } from 'vitest';
import { unchangedAnswer } from './keeppage.js';

const here = 'http://host:3000/instances/a/export?tab=x';
const data = (path: string, invalidated = '111') => `http://host:3000${path}/__data.json?tab=x&x-sveltekit-invalidated=${invalidated}`;

describe('unchangedAnswer', () => {
	// A reload cut off put up Kit's 500 page in place of the page.
	it('answers a failed reload of this page with one skip per node', async () => {
		const answer = unchangedAnswer(data('/instances/a/export'), here);
		expect(answer?.ok).toBe(true);
		expect(await answer?.text()).toBe('{"type":"data","nodes":[{"type":"skip"},{"type":"skip"},{"type":"skip"}]}\n');
	});

	it('counts the nodes the reload asked for', async () => {
		const answer = unchangedAnswer(data('/instances/a/export', '10'), here);
		expect(JSON.parse((await answer?.text()) ?? '').nodes).toHaveLength(2);
	});

	it('takes the home page, whose data is at the root', () => {
		expect(unchangedAnswer('http://host:3000/__data.json?x-sveltekit-invalidated=1', 'http://host:3000/')).not.toBeNull();
	});

	it('leaves everything else failing', () => {
		expect(unchangedAnswer(data('/instances/b/export'), here)).toBeNull();
		expect(unchangedAnswer('http://host:3000/instances/a/export/__data.json?x-sveltekit-invalidated=111', here)).toBeNull();
		expect(unchangedAnswer('http://other/instances/a/export/__data.json?tab=x&x-sveltekit-invalidated=1', here)).toBeNull();
		expect(unchangedAnswer('http://host:3000/instances/a/export/__data.json?tab=x', here)).toBeNull();
		expect(unchangedAnswer('/api/rail', here)).toBeNull();
	});
});
