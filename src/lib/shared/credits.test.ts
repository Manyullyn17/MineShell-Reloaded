import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CREDITS, MINECRAFT_DISCLAIMER } from './credits';

describe('credits', () => {
	// README's Credits section is written from this list; the About page shows the list itself.
	const readme = fs.readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

	it.each(CREDITS.flatMap((g) => g.items.map((i) => [i.name, i] as const)))('README credits %s', (_name, item) => {
		expect(readme).toContain(`- [${item.name}](${item.url}) — ${item.use}`);
	});

	it('README carries the Minecraft disclaimer', () => {
		expect(readme).toContain(MINECRAFT_DISCLAIMER);
	});
});
