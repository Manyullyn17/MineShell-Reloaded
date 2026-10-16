import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { downloadFile } from './download';
import { DATA_DIR } from './config';
import { fetchCalls, useRecordedHttp } from '../../../tests/helpers/http';

const served: Record<string, () => Response> = {
	'https://mods.test/sodium.jar': () => new Response('sodium 0.6.0, only in filecache.test.ts')
};
useRecordedHttp('none', { extra: served });
// Off for every other test file (tests/setup.ts).
(globalThis as { __mineshellFileCache?: boolean }).__mineshellFileCache = true;

const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');
const dir = (name: string) => path.join(DATA_DIR, 'filecache-test', name);

describe('downloads of content MineShell has already', () => {
	it('copies an earlier download with the same hash instead of fetching it', async () => {
		const hash = { algo: 'sha1' as const, value: sha1('sodium 0.6.0, only in filecache.test.ts') };
		await downloadFile('https://mods.test/sodium.jar', path.join(dir('a'), 'mods/sodium.jar'), { hash });
		const fetched = fetchCalls.length;

		// Another server, another name, same content: no request.
		await downloadFile('https://mods.test/sodium.jar', path.join(dir('b'), 'mods/sodium-renamed.jar'), { hash });
		expect(fetchCalls.length).toBe(fetched);
		expect(await fs.readFile(path.join(dir('b'), 'mods/sodium-renamed.jar'), 'utf8')).toBe('sodium 0.6.0, only in filecache.test.ts');
	});

	it('never copies a file that changed since, and never goes by name', async () => {
		const hash = { algo: 'sha1' as const, value: sha1('sodium 0.6.0, only in filecache.test.ts') };
		const first = path.join(dir('c'), 'mods/sodium.jar');
		await downloadFile('https://mods.test/sodium.jar', first, { hash });
		// A pack's patched jar written over it under the same name: the record no longer holds.
		await fs.writeFile(first, 'patched sodium');
		for (const other of ['a', 'b']) await fs.rm(dir(other), { recursive: true, force: true });

		const fetched = fetchCalls.length;
		await downloadFile('https://mods.test/sodium.jar', path.join(dir('d'), 'mods/sodium.jar'), { hash });
		expect(fetchCalls.length).toBe(fetched + 1);
		expect(await fs.readFile(path.join(dir('d'), 'mods/sodium.jar'), 'utf8')).toBe('sodium 0.6.0, only in filecache.test.ts');

		// Without a hash nothing is looked up or recorded.
		await downloadFile('https://mods.test/sodium.jar', path.join(dir('e'), 'mods/sodium.jar'));
		expect(fetchCalls.length).toBe(fetched + 2);
	});
});
