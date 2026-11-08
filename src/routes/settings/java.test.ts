import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as page from './+page.server';
import { actions } from './+page.server';
import { db } from '#lib/server/db/index.js';
import { javaRuntimes } from '#lib/server/db/schema.js';
import { forgetJavaBuilds, MANAGED_JAVA_DIR } from '#lib/server/javadownload.js';
import { clearJava, createInstance, systemdStopped } from '../../../tests/helpers/instances';
import { resetProcesses } from '../../../tests/helpers/process';
import { useRecordedHttp } from '../../../tests/helpers/http';
import { call, load, post } from '../../../tests/helpers/routes';
import { GET as builds } from '../api/java/builds/+server';

/** MineShell settings, Java: what a download of a newer build would bring, and to whom. */

const TEMURIN_21 =
	'https://api.adoptium.net/v3/assets/feature_releases/21/ga?architecture=x64&image_type=jre&jvm_impl=hotspot&os=linux&page_size=20&sort_order=DESC&vendor=eclipse';
const release = (name: string) => ({ release_name: name, binaries: [{ image_type: 'jre', package: { name: `${name}.tar.gz`, link: 'https://example.invalid/x.tar.gz', checksum: '0', size: 1 } }] });

useRecordedHttp('none', { extra: { [TEMURIN_21]: () => Response.json([release('jdk-21.0.9+10'), release('jdk-21.0.8+9')]) } });

function runtime(binary: string, major: number, versionString: string) {
	db.insert(javaRuntimes).values({ path: binary, majorVersion: major, versionString, lastSeenAt: Date.now() }).run();
}

beforeEach(() => {
	clearJava();
	forgetJavaBuilds();
	systemdStopped();
});
afterEach(() => {
	forgetJavaBuilds();
	resetProcesses();
});

describe('Java downloads in MineShell settings', () => {
	// The download button named only the major: nothing said a newer build was out, or that
	// servers matching Java by themselves would move to it at their next start.
	it('names a newer build of a downloaded runtime, and the servers a download moves', async () => {
		runtime(path.join(MANAGED_JAVA_DIR, 'temurin-21.0.8+9-jre', 'bin', 'java'), 21, '21.0.8');
		// From a package manager: it updates by its own means.
		runtime('/usr/lib/jvm/java-17/bin/java', 17, '17.0.12');
		await createInstance({ name: 'Follows', modloader: 'fabric', minecraftVersion: '1.21.1' });
		await createInstance({ name: 'Pinned', modloader: 'fabric', minecraftVersion: '1.21.1', javaPath: '/usr/lib/jvm/java-17/bin/java' });

		const data = await load(page, { url: 'http://localhost/settings?tab=java' });
		expect(await data.javaNewer).toEqual([{ vendor: 'temurin', major: 21, version: '21.0.9+10' }]);
		const { followers } = data.javaDownloads as { followers: Record<number, string[]> };
		expect(followers[21]).toContain('Follows');
		expect(followers[21]).not.toContain('Pinned');
		expect(Object.values(followers).flat()).not.toContain('Pinned');
		expect((data.javaRuntimes as { build: unknown }[]).map((r) => r.build)).toEqual(
			expect.arrayContaining([{ vendor: 'temurin', version: '21.0.8+9' }, null])
		);

		// Once the newest is there, nothing to say.
		runtime(path.join(MANAGED_JAVA_DIR, 'temurin-21.0.9+10-jre', 'bin', 'java'), 21, '21.0.9');
		expect(await (await load(page, { url: 'http://localhost/settings?tab=java' })).javaNewer).toEqual([]);
	});

	it('refuses a build that is not one, downloading nothing', async () => {
		for (const version of ['../x', 'a b', 'x'.repeat(41)]) {
			expect(await post(actions.downloadJava, { fields: { vendor: 'temurin', major: '21', version } }), version).toMatchObject({
				status: 400,
				data: { message: 'That is not a Java build.' }
			});
		}
	});

	it("lists a vendor's builds for the form's picker", async () => {
		const res = await call(builds, { url: 'http://localhost/api/java/builds?vendor=temurin&major=21' });
		expect(await res.json()).toEqual({ builds: [{ version: '21.0.9+10', imageType: 'jre' }, { version: '21.0.8+9', imageType: 'jre' }] });
		for (const query of ['vendor=oracle&major=21', 'vendor=temurin&major=x', 'vendor=temurin']) {
			expect((await call(builds, { url: `http://localhost/api/java/builds?${query}` })).status, query).toBe(400);
		}
	});
});
