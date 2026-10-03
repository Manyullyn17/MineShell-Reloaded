import { describe, expect, it } from 'vitest';
import { fixLink, sameOriginPath } from './links';

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

describe('sameOriginPath', () => {
	const origin = 'http://192.168.0.200:5173';

	it('keeps paths on this site, with query and hash', () => {
		expect(sameOriginPath('/settings', origin)).toBe('/settings');
		expect(sameOriginPath('/instances/a/mods?tab=x#top', origin)).toBe('/instances/a/mods?tab=x#top');
		expect(sameOriginPath(`${origin}/settings`, origin)).toBe('/settings');
	});

	it.each([
		'//evil.example/phish',
		'/\\evil.example/phish',
		'\\evil.example',
		'https://evil.example/',
		'http://192.168.0.200:8080/other-service',
		'javascript:alert(1)',
		'/%2F%2Fevil.example'
	])('refuses %s', (next) => {
		const result = sameOriginPath(next, origin);
		expect(new URL(result, origin).origin).toBe(origin);
	});

	it('falls back to / for nothing', () => {
		expect(sameOriginPath(null, origin)).toBe('/');
		expect(sameOriginPath('', origin)).toBe('/');
	});
});
