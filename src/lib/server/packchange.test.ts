import { describe, expect, it } from 'vitest';
import type { ServerInstance } from './db/schema';
import type { ParsedPack } from './packs';
import { packTopLevel, targetLoaderFor, targetModNames } from './packchange';

function pack(overrides: Partial<ParsedPack> = {}): ParsedPack {
	return {
		kind: 'mrpack',
		name: 'Pack',
		version: '2',
		minecraftVersion: '1.20.1',
		modloader: 'fabric',
		modloaderVersion: '0.16.0',
		downloads: [],
		overrideEntries: [],
		zip: null,
		...overrides
	};
}

const download = (target: string) => ({ target, urls: ['https://x'], hash: null, required: true });

describe('targetModNames', () => {
	it('collects jars from downloads and from bundled overrides', () => {
		const names = targetModNames(
			pack({
				downloads: [download('mods/a.jar'), download('resourcepacks/r.zip')],
				overrideEntries: ['overrides/mods/bundled.jar', 'overrides/mods/sub/nested.jar', 'overrides/config/x.cfg']
			})
		);
		expect([...names].sort()).toEqual(['a.jar', 'bundled.jar']);
	});
});

describe('packTopLevel', () => {
	it('lists folders the pack ships, never protected or loader entries', () => {
		const tops = packTopLevel(
			pack({
				downloads: [download('mods/a.jar'), download('resourcepacks/r.zip')],
				overrideEntries: [
					'overrides/config/x.cfg',
					'overrides/scripts/a.zs',
					'server-overrides/server.properties',
					'overrides/eula.txt',
					'overrides/libraries/x.jar',
					'overrides/options.txt'
				]
			})
		);
		expect(tops).toEqual(['config', 'options.txt', 'resourcepacks', 'scripts']);
	});
});

describe('targetLoaderFor', () => {
	const instance = (o: Partial<ServerInstance>) =>
		({ modloader: 'forge', modloaderVersion: '14.23.5.2860', minecraftVersion: '1.12.2', ...o }) as ServerInstance;

	it('keeps a Cleanroom instance on Cleanroom for a Forge 1.12.2 pack', () => {
		expect(
			targetLoaderFor(
				instance({ modloader: 'cleanroom', modloaderVersion: '0.5.17-alpha' }),
				pack({ modloader: 'forge', minecraftVersion: '1.12.2', modloaderVersion: '14.23.5.2860' })
			)
		).toEqual({ loader: 'cleanroom', version: '0.5.17-alpha' });
	});

	it("uses the pack's loader build, or keeps the current one when the pack does not say", () => {
		expect(targetLoaderFor(instance({}), pack({ modloader: 'forge', minecraftVersion: '1.12.2', modloaderVersion: '14.23.5.2859' }))).toEqual({
			loader: 'forge',
			version: '14.23.5.2859'
		});
		expect(targetLoaderFor(instance({}), pack({ modloader: 'forge', minecraftVersion: '1.12.2', modloaderVersion: null }))).toEqual({
			loader: 'forge',
			version: '14.23.5.2860'
		});
		expect(targetLoaderFor(instance({}), pack({ modloader: 'forge', minecraftVersion: '1.16.5', modloaderVersion: null }))).toEqual({
			loader: 'forge',
			version: null
		});
	});
});
