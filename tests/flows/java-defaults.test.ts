import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { javaRuntimes, settings } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getJavaDefaults, resolveJava, setJavaDefault } from '$lib/server/java';
import { clearJava } from '../helpers/instances';

function install(path: string, majorVersion: number, versionString: string) {
	db.insert(javaRuntimes).values({ path, majorVersion, versionString, lastSeenAt: Date.now() }).run();
}

const MC_1_20_1 = { minecraftVersion: '1.20.1', modloader: 'fabric' };

describe('Java per major version', () => {
	beforeEach(() => {
		clearJava();
		db.delete(settings).where(eq(settings.key, 'java.defaults')).run();
	});

	it('picks the newest build of the needed major, whatever order they were found in', () => {
		install('/opt/b/java', 17, '17.0.9');
		install('/opt/a/java', 17, '17.0.12');
		install('/opt/c/java', 21, '21.0.4');
		expect(resolveJava(MC_1_20_1)).toMatchObject({ path: '/opt/a/java', origin: 'auto' });
	});

	it('breaks a tie between equal builds by path', () => {
		install('/usr/lib/jvm/z/java', 8, '1.8.0_422');
		install('/usr/lib/jvm/a/java', 8, '1.8.0_422');
		install('/usr/lib/jvm/old/java', 8, '1.8.0_382');
		expect(resolveJava({ minecraftVersion: '1.12.2', modloader: 'forge' }).path).toBe('/usr/lib/jvm/a/java');
	});

	it('uses the default set for the major, and the newest again once it is cleared', () => {
		install('/opt/a/java', 17, '17.0.12');
		install('/opt/b/java', 17, '17.0.9');
		setJavaDefault(17, '/opt/b/java');
		expect(resolveJava(MC_1_20_1)).toMatchObject({ path: '/opt/b/java', origin: 'default' });
		setJavaDefault(17, null);
		expect(resolveJava(MC_1_20_1)).toMatchObject({ path: '/opt/a/java', origin: 'auto' });
	});

	it('ignores a default whose runtime is gone', () => {
		install('/opt/a/java', 17, '17.0.12');
		setJavaDefault(17, '/opt/removed/java');
		expect(resolveJava(MC_1_20_1)).toMatchObject({ path: '/opt/a/java', origin: 'auto' });
	});

	it('applies the default of the major it falls back to', () => {
		install('/opt/a/java', 21, '21.0.4');
		install('/opt/b/java', 21, '21.0.2');
		setJavaDefault(21, '/opt/b/java');
		// 1.20.1 nominally wants 17; 21 is acceptable.
		expect(resolveJava(MC_1_20_1)).toMatchObject({ path: '/opt/b/java', origin: 'default', majorVersion: 21 });
	});

	it('lets a pinned path win over the default', () => {
		install('/opt/a/java', 17, '17.0.12');
		install('/opt/b/java', 17, '17.0.9');
		setJavaDefault(17, '/opt/b/java');
		expect(resolveJava({ ...MC_1_20_1, explicitPath: '/opt/a/java' })).toMatchObject({ path: '/opt/a/java', origin: 'explicit' });
	});

	it('reads a broken or hand-edited settings row as no defaults', () => {
		db.insert(settings).values({ key: 'java.defaults', value: '{"17": 5, "x": "/a", "21": "/opt/java"' }).run();
		expect(getJavaDefaults()).toEqual({});
		db.update(settings).set({ value: '{"17": 5, "x": "/a", "21": "/opt/java"}' }).where(eq(settings.key, 'java.defaults')).run();
		expect(getJavaDefaults()).toEqual({ 21: '/opt/java' });
	});
});
