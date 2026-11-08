import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as tar from 'tar';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findJavaPackage, forgetJavaBuilds, installJava, listJavaBuilds, managedBuild, MANAGED_JAVA_DIR, removeManagedJava } from './javadownload';
import { db } from './db';
import { javaRuntimes, serverInstances } from './db/schema';
import { TMP_DIR } from './config';
import { fakeProcesses } from '../../../tests/helpers/process';
import { useRecordedHttp } from '../../../tests/helpers/http';
import { tempDir } from '../../../tests/helpers/fs';
import { clearJava, createInstance, reload, systemdStopped, waitForTask } from '../../../tests/helpers/instances';
import { createFromLoader, JavaMissingError } from './instances';
import { LOADERS } from './modloaders';

const TEMURIN_21 =
	'https://api.adoptium.net/v3/assets/feature_releases/21/ga?architecture=x64&image_type=jre&jvm_impl=hotspot&os=linux&page_size=20&sort_order=DESC&vendor=eclipse';
const FAKE_TARBALL = 'https://example.invalid/OpenJDK21U-jre_x64_linux_hotspot_21.0.9_10.tar.gz';
const OLDER_TARBALL = 'https://example.invalid/OpenJDK21U-jre_x64_linux_hotspot_21.0.8_9.tar.gz';

/** A JRE tarball as the vendors ship it: one top folder with bin/java in it. */
async function fakeJre(): Promise<Buffer> {
	const dir = await tempDir('jre-');
	await fs.mkdir(path.join(dir, 'jdk-21.0.9+10-jre', 'bin'), { recursive: true });
	await fs.writeFile(path.join(dir, 'jdk-21.0.9+10-jre', 'bin', 'java'), '#!/bin/sh\n', { mode: 0o755 });
	await fs.writeFile(path.join(dir, 'jdk-21.0.9+10-jre', 'release'), 'JAVA_VERSION="21.0.9"\n');
	const file = path.join(dir, 'jre.tar.gz');
	await tar.c({ gzip: true, file, cwd: dir }, ['jdk-21.0.9+10-jre']);
	return fs.readFile(file);
}

/** Temurin's builds of Java 21, newest first, both pointing at the fake tarball with the given checksum. */
function temurinMetadata(sha256: string): Response {
	const release = (name: string, file: string, link: string) => ({
		release_name: name,
		binaries: [{ image_type: 'jre', package: { name: file, link, checksum: sha256, size: 1234 } }]
	});
	return Response.json([
		release('jdk-21.0.9+10', 'OpenJDK21U-jre_x64_linux_hotspot_21.0.9_10.tar.gz', FAKE_TARBALL),
		release('jdk-21.0.8+9', 'OpenJDK21U-jre_x64_linux_hotspot_21.0.8_9.tar.gz', OLDER_TARBALL)
	]);
}

const task = { setProgress: () => undefined, log: () => undefined };
/** Only the downloaded runtime answers; a rescan must not turn this machine's own Java into one. */
const javaAnswers = () =>
	fakeProcesses((cmd, args) =>
		args.includes('-version') && cmd.startsWith(MANAGED_JAVA_DIR) ? { stderr: 'openjdk version "21.0.9" 2025-10-21 LTS\nOpenJDK Runtime Environment Temurin-21.0.9+10 (build 21.0.9+10-LTS)\n' } : {}
	);

describe('finding a Java download', () => {
	useRecordedHttp('javadownload');
	// The recording was made on x64 glibc Linux, which CI runs on.
	beforeEach(() => {
		vi.spyOn(process, 'arch', 'get').mockReturnValue('x64');
	});
	afterEach(() => vi.restoreAllMocks());

	it('takes the newest Temurin JRE', async () => {
		const pkg = await findJavaPackage('temurin', 21);
		expect(pkg).toMatchObject({ vendor: 'temurin', major: 21, imageType: 'jre' });
		expect(pkg.version).toMatch(/^21\./);
		expect(pkg.url).toMatch(/\.tar\.gz$/);
		expect(pkg.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it('falls back to the JDK where Temurin has no JRE (Java 16, for Minecraft 1.17)', async () => {
		expect(await findJavaPackage('temurin', 16)).toMatchObject({ major: 16, imageType: 'jdk' });
	});

	it('takes the newest Zulu build, not the newest of each update line', async () => {
		const pkg = await findJavaPackage('zulu', 21);
		expect(pkg).toMatchObject({ vendor: 'zulu', major: 21, imageType: 'jre' });
		expect(pkg.fileName).not.toMatch(/crac|musl/);
		expect(pkg.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(await findJavaPackage('zulu', 8)).toMatchObject({ major: 8, imageType: 'jre' });
	});

	// Settings only ever offered the newest build: nothing said one was out, and an older one
	// (a mod broken by a newer build) could not be had.
	it('lists the builds to pick from, newest first, and downloads the one picked', async () => {
		forgetJavaBuilds();
		const temurin = await listJavaBuilds('temurin', 21);
		expect(temurin.length).toBeGreaterThan(5);
		expect(temurin[0].version).toBe((await findJavaPackage('temurin', 21)).version);
		const older = temurin[3];
		expect(await findJavaPackage('temurin', 21, older.version)).toMatchObject({ version: older.version, imageType: 'jre' });
		// Only the builds Azul recommends, as Prism shows them: fewer than Temurin's.
		const zulu = await listJavaBuilds('zulu', 21);
		expect(zulu.length).toBeGreaterThan(0);
		expect(zulu.length).toBeLessThan(temurin.length);
		expect(zulu[0].version).toBe((await findJavaPackage('zulu', 21)).version);
		expect((await findJavaPackage('zulu', 21, zulu.at(-1)!.version)).version).toBe(zulu.at(-1)!.version);
		await expect(findJavaPackage('temurin', 21, '21.0.0-nope')).rejects.toThrow(/no Java 21\.0\.0-nope build/);
		// Java 16 has no JRE: the JDKs, marked so.
		expect((await listJavaBuilds('temurin', 16)).every((b) => b.imageType === 'jdk')).toBe(true);
	});
});

describe('which build a runtime is', () => {
	it('reads it from the folder a download made, and nothing from other Java', () => {
		expect(managedBuild(path.join(MANAGED_JAVA_DIR, 'temurin-25.0.5+8-jre', 'bin', 'java'))).toEqual({ vendor: 'temurin', version: '25.0.5+8' });
		expect(managedBuild(path.join(MANAGED_JAVA_DIR, 'zulu-21.0.13.0.3-jdk', 'bin', 'java'))).toEqual({ vendor: 'zulu', version: '21.0.13.0.3' });
		expect(managedBuild('/usr/lib/jvm/java-21-openjdk-amd64/bin/java')).toBeNull();
	});
});

describe('installing a downloaded Java', () => {
	let tarball: Buffer;
	let sha: string;
	beforeEach(async () => {
		vi.spyOn(process, 'arch', 'get').mockReturnValue('x64');
		clearJava();
		await fs.rm(MANAGED_JAVA_DIR, { recursive: true, force: true });
		tarball = await fakeJre();
		sha = crypto.createHash('sha256').update(tarball).digest('hex');
		javaAnswers();
	});
	afterEach(() => vi.restoreAllMocks());

	describe('with a good download', () => {
		// Served by hand only; a fixture of its own so recording never overwrites the lookups'.
		useRecordedHttp('javadownload-install', {
			extra: {
				[TEMURIN_21]: () => temurinMetadata(sha),
				[FAKE_TARBALL]: () => new Response(new Uint8Array(tarball)),
				[OLDER_TARBALL]: () => new Response(new Uint8Array(tarball))
			}
		});

		it('installs the build picked beside the newest, each in a folder of its own', async () => {
			const newest = await installJava('temurin', 21, task);
			const older = await installJava('temurin', 21, task, '21.0.8+9');
			expect(older.path).toBe(path.join(MANAGED_JAVA_DIR, 'temurin-21.0.8+9-jre', 'bin', 'java'));
			expect(newest.path).toBe(path.join(MANAGED_JAVA_DIR, 'temurin-21.0.9+10-jre', 'bin', 'java'));
			expect((await fs.readdir(MANAGED_JAVA_DIR)).sort()).toEqual(['temurin-21.0.8+9-jre', 'temurin-21.0.9+10-jre']);
		});

		it('unpacks it into the data folder and registers it', async () => {
			const info = await installJava('temurin', 21, task);
			expect(info).toMatchObject({ majorVersion: 21, path: path.join(MANAGED_JAVA_DIR, 'temurin-21.0.9+10-jre', 'bin', 'java') });
			expect((await fs.stat(info.path)).mode & 0o111).not.toBe(0);
			expect(db.select().from(javaRuntimes).where(eq(javaRuntimes.path, info.path)).get()).toMatchObject({ majorVersion: 21, manual: false });
			expect((await fs.readdir(MANAGED_JAVA_DIR)).filter((n) => n.endsWith('.partial'))).toEqual([]);
		});

		it('creates a server after downloading the Java it needs, when asked to', async () => {
			systemdStopped();
			javaAnswers();
			vi.spyOn(LOADERS.fabric, 'install').mockImplementation(async (ctx) => {
				expect(ctx.javaPath).toContain(MANAGED_JAVA_DIR);
				return { launchArgs: '-jar server.jar nogui', loaderVersion: '0.16.5' };
			});
			const { instance, taskId } = await createFromLoader({
				name: 'Needs Java',
				minecraftVersion: '1.21.1',
				modloader: 'fabric',
				downloadJava: 'temurin'
			});
			const done = await waitForTask(taskId);
			expect(done.error).toBeNull();
			expect(done.state).toBe('done');
			expect(reload(instance.id).status).toBe('ready');
		});

		it('refuses to delete a runtime a server is pinned to', async () => {
			const info = await installJava('temurin', 21, task);
			const pinned = await createInstance({ modloader: 'fabric', minecraftVersion: '1.21.1', javaPath: info.path, name: 'Pinned one' });
			await expect(removeManagedJava(info.path)).rejects.toThrow(/Pinned one is pinned/);
			db.update(serverInstances).set({ javaPath: null }).where(eq(serverInstances.id, pinned.id)).run();
			await removeManagedJava(info.path);
			await expect(fs.access(info.path)).rejects.toThrow();
		});
	});

	describe('with a corrupted download', () => {
		// Served by hand only; a fixture of its own so recording never overwrites the lookups'.
		useRecordedHttp('javadownload-install', {
			extra: {
				[TEMURIN_21]: () => temurinMetadata('0'.repeat(64)),
				[FAKE_TARBALL]: () => new Response(new Uint8Array(tarball))
			}
		});

		it('refuses it and leaves nothing behind', async () => {
			await expect(installJava('temurin', 21, task)).rejects.toThrow(/Checksum mismatch/);
			expect(await fs.readdir(MANAGED_JAVA_DIR).catch(() => [])).toEqual([]);
			expect((await fs.readdir(TMP_DIR)).filter((n) => n.includes('OpenJDK21U'))).toEqual([]);
			expect(db.select().from(javaRuntimes).all()).toEqual([]);
		});
	});

	describe('when the needed Java is missing', () => {
		it('stops before creating anything, so the form can offer a download', async () => {
			systemdStopped();
			const before = db.select().from(serverInstances).all().length;
			const err = await createFromLoader({ name: 'No Java here', minecraftVersion: '1.21.1', modloader: 'fabric' }).catch((e) => e);
			expect(err).toBeInstanceOf(JavaMissingError);
			expect(err.major).toBe(21);
			expect(db.select().from(serverInstances).all()).toHaveLength(before);
		});
	});
});
