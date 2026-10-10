import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadFile, fetchJson } from '../download';
import { getCurseforgeApiKey } from '../curseforge';
import { curseforgeModProvider as mirrorMods } from '../mods/modpacksch';
import type { ModloaderId } from '../modloaders';
import type { TaskHandle } from '../tasks';
import { TMP_DIR } from '../config';
import { openZipBuffer, type ZipArchive } from '../zip';

/**
 * Both supported pack formats are zips with a manifest plus an `overrides/`
 * folder. The difference is how mods are referenced: Modrinth gives direct URLs
 * with hashes, CurseForge gives project/file id pairs that need resolving.
 */

export type PackKind = 'mrpack' | 'curseforge';

export type ParsedPack = {
	kind: PackKind;
	name: string;
	version: string | null;
	minecraftVersion: string;
	modloader: ModloaderId;
	modloaderVersion: string | null;
	/** Files to fetch into the instance. */
	downloads: PackDownload[];
	/** Entries inside the archive to copy verbatim. */
	overrideEntries: string[];
	/** Null when the pack came from an API file list rather than an archive. */
	zip: ZipArchive | null;
	/**
	 * File lists (modpacks.ch) ship configs, scripts and bundled jars as one
	 * `overrides.zip` at the instance root rather than as separate files.
	 * It is fetched and unpacked by loadOverridesArchive, never installed as
	 * a file - previously it landed in mods/ unextracted, so packs ran with
	 * none of their own configs.
	 */
	overridesArchive?: { url: string; hash: PackDownload['hash'] } | null;
};

export type PackDownload = {
	/** Path relative to the instance root, e.g. mods/sodium.jar */
	target: string;
	urls: string[];
	hash: { algo: 'sha1' | 'sha512'; value: string } | null;
	/**
	 * The CurseForge project and file. Without `urls` (a manifest.json pack)
	 * it is resolved to a URL at download time, which also fills in `target`;
	 * either way it is how the installed jar gets tracked as a CurseForge mod.
	 */
	curseforge?: { projectId: number; fileId: number };
	required: boolean;
};

// --------------------------------------------------------------- modrinth ---

type MrIndex = {
	formatVersion: number;
	game: string;
	versionId: string;
	name: string;
	files: {
		path: string;
		hashes: { sha1?: string; sha512?: string };
		env?: { client?: string; server?: string };
		downloads: string[];
		fileSize?: number;
	}[];
	dependencies: Record<string, string>;
};

function loaderFromMrDependencies(deps: Record<string, string>): {
	loader: ModloaderId;
	version: string | null;
	minecraft: string;
} {
	const minecraft = deps['minecraft'] ?? '';
	if (deps['fabric-loader']) return { loader: 'fabric', version: deps['fabric-loader'], minecraft };
	if (deps['quilt-loader']) return { loader: 'quilt', version: deps['quilt-loader'], minecraft };
	if (deps['forge']) return { loader: 'forge', version: deps['forge'], minecraft };
	if (deps['neoforge']) return { loader: 'neoforge', version: deps['neoforge'], minecraft };
	return { loader: 'vanilla', version: null, minecraft };
}

function parseMrpack(zip: ZipArchive): ParsedPack {
	const text = zip.readText('modrinth.index.json');
	if (!text) throw new Error('This .mrpack has no modrinth.index.json.');
	const index = JSON.parse(text) as MrIndex;
	const { loader, version, minecraft } = loaderFromMrDependencies(index.dependencies ?? {});

	const downloads: PackDownload[] = index.files
		// Client-only files would just bloat the server directory.
		.filter((f) => f.env?.server !== 'unsupported')
		.map((f) => ({
			target: f.path,
			urls: f.downloads,
			hash: f.hashes.sha512
				? { algo: 'sha512' as const, value: f.hashes.sha512 }
				: f.hashes.sha1
					? { algo: 'sha1' as const, value: f.hashes.sha1 }
					: null,
			required: f.env?.server !== 'optional'
		}));

	return {
		kind: 'mrpack',
		name: index.name,
		version: index.versionId ?? null,
		minecraftVersion: minecraft,
		modloader: loader,
		modloaderVersion: version,
		downloads,
		overrideEntries: zipEntriesUnder(zip, ['overrides/', 'server-overrides/']),
		zip
	};
}

// ------------------------------------------------------------- curseforge ---

type CfManifest = {
	minecraft: {
		version: string;
		modLoaders: { id: string; primary: boolean }[];
	};
	name: string;
	version: string;
	files: { projectID: number; fileID: number; required: boolean }[];
	overrides?: string;
};

function loaderFromCfId(id: string): { loader: ModloaderId; version: string | null } {
	// Ids look like "forge-47.2.0", "fabric-0.15.7", "neoforge-21.1.72".
	const [name, ...rest] = id.split('-');
	const version = rest.join('-') || null;
	const loader = (['forge', 'fabric', 'neoforge', 'quilt'] as ModloaderId[]).find(
		(l) => l === name.toLowerCase()
	);
	return { loader: loader ?? 'vanilla', version };
}

function parseCurseforge(zip: ZipArchive): ParsedPack {
	const text = zip.readText('manifest.json');
	if (!text) throw new Error('This archive has no manifest.json.');
	const manifest = JSON.parse(text) as CfManifest;
	const primary =
		manifest.minecraft.modLoaders.find((l) => l.primary) ?? manifest.minecraft.modLoaders[0];
	const { loader, version } = loaderFromCfId(primary?.id ?? '');

	const downloads: PackDownload[] = manifest.files.map((f) => ({
		target: '',
		urls: [],
		hash: null,
		curseforge: { projectId: f.projectID, fileId: f.fileID },
		required: f.required !== false
	}));

	const overridesRoot = manifest.overrides ?? 'overrides';
	return {
		kind: 'curseforge',
		name: manifest.name,
		version: manifest.version ?? null,
		minecraftVersion: manifest.minecraft.version,
		modloader: loader,
		modloaderVersion: version,
		downloads,
		overrideEntries: zipEntriesUnder(zip, [`${overridesRoot}/`]),
		zip
	};
}

function zipEntriesUnder(zip: ZipArchive, prefixes: string[]): string[] {
	return zip.entries
		.filter((e) => !e.name.endsWith('/') && prefixes.some((p) => e.name.startsWith(p)))
		.map((e) => e.name);
}

// ------------------------------------------------------------------ shared ---

export function parsePack(buffer: Buffer): ParsedPack {
	const zip = openZipBuffer(buffer);
	const names = new Set(zip?.entries.map((e) => e.name));
	if (zip && names.has('modrinth.index.json')) return parseMrpack(zip);
	if (zip && names.has('manifest.json')) return parseCurseforge(zip);
	throw new Error(
		'Unrecognised archive. MineShell reads Modrinth .mrpack files and CurseForge pack zips.'
	);
}

/** Copy `overrides/` (and `server-overrides/`, which wins) into the instance. */
export async function applyOverrides(
	pack: ParsedPack,
	instanceDir: string,
	/** Rewrites an entry's path inside the instance (the pack's world folder onto the server's); null skips it. */
	map: (relative: string) => string | null = (relative) => relative
): Promise<number> {
	if (!pack.zip) return 0;
	// server-overrides last so it takes precedence over the shared overrides.
	const ordered = [...pack.overrideEntries].sort((a, b) => {
		const aServer = a.startsWith('server-overrides/') ? 1 : 0;
		const bServer = b.startsWith('server-overrides/') ? 1 : 0;
		return aServer - bServer;
	});

	let count = 0;
	for (const entryName of ordered) {
		const relative = map(entryName.replace(/^(server-overrides|overrides)\//, ''));
		if (!relative || relative.split('/').includes('..')) continue;
		const target = path.join(instanceDir, relative);
		if (!path.resolve(target).startsWith(path.resolve(instanceDir) + path.sep)) continue;
		const data = pack.zip.readFile(entryName);
		if (!data) continue;
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, data);
		count += 1;
	}
	return count;
}

type CfFileInfo = {
	data: {
		id: number;
		modId: number;
		fileName: string;
		downloadUrl: string | null;
		hashes?: { value: string; algo: number }[];
	};
};

/**
 * CurseForge file ids need turning into URLs. The official API is used when a
 * key is present; otherwise the modpacks.ch mirror, which knows every file but
 * lists a project's older ones only per Minecraft version - hence the pack's
 * version, to page through.
 */
export async function resolveCurseforgeDownload(
	projectId: number,
	fileId: number,
	minecraftVersion?: string
): Promise<{ url: string; filename: string; sha1: string | null }> {
	const apiKey = getCurseforgeApiKey();
	if (apiKey) {
		const info = await fetchJson<CfFileInfo>(
			`https://api.curseforge.com/v1/mods/${projectId}/files/${fileId}`,
			{ headers: { 'x-api-key': apiKey } }
		);
		const sha1 = info.data.hashes?.find((h) => h.algo === 1)?.value ?? null;
		if (info.data.downloadUrl) {
			return { url: info.data.downloadUrl, filename: info.data.fileName, sha1 };
		}
		// Opted out of the API's download field, but the CDN path is derivable.
		return {
			url: curseforgeCdnUrl(fileId, info.data.fileName),
			filename: info.data.fileName,
			sha1
		};
	}

	try {
		const version = await mirrorMods.getVersion(String(projectId), String(fileId), { minecraftVersion });
		const file = version.files[0];
		return { url: file.url, filename: file.filename, sha1: file.hash?.value ?? null };
	} catch {
		throw new Error(
			`Could not resolve CurseForge file ${fileId}. Add a CurseForge API key on the Settings page (or set CURSEFORGE_API_KEY) for reliable pack imports.`
		);
	}
}

/**
 * Looks up every CurseForge entry a manifest.json pack lists by id only, so
 * its file names are known before anything is downloaded: a pack change
 * diffs by file name. One request per mod; throws when any cannot be
 * resolved, since an entry without a name would read as a mod the pack dropped.
 */
export async function resolvePackTargets(pack: ParsedPack, onProgress?: (done: number, total: number) => void, concurrency = 8): Promise<void> {
	const open = pack.downloads.filter((d) => d.curseforge && !d.urls.length);
	let done = 0;
	const failed: number[] = [];
	const queue = [...open];
	const worker = async () => {
		for (let item = queue.shift(); item; item = queue.shift()) {
			const { projectId, fileId } = item.curseforge!;
			try {
				const resolved = await resolveCurseforgeDownload(projectId, fileId, pack.minecraftVersion);
				item.target ||= path.posix.join('mods', resolved.filename);
				item.urls = curseforgeUrls(resolved.url, fileId, resolved.filename);
				item.hash = resolved.sha1 ? { algo: 'sha1', value: resolved.sha1 } : null;
			} catch {
				failed.push(fileId);
			}
			onProgress?.(++done, open.length);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, open.length) }, worker));
	if (failed.length) {
		throw new Error(
			`Could not look up ${failed.length} of the pack's ${open.length} CurseForge files (file ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ', ...' : ''}). Try again, or add a CurseForge API key in Settings.`
		);
	}
}

/** CurseForge's CDN serves every file at a path made from its id and name. */
export function curseforgeCdnUrl(fileId: number, fileName: string, host = 'edge.forgecdn.net'): string {
	return `https://${host}/files/${Math.floor(fileId / 1000)}/${fileId % 1000}/${encodeURIComponent(fileName)}`;
}

/**
 * Where a CurseForge file can be fetched: the URL it was listed with, then
 * the CDN directly. The mirror and the API hand out edge.forgecdn.net, which
 * only redirects to mediafilez.forgecdn.net - the second way in when the
 * redirector is down. Not modpacks.ch: CurseForge packs' jars never come
 * from it, only FTB-hosted files do (and those have no CurseForge ids).
 */
export function curseforgeUrls(url: string | null, fileId: number, fileName: string): string[] {
	const urls = url ? [url] : [];
	const cdn = curseforgeCdnUrl(fileId, fileName, 'mediafilez.forgecdn.net');
	const plain = (u: string) => {
		try {
			return decodeURIComponent(u);
		} catch {
			return u;
		}
	};
	if (!urls.some((u) => plain(u) === plain(cdn))) urls.push(cdn);
	return urls;
}

/** A required pack file that could not be fetched, with what is needed to fetch it later. */
export type FailedDownload = { file: string; error: string; download: PackDownload };

/** Fetch every file the pack lists, in small batches, into the instance. */
export async function downloadPackFiles(
	pack: ParsedPack,
	instanceDir: string,
	task?: TaskHandle,
	concurrency = 4
): Promise<{ installed: number; failures: FailedDownload[] }> {
	const failures: FailedDownload[] = [];
	let done = 0;
	const total = pack.downloads.length;

	const queue = [...pack.downloads];

	async function worker() {
		while (queue.length > 0) {
			if (task?.isCancelled()) return;
			const item = queue.shift();
			if (!item) return;
			try {
				let target = item.target;
				let urls = item.urls;
				let hash = item.hash;

				if (item.curseforge && !urls.length) {
					const resolved = await resolveCurseforgeDownload(
						item.curseforge.projectId,
						item.curseforge.fileId,
						pack.minecraftVersion
					);
					// A file list names the file (and its folder) even without a URL.
					target ||= path.posix.join('mods', resolved.filename);
					urls = curseforgeUrls(resolved.url, item.curseforge.fileId, resolved.filename);
					hash = resolved.sha1 ? { algo: 'sha1', value: resolved.sha1 } : null;
					// Known from here on, for curseforgeOrigins().
					item.target = target;
				}

				if (!urls.length) throw new Error('no download URL');

				const destination = path.join(instanceDir, target);
				let lastError: unknown = null;
				let ok = false;
				for (const [i, url] of urls.entries()) {
					try {
						await downloadFile(url, destination, { hash });
						ok = true;
						break;
					} catch (err) {
						lastError = err;
						if (i + 1 < urls.length) {
							task?.log(`${path.basename(target)}: ${new URL(url).host} failed (${err instanceof Error ? err.message : String(err)}), trying ${new URL(urls[i + 1]).host}`);
						}
					}
				}
				if (!ok) throw lastError ?? new Error('all mirrors failed');
				task?.log(`Installed ${path.basename(target)}`);
			} catch (err) {
				const label = item.curseforge && !item.target
					? `CurseForge file ${item.curseforge.fileId}`
					: item.target || 'unknown file';
				const message = err instanceof Error ? err.message : String(err);
				if (item.required) failures.push({ file: label, error: message, download: item });
				task?.log(`${item.required ? 'Failed' : 'Skipped optional'}: ${label} (${message})`);
			} finally {
				done += 1;
				task?.setProgress((done / Math.max(total, 1)) * 100, `Downloading mods (${done}/${total})`);
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, total || 1) }, worker));
	return { installed: done - failures.length, failures };
}


/**
 * modpacks.ch serves CurseForge and FTB packs as a flat file list rather than an
 * archive, so this adapts that shape into the same ParsedPack the archive path
 * produces. Config files come through as ordinary entries in `files`, which is
 * why there are no overrides to apply.
 *
 * An entry without a URL is kept: one with CurseForge ids is looked up at
 * download time like a manifest.json entry, and any other fails there and is
 * reported. Dropping them made an install report success with a mod missing.
 */
export function packFromFileList(input: {
	name: string;
	version: string | null;
	minecraftVersion: string;
	modloader: ModloaderId;
	modloaderVersion: string | null;
	files: {
		path: string;
		name: string;
		url?: string | null;
		sha1?: string | null;
		curseforge?: { projectId: string; fileId: string };
	}[];
}): ParsedPack {
	const files = input.files.map((f) => ({ ...f, dir: f.path.replace(/^\.?\/*/, '').replace(/\/+$/, '') }));
	const archive = files.find((f) => f.dir === '' && f.name.toLowerCase() === 'overrides.zip');
	return {
		kind: 'curseforge',
		name: input.name,
		version: input.version,
		minecraftVersion: input.minecraftVersion,
		modloader: input.modloader,
		modloaderVersion: input.modloaderVersion,
		downloads: files
			.filter((f) => f !== archive)
			.map((f) => {
				const curseforge = f.curseforge
					? { projectId: Number(f.curseforge.projectId), fileId: Number(f.curseforge.fileId) }
					: null;
				return {
					target: path.posix.join(f.dir, f.name),
					urls: curseforge && f.url ? curseforgeUrls(f.url, curseforge.fileId, f.name) : f.url ? [f.url] : [],
					hash: f.sha1 ? { algo: 'sha1' as const, value: f.sha1 } : null,
					...(curseforge ? { curseforge } : {}),
					required: true
				};
			}),
		overrideEntries: [],
		zip: null,
		overridesArchive: archive
			? { url: archive.url ?? '', hash: archive.sha1 ? { algo: 'sha1', value: archive.sha1 } : null }
			: null
	};
}

/**
 * The CurseForge project and file behind each of the pack's mod jars, keyed
 * by file name, for syncMods. A manifest.json pack's names are only known
 * once downloadPackFiles has resolved them.
 */
export function curseforgeOrigins(pack: ParsedPack): Map<string, { projectId: string; fileId: string }> {
	const origins = new Map<string, { projectId: string; fileId: string }>();
	for (const d of pack.downloads) {
		if (!d.curseforge || !d.target || path.posix.dirname(d.target.replace(/\\/g, '/')) !== 'mods') continue;
		origins.set(path.posix.basename(d.target), {
			projectId: String(d.curseforge.projectId),
			fileId: String(d.curseforge.fileId)
		});
	}
	return origins;
}

/** Fetch and open a file-list pack's overrides.zip so applyOverrides can unpack it. */
export async function loadOverridesArchive(pack: ParsedPack, task?: TaskHandle): Promise<void> {
	if (!pack.overridesArchive || pack.zip) return;
	// Without it the pack runs with none of its configs: an error, not a quiet install.
	if (!pack.overridesArchive.url) throw new Error('The pack lists its overrides.zip (configs, scripts, bundled files) without a download URL.');
	const file = path.join(TMP_DIR, `overrides-${Date.now()}.zip`);
	try {
		task?.log('Downloading the pack overrides (configs, scripts, bundled files)');
		await downloadFile(pack.overridesArchive.url, file, {
			hash: pack.overridesArchive.hash,
			onProgress: (received, total) => {
				if (total) task?.setProgress((received / total) * 100, 'Downloading pack overrides');
			}
		});
		pack.zip = openZipBuffer(await fs.readFile(file));
		if (!pack.zip) throw new Error('The pack overrides download is not a zip archive.');
		pack.overrideEntries = zipEntriesUnder(pack.zip, ['overrides/']);
	} finally {
		await fs.rm(file, { force: true });
	}
}
