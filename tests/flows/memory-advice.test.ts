import { describe, expect, it } from 'vitest';

const { markMemoryChanged, memoryAdvice } = await import('#lib/server/memoryadvice.js');
const { db } = await import('#lib/server/db/index.js');
const { heapSamples, playerSessions } = await import('#lib/server/db/schema.js');
const { createInstance, reload } = await import('../helpers/instances');
const { fakeProcesses, spawnCalls } = await import('../helpers/process');

const GB = 1024 ** 3;

describe('memory advice for a server', () => {
	it('reads the heap samples kept for it', async () => {
		const s = await createInstance({ modloader: 'fabric', minecraftVersion: '1.20.1', memoryMaxMb: 16384, createdAt: Date.now() - 10 * 86_400_000 });
		fakeProcesses(() => ({ stdout: '' }));
		const now = Date.now();
		const rows = Array.from({ length: 8 * 60 }, (_, m) => ({ instanceId: s.id, timestamp: now - m * 60_000, usedBytes: (1 + (m % 10) * 1.3) * GB, maxBytes: 16 * GB }));
		db.insert(heapSamples).values(rows).run();
		// Nobody online yet: an empty server's heap does not show what it needs.
		expect(await memoryAdvice(reload(s.id))).toMatchObject({ kind: 'unknown', hours: 8, playedHours: 0 });
		db.insert(playerSessions).values({ instanceId: s.id, player: 'Steve', joinedAt: now - 8 * 3_600_000, leftAt: null }).run();
		expect(await memoryAdvice(reload(s.id))).toMatchObject({ kind: 'less', currentMb: 16384, suggestedMb: 3072 });
	});

	it('counts an out-of-memory crash until the memory is changed', async () => {
		const s = await createInstance({ modloader: 'fabric', minecraftVersion: '1.20.1', memoryMaxMb: 4096, createdAt: Date.now() - 10 * 86_400_000 });
		const crashAt = Date.now() - 86_400_000;
		fakeProcesses((cmd, args) => {
			if (cmd !== 'journalctl' || !args.includes('--case-sensitive=false')) return { stdout: '' };
			const since = Number(args.find((a) => a.startsWith('--since=@'))!.slice(9)) * 1000;
			return { stdout: since <= crashAt ? JSON.stringify({ __REALTIME_TIMESTAMP: String(crashAt * 1000), MESSAGE: 'java.lang.OutOfMemoryError: Java heap space' }) + '\n' : '' };
		});
		expect(await memoryAdvice(reload(s.id))).toMatchObject({ kind: 'more', reason: 'out-of-memory', oomAt: crashAt });
		const grep = spawnCalls.find((c) => c.args.includes('--case-sensitive=false'))!.args;
		expect(grep[grep.indexOf('-g') + 1]).toBe('java\\.lang\\.OutOfMemoryError');
		markMemoryChanged(s.id);
		expect(await memoryAdvice(reload(s.id))).toMatchObject({ kind: 'unknown' });
	});
});
