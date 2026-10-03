import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadFile, fetchJson } from '../download';
import { getCurseforgeApiKey } from '../curseforge';
import { curseforgeModProvider as mirrorMods } from '../mods/modpacksch';
import type { ModloaderId } from '../modloaders';
import type { TaskHandle } from '../tasks';
import { TMP_DIR } from '../config';

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
	zip: AdmZip | null;
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

function parseMrpack(zip: AdmZip): ParsedPack {
	const entry = zip.getEntry('modrinth.index.json');
	if (!entry) throw new Error('This .mrpack has no modrinth.index.json.');
	const index = JSON.parse(zip.readAsText(entry)) as MrIndex;
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

function parseCurseforge(zip: AdmZip): ParsedPack {
	const entry = zip.getEntry('manifest.json');
	if (!entry) throw new Error('This archive has no manifest.json.');
	const manifest = JSON.parse(zip.readAsText(entry)) as CfManifest;
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

function zipEntriesUnder(zip: AdmZip, prefixes: string[]): string[] {
	return zip
		.getEntries()
		.filter((e) => !e.isDirectory && prefixes.some((p) => e.entryName.startsWith(p)))
		.map((e) => e.entryName);
}

// ------------------------------------------------------------------ shared ---

export function parsePack(buffer: Buffer): ParsedPack {
	const zip = new AdmZip(buffer);
	if (zip.getEntry('modrinth.index.json')) return parseMrpack(zip);
	if (zip.getEntry('manifest.json')) return parseCurseforge(zip);
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

/** CurseForge's CDN serves every file at a path made from its id and name. */
export function curseforgeCdnUrl(fileId: number, fileName: string): string {
	return `https://edge.forgecdn.net/files/${Math.floor(fileId / 1000)}/${fileId % 1000}/${encodeURIComponent(fileName)}`;
}

export type PackInstallProgress = { done: number; total: number; current: string };

/** Fetch every file the pack lists, in small batches, into the instance. */
export async function downloadPackFiles(
	pack: ParsedPack,
	instanceDir: string,
	task?: TaskHandle,
	concurrency = 4
): Promise<{ installed: number; failures: { file: string; error: string }[] }> {
	const failures: { file: string; error: string }[] = [];
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
					target = path.join('mods', resolved.filename);
					urls = [resolved.url];
					hash = resolved.sha1 ? { algo: 'sha1', value: resolved.sha1 } : null;
					// Known from here on, for curseforgeOrigins().
					item.target = target;
				}

				if (!urls.length) throw new Error('no download URL');

				const destination = path.join(instanceDir, target);
				let lastError: unknown = null;
				let ok = false;
				for (const url of urls) {
					try {
						await downloadFile(url, destination, { hash });
						ok = true;
						break;
					} catch (err) {
						lastError = err;
					}
				}
				if (!ok) throw lastError ?? new Error('all mirrors failed');
				task?.log(`Installed ${path.basename(target)}`);
			} catch (err) {
				const label = item.curseforge && !item.target
					? `CurseForge file ${item.curseforge.fileId}`
					: item.target || 'unknown file';
				const message = err instanceof Error ? err.message : String(err);
				if (item.required) failures.push({ file: label, error: message });
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
		url: string;
		sha1?: string | null;
		curseforge?: { projectId: string; fileId: string };
	}[];
}): ParsedPack {
	const files = input.files
		.filter((f) => Boolean(f.url))
		.map((f) => ({ ...f, dir: f.path.replace(/^\.?\/*/, '').replace(/\/+$/, '') }));
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
			.map((f) => ({
				target: path.posix.join(f.dir, f.name),
				urls: [f.url],
				hash: f.sha1 ? { algo: 'sha1' as const, value: f.sha1 } : null,
				...(f.curseforge
					? { curseforge: { projectId: Number(f.curseforge.projectId), fileId: Number(f.curseforge.fileId) } }
					: {}),
				required: true
			})),
		overrideEntries: [],
		zip: null,
		overridesArchive: archive
			? { url: archive.url, hash: archive.sha1 ? { algo: 'sha1', value: archive.sha1 } : null }
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
	const file = path.join(TMP_DIR, `overrides-${Date.now()}.zip`);
	try {
		task?.log('Downloading the pack overrides (configs, scripts, bundled files)');
		await downloadFile(pack.overridesArchive.url, file, {
			hash: pack.overridesArchive.hash,
			onProgress: (received, total) => {
				if (total) task?.setProgress((received / total) * 100, 'Downloading pack overrides');
			}
		});
		pack.zip = new AdmZip(file);
		pack.overrideEntries = zipEntriesUnder(pack.zip, ['overrides/']);
	} finally {
		await fs.rm(file, { force: true });
	}
}
