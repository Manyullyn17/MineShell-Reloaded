import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as tar from 'tar';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { javaRuntimes, serverInstances } from './db/schema';
import { DATA_DIR, TMP_DIR } from './config';
import { downloadFile, fetchJson, HttpError } from './download';
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

/** Which build a downloaded runtime is, from its folder (runtimeFolder); null for any other Java. */
export function managedBuild(binary: string): { vendor: JavaVendor; version: string } | null {
	if (!isManagedJava(binary)) return null;
	const folder = path.relative(MANAGED_JAVA_DIR, path.resolve(binary)).split(path.sep)[0];
	const m = folder.match(/^(temurin|zulu)-(.+)-(?:jre|jdk)$/);
	return m ? { vendor: m[1] as JavaVendor, version: m[2] } : null;
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

// ----------------------------------------------------------------- builds ---

/** One build a vendor offers for a major; `version` names it as runtimeFolder does. */
export type JavaBuild = { version: string; imageType: 'jre' | 'jdk' };

/** A listed build, and how to get its download (Zulu's URL and checksum are a request of their own). */
type ListedBuild = JavaBuild & { fetchPackage: () => Promise<JavaPackage> };

/** Not there for this machine: Temurin answers 404 where it has no build (no Java 16 JRE). */
async function listing<T>(url: string): Promise<T[]> {
	try {
		return await fetchJson<T[]>(url);
	} catch (err) {
		if (err instanceof HttpError && err.status === 404) return [];
		throw err;
	}
}

// ---------------------------------------------------------------- Temurin ---

type AdoptiumRelease = {
	release_name: string;
	binaries: { image_type: string; package: { name: string; link: string; checksum: string; size: number } }[];
};

/** Every GA build, newest first: Adoptium lists them all, 25.0.4.1 (a fix release) among them. */
async function temurinBuilds(major: number): Promise<ListedBuild[]> {
	const os = usesMusl() ? 'alpine-linux' : 'linux';
	for (const imageType of ['jre', 'jdk'] as const) {
		const params = new URLSearchParams({
			architecture: architecture(),
			image_type: imageType,
			jvm_impl: 'hotspot',
			os,
			page_size: '20',
			sort_order: 'DESC',
			vendor: 'eclipse'
		});
		const releases = await listing<AdoptiumRelease>(`https://api.adoptium.net/v3/assets/feature_releases/${major}/ga?${params}`);
		const builds: ListedBuild[] = [];
		for (const release of releases) {
			const archive = release.binaries.find((b) => b.image_type === imageType && b.package.name.endsWith('.tar.gz'))?.package;
			if (!archive) continue;
			const version = release.release_name.replace(/^jdk-?/, '');
			const pkg: JavaPackage = {
				vendor: 'temurin',
				major,
				version,
				imageType,
				fileName: archive.name,
				url: archive.link,
				sha256: archive.checksum,
				size: archive.size
			};
			builds.push({ version, imageType, fetchPackage: async () => pkg });
		}
		if (builds.length) return builds;
	}
	return [];
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

/**
 * The builds Azul marks `latest`, newest first: what Prism offers too. Not every build: the
 * flag sits on the newest and the one two quarters back (21.0.13 and 21.0.11, not 21.0.12 or
 * its 21.0.12.1, on Java 17 and 25 alike, 2026-11-08), for reasons Azul does not give.
 */
async function zuluBuilds(major: number): Promise<ListedBuild[]> {
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
		const builds = listed
			.filter((p) => p.java_version[0] === major)
			.sort((a, b) => compareNumbers(b.java_version, a.java_version) || compareNumbers(b.distro_version, a.distro_version))
			.map((p): ListedBuild => {
				const version = p.java_version.join('.');
				return {
					version,
					imageType,
					fetchPackage: async () => {
						const detail = await fetchJson<ZuluDetail>(`https://api.azul.com/metadata/v1/zulu/packages/${p.package_uuid}`);
						return { vendor: 'zulu', major, version, imageType, fileName: detail.name, url: detail.download_url, sha256: detail.sha256_hash, size: detail.size };
					}
				};
			})
			// The same Java version twice (two distro builds): the newer distro only.
			.filter((b, i, all) => all.findIndex((o) => o.version === b.version) === i);
		if (builds.length) return builds;
	}
	return [];
}

function vendorBuilds(vendor: JavaVendor, major: number): Promise<ListedBuild[]> {
	return vendor === 'temurin' ? temurinBuilds(major) : zuluBuilds(major);
}

/** Lists change a few times a year, and Settings reads them on every load; a download asks afresh. */
const BUILDS_TTL_MS = 60 * 60 * 1000;
const buildCache = new Map<string, { at: number; builds: Promise<JavaBuild[]> }>();

/** The builds a vendor offers for a major on this machine, newest first. */
export function listJavaBuilds(vendor: JavaVendor, major: number): Promise<JavaBuild[]> {
	const key = `${vendor}-${major}`;
	const hit = buildCache.get(key);
	if (hit && Date.now() - hit.at < BUILDS_TTL_MS) return hit.builds;
	const builds = vendorBuilds(vendor, major).then((list) => list.map(({ version, imageType }) => ({ version, imageType })));
	buildCache.set(key, { at: Date.now(), builds });
	// A failed lookup is not kept: the next load asks again.
	builds.catch(() => buildCache.delete(key));
	return builds;
}

/** For tests: lists read again. */
export function forgetJavaBuilds(): void {
	buildCache.clear();
}

/** A build to download: the one named, else the newest. */
export async function findJavaPackage(vendor: JavaVendor, major: number, version?: string): Promise<JavaPackage> {
	const builds = await vendorBuilds(vendor, major);
	const label = JAVA_VENDORS.find((v) => v.id === vendor)!.label;
	const build = version ? builds.find((b) => b.version === version) : builds[0];
	if (!build) throw new Error(version ? `${label} has no Java ${version} build for this machine.` : `${label} has no Java ${major} build for this machine.`);
	return build.fetchPackage();
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
export function installJava(
	vendor: JavaVendor,
	major: number,
	task: Pick<TaskHandle, 'setProgress' | 'log'>,
	version?: string
): Promise<ProbedJava> {
	const key = `${vendor}-${major}-${version ?? 'newest'}`;
	const running = inFlight.get(key);
	if (running) return running;
	const work = installUncached(vendor, major, task, version).finally(() => inFlight.delete(key));
	inFlight.set(key, work);
	return work;
}

async function installUncached(
	vendor: JavaVendor,
	major: number,
	task: Pick<TaskHandle, 'setProgress' | 'log'>,
	version?: string
): Promise<ProbedJava> {
	const label = JAVA_VENDORS.find((v) => v.id === vendor)!.label;
	task.setProgress(null, `Looking up ${label} ${version ?? major}`);
	const pkg = await findJavaPackage(vendor, major, version);
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

/** Download from Settings, as a task of its own: a build picked there, else the newest. */
export function startJavaDownload(vendor: JavaVendor, major: number, version?: string): string {
	const label = JAVA_VENDORS.find((v) => v.id === vendor)!.label;
	return startTask({ label: `Download ${label} ${version ?? major}` }, async (task) => {
		await installJava(vendor, major, task, version);
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
