import { describe, expect, it } from 'vitest';
import { zipBuffer } from '../../../tests/helpers/fs';
import { peekPack } from './packpeek';

const blob = (buffer: Buffer) => new Blob([new Uint8Array(buffer)]);

describe('peekPack', () => {
	it('reads a CurseForge manifest (deflated)', async () => {
		const zip = zipBuffer({
			'manifest.json': JSON.stringify({
				minecraft: { version: '1.12.2', modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }] }
			}),
			'overrides/config/a.cfg': 'x'.repeat(5000)
		});
		expect(await peekPack(blob(zip))).toEqual({ minecraft: '1.12.2', loader: 'forge' });
	});

	it('reads a .mrpack index (stored)', async () => {
		const zip = zipBuffer(
			{ 'modrinth.index.json': JSON.stringify({ dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.9' } }) },
			{ store: true }
		);
		expect(await peekPack(blob(zip))).toEqual({ minecraft: '1.20.1', loader: 'fabric' });
	});

	it('ignores a manifest that is not at the root', async () => {
		const zip = zipBuffer({ 'overrides/manifest.json': '{"minecraft":{"version":"1.12.2"}}' });
		expect(await peekPack(blob(zip))).toBeNull();
	});

	it('answers null for something that is not a zip', async () => {
		expect(await peekPack(new Blob(['not a zip at all']))).toBeNull();
	});
});
