import { describe, expect, it } from 'vitest';
import { fixLink } from './links';

const base = 'https://www.curseforge.com/minecraft/modpacks/example';

describe('fixLink', () => {
	it('unwraps CurseForge /linkout redirects (target encoded twice)', () => {
		expect(fixLink('/linkout?remoteUrl=https%253a%252f%252fshorturl.at%252fWX8Da', base)).toBe(
			'https://shorturl.at/WX8Da'
		);
		expect(
			fixLink('https://www.curseforge.com/linkout?remoteUrl=https%253a%252f%252fdiscord.gg%252fabc', base)
		).toBe('https://discord.gg/abc');
	});

	it('resolves relative links against the project page', () => {
		expect(fixLink('/minecraft/mc-mods/jei', base)).toBe('https://www.curseforge.com/minecraft/mc-mods/jei');
	});

	it('keeps absolute, mailto and in-page links', () => {
		expect(fixLink('https://github.com/x/y', base)).toBe('https://github.com/x/y');
		expect(fixLink('mailto:a@b.c', base)).toBe('mailto:a@b.c');
		expect(fixLink('#install', base)).toBe('#install');
	});

	it('drops unsafe and unresolvable links', () => {
		expect(fixLink('javascript:alert(1)', base)).toBeNull();
		expect(fixLink('/linkout?remoteUrl=javascript%253aalert(1)', base)).toBeNull();
		expect(fixLink('/minecraft/mc-mods/jei', null)).toBeNull();
	});
});
