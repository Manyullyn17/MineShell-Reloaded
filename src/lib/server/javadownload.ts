import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as tar from 'tar';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { javaRuntimes, serverInstances } from './db/schema';
import { DATA_DIR, TMP_DIR } from './config';
import { downloadFile, fetchJson } from './download';
import { probeJava, type ProbedJava } from './java';
import { startTask, type TaskHandle } from './tasks';
import { formatBytes } from '#lib/shared/format.js';

/**
 * Java runtimes MineShell downloads itself, from Eclipse Temurin (the
 * Adoptium API) or Azul Zulu (Azul's metadata API), into the data directory.
 * Both publish a SHA-256 per file, which every download is checked against.
 *
 * JREs, since a server never compiles anything; where a vendor has no JRE
 * for a version (Temurin never shipped a Java 16 JRE, which Minecraft 1.17
 * needs) the JDK is used instead.
 */

export type JavaVendor = 'temurin' | 'zulu';

export const JAVA_VENDORS: { id: JavaVendor; label: string }[] = [
	{ id: 'temurin', label: 'Eclipse Temurin' },
	{ id: 'zulu', label: 'Azul Zulu' }
];

export function isJavaVendor(value: unknown): value is JavaVendor {
	return value === 'temurin' || value === 'zulu';
}

/** Where downloaded runtimes live; also a scan root, so rescans keep them. */
export const MANAGED_JAVA_DIR = path.join(DATA_DIR, 'java');

export function isManagedJava(binary: string): boolean {
	return path.resolve(binary).startsWith(MANAGED_JAVA_DIR + path.sep);
}

/**
 * The majors worth offering: every one a Minecraft version has required, and
 * Adoptium's newest LTS once it is newer than those.
 */
export const OFFERED_MAJORS = [8, 16, 17, 21, 25];

export type JavaPackage = {
	vendor: JavaVendor;
	major: number;
	/** e.g. 21.0.12.1+1 */
	version: string;
	imageType: 'jre' | 'jdk';
	fileName: string;
	url: string;
	sha256: string;
	size: number;
};

// --------------------------------------------------------------- platform ---

function architecture(): 'x64' | 'aarch64' {
	if (process.arch === 'x64') return 'x64';
	if (process.arch === 'arm64') return 'aarch64';
	throw new Error(`No Java downloads are offered for this machine's architecture (${process.arch}).`);
}

/** glibc or musl (Alpine); the two need different builds. */
function usesMusl(): boolean {
	const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
	return !report?.header?.glibcVersionRuntime;
}

// ---------------------------------------------------------------- Temurin ---

type AdoptiumAsset = {
	release_name: string;
	version: { openjdk_version: string; semver: string };
	binary: { image_type: string; package: { name: string; link: string; checksum: string; size: number } };
};

async function temurinPackage(major: number): Promise<JavaPackage | null> {
	const os = usesMusl() ? 'alpine-linux' : 'linux';
	for (const imageType of ['jre', 'jdk'] as const) {
		const params = new URLSearchParams({ architecture: architecture(), image_type: imageType, os, vendor: 'eclipse' });
		const assets = await fetchJson<AdoptiumAsset[]>(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?${params}`);
		const asset = assets.find((a) => a.binary.package.name.endsWith('.tar.gz'));
		if (asset) {
			return {
				vendor: 'temurin',
				major,
				version: asset.release_name.replace(/^jdk-?/, ''),
				imageType,
				fileName: asset.binary.package.name,
				url: asset.binary.package.link,
				sha256: asset.binary.package.checksum,
				size: asset.binary.package.size
			};
		}
	}
	return null;
}

// ------------------------------------------------------------------- Zulu ---

type ZuluListing = { package_uuid: string; name: string; java_version: number[]; distro_version: number[] };
type ZuluDetail = ZuluListing & { download_url: string; sha256_hash: string; size: number };

function compareNumbers(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff) return diff;
	}
	return 0;
}

async function zuluPackage(major: number): Promise<JavaPackage | null> {
	for (const imageType of ['jre', 'jdk'] as const) {
		const params = new URLSearchParams({
			java_version: String(major),
			os: usesMusl() ? 'linux-musl' : 'linux-glibc',
			arch: architecture(),
			archive_type: 'tar.gz',
			java_package_type: imageType,
			javafx_bundled: 'false',
			crac_supported: 'false',
			latest: 'true',
			release_status: 'ga',
			availability_types: 'CA'
		});
		const listed = await fetchJson<ZuluListing[]>(`https://api.azul.com/metadata/v1/zulu/packages/?${params}`);
		// "latest" still lists the newest build of each update line.
		const newest = listed
			.filter((p) => p.java_version[0] === major)
			.sort((a, b) => compareNumbers(b.java_version, a.java_version) || compareNumbers(b.distro_version, a.distro_version))[0];
		if (!newest) continue;
		const detail = await fetchJson<ZuluDetail>(`https://api.azul.com/metadata/v1/zulu/packages/${newest.package_uuid}`);
		return {
			vendor: 'zulu',
			major,
			version: detail.java_version.join('.'),
			imageType,
			fileName: detail.name,
			url: detail.download_url,
			sha256: detail.sha256_hash,
			size: detail.size
		};
	}
	return null;
}

export async function findJavaPackage(vendor: JavaVendor, major: number): Promise<JavaPackage> {
	const found = vendor === 'temurin' ? await temurinPackage(major) : await zuluPackage(major);
	if (!found) {
		const label = JAVA_VENDORS.find((v) => v.id === vendor)!.label;
		throw new Error(`${label} has no Java ${major} build for this machine.`);
	}
	return found;
}

// ---------------------------------------------------------------- install ---

/** Folder name for an installed package; one per vendor and exact build. */
export function runtimeFolder(pkg: Pick<JavaPackage, 'vendor' | 'version' | 'imageType'>): string {
	return `${pkg.vendor}-${pkg.version.replace(/[^A-Za-z0-9._+-]/g, '_')}-${pkg.imageType}`;
}

/** The folder inside an unpacked archive that holds bin/java: the archive's single top folder, as both vendors ship it. */
async function javaHomeIn(dir: string): Promise<string> {
	const has = (p: string) => fs.access(path.join(p, 'bin', 'java')).then(() => true, () => false);
	if (await has(dir)) return dir;
	for (const name of await fs.readdir(dir)) {
		if (await has(path.join(dir, name))) return path.join(dir, name);
	}
	throw new Error('The downloaded archive has no bin/java in it.');
}

function register(info: ProbedJava): void {
	const now = Date.now();
	db.insert(javaRuntimes)
		.values({ ...info, manual: false, lastSeenAt: now })
		.onConflictDoUpdate({ target: javaRuntimes.path, set: { ...info, lastSeenAt: now } })
		.run();
}

/** Downloads of the same vendor and major share one run. */
const inFlight = new Map<string, Promise<ProbedJava>>();

/**
 * Download, verify, unpack and register a runtime; resolves to it. A build
 * already installed is only registered again.
 */
export function installJava(vendor: JavaVendor, major: number, task: Pick<TaskHandle, 'setProgress' | 'log'>): Promise<ProbedJava> {
	const key = `${vendor}-${major}`;
	const running = inFlight.get(key);
	if (running) return running;
	const work = installUncached(vendor, major, task).finally(() => inFlight.delete(key));
	inFlight.set(key, work);
	return work;
}

async function installUncached(vendor: JavaVendor, major: number, task: Pick<TaskHandle, 'setProgress' | 'log'>): Promise<ProbedJava> {
	const label = JAVA_VENDORS.find((v) => v.id === vendor)!.label;
	task.setProgress(null, `Looking up ${label} ${major}`);
	const pkg = await findJavaPackage(vendor, major);
	const home = path.join(MANAGED_JAVA_DIR, runtimeFolder(pkg));
	const binary = path.join(home, 'bin', 'java');

	if (!(await fs.access(binary).then(() => true, () => false))) {
		if (pkg.imageType === 'jdk') task.log(`${label} has no Java ${major} JRE; using the JDK.`);
		task.log(`Downloading ${pkg.fileName} (${formatBytes(pkg.size)}).`);
		const archive = path.join(TMP_DIR, `${crypto.randomUUID()}-${pkg.fileName}`);
		const staging = `${home}.partial`;
		try {
			await downloadFile(pkg.url, archive, {
				hash: { algo: 'sha256', value: pkg.sha256 },
				onProgress: (received, total) => {
					const of = total ?? pkg.size;
					if (of) task.setProgress(Math.round((received / of) * 100), `Downloading ${label} ${pkg.version}`);
				}
			});
			task.setProgress(null, `Unpacking ${label} ${pkg.version}`);
			await fs.rm(staging, { recursive: true, force: true });
			await fs.mkdir(staging, { recursive: true });
			await tar.x({ file: archive, cwd: staging });
			await fs.rename(await javaHomeIn(staging), home);
		} finally {
			await fs.rm(archive, { force: true });
			await fs.rm(`${archive}.part`, { force: true });
			await fs.rm(staging, { recursive: true, force: true });
		}
	}

	const info = await probeJava(binary);
	if (!info) {
		await fs.rm(home, { recursive: true, force: true });
		throw new Error(`The downloaded ${label} ${pkg.version} does not run on this machine.`);
	}
	register(info);
	task.log(`Installed ${label} ${info.versionString} at ${home}.`);
	return info;
}

/** Download from Settings, as a task of its own. */
export function startJavaDownload(vendor: JavaVendor, major: number): string {
	const label = JAVA_VENDORS.find((v) => v.id === vendor)!.label;
	return startTask({ label: `Download ${label} ${major}` }, async (task) => {
		await installJava(vendor, major, task);
		task.setProgress(100, 'Done');
	});
}

/** Unpacked folders a download left when MineShell stopped mid-way. */
export async function removePartialJava(): Promise<void> {
	for (const name of await fs.readdir(MANAGED_JAVA_DIR).catch(() => [] as string[])) {
		if (name.endsWith('.partial')) await fs.rm(path.join(MANAGED_JAVA_DIR, name), { recursive: true, force: true });
	}
}

/**
 * Delete a downloaded runtime and its record. Refused while a server is
 * pinned to it; auto-matched servers simply pick another runtime.
 */
export async function removeManagedJava(binary: string): Promise<void> {
	if (!isManagedJava(binary)) throw new Error('Only runtimes MineShell downloaded can be deleted here.');
	const pinned = db.select({ name: serverInstances.name }).from(serverInstances).where(eq(serverInstances.javaPath, binary)).all();
	if (pinned.length) {
		throw new Error(`${pinned.map((p) => p.name).join(', ')} ${pinned.length === 1 ? 'is' : 'are'} pinned to this runtime; unpin first.`);
	}
	const home = path.dirname(path.dirname(binary));
	if (path.dirname(home) !== MANAGED_JAVA_DIR) throw new Error('Unexpected runtime location.');
	await fs.rm(home, { recursive: true, force: true });
	db.delete(javaRuntimes).where(eq(javaRuntimes.path, binary)).run();
}
