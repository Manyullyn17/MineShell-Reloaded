import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { learnJavaRequirement, requiredJavaMajor } from './java';
import { db } from './db';
import { settings } from './db/schema';
import { fetchCalls, useRecordedHttp } from '../../../tests/helpers/http';

// A Minecraft version newer than any built-in rule, asking for a Java the
// rules would never guess: the declared value has to win.
const MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
useRecordedHttp('none', {
	extra: {
		[MANIFEST]: () =>
			Response.json({
				latest: { release: '99.1', snapshot: '99.1' },
				versions: [{ id: '99.1', type: 'release', url: 'https://mojang.test/99.1.json' }]
			}),
		'https://mojang.test/99.1.json': () => Response.json({ id: '99.1', javaVersion: { component: 'java-runtime-x', majorVersion: 30 } })
	}
});

describe('learnJavaRequirement', () => {
	it("uses Mojang's declared Java over the built-in rules, and remembers it", async () => {
		expect(requiredJavaMajor('99.1')).toBe(25); // rules alone
		await learnJavaRequirement('99.1');
		expect(requiredJavaMajor('99.1')).toBe(30);

		const row = db.select().from(settings).where(eq(settings.key, 'java.minecraftRequirements')).get();
		expect(JSON.parse(row!.value)['99.1']).toBe(30);

		// Known now: no second lookup.
		const before = fetchCalls.length;
		await learnJavaRequirement('99.1');
		expect(fetchCalls.length).toBe(before);
	});

	it('keeps the rules when the version is unknown or Mojang cannot be reached', async () => {
		await learnJavaRequirement('0.0.1-not-real');
		expect(requiredJavaMajor('0.0.1-not-real')).toBe(8);
	});

	it('does not apply to Cleanroom, which sets its own Java', () => {
		expect(requiredJavaMajor('1.12.2', 'cleanroom', '0.5.17-alpha')).toBe(25);
	});
});
