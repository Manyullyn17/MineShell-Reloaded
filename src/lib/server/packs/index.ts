import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadFile, fetchJson } from '../download';
import { getCurseforgeApiKey } from '../curseforge';
import type { ModloaderId } from '../modloaders';
import type { TaskHandle } from '../tasks';

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
};

export type PackDownload = {
	/** Path relative to the instance root, e.g. mods/sodium.jar */
	target: string;
	urls: string[];
	hash: { algo: 'sha1' | 'sha512'; value: string } | null;
	/** CurseForge only: resolved lazily through the API. */
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
export async function applyOverrides(pack: ParsedPack, instanceDir: string): Promise<number> {
	if (!pack.zip) return 0;
	// server-overrides last so it takes precedence over the shared overrides.
	const ordered = [...pack.overrideEntries].sort((a, b) => {
		const aServer = a.startsWith('server-overrides/') ? 1 : 0;
		const bServer = b.startsWith('server-overrides/') ? 1 : 0;
		return aServer - bServer;
	});

	let count = 0;
	for (const entryName of ordered) {
		const relative = entryName.replace(/^(server-overrides|overrides)\//, '');
		if (!relative || relative.includes('..')) continue;
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
 * key is present; otherwise the well-known edge URL is reconstructed, which
 * works for every project that has not opted out of third-party distribution.
 */
export async function resolveCurseforgeDownload(
	projectId: number,
	fileId: number
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
			url: cdnUrl(fileId, info.data.fileName),
			filename: info.data.fileName,
			sha1
		};
	}

	// No key: ask modpacks.ch, which mirrors the same metadata. There's no
	// single-file lookup by (project, file) id in its public API - the real
	// shape is a per-project record with every file's version embedded, so
	// the file id is matched against that list instead.
	const info = await fetchJson<{
		versions?: { id: number; name: string; url: string; sha1?: string }[];
	}>(`https://api.modpacks.ch/public/mod/${projectId}`).catch(
		() => ({}) as { versions?: { id: number; name: string; url: string; sha1?: string }[] }
	);

	const file = info.versions?.find((v) => v.id === fileId);
	if (file) {
		return { url: file.url, filename: file.name, sha1: file.sha1 ?? null };
	}
	throw new Error(
		`Could not resolve CurseForge file ${fileId}. Add a CurseForge API key on the Settings page (or set CURSEFORGE_API_KEY) for reliable pack imports.`
	);
}

function cdnUrl(fileId: number, fileName: string): string {
	const id = String(fileId);
	return `https://edge.forgecdn.net/files/${id.slice(0, 4)}/${Number(id.slice(4))}/${encodeURIComponent(fileName)}`;
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

				if (item.curseforge) {
					const resolved = await resolveCurseforgeDownload(
						item.curseforge.projectId,
						item.curseforge.fileId
					);
					target = path.join('mods', resolved.filename);
					urls = [resolved.url];
					hash = resolved.sha1 ? { algo: 'sha1', value: resolved.sha1 } : null;
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
				const label = item.curseforge
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
	files: { path: string; name: string; url: string; sha1?: string | null }[];
}): ParsedPack {
	return {
		kind: 'curseforge',
		name: input.name,
		version: input.version,
		minecraftVersion: input.minecraftVersion,
		modloader: input.modloader,
		modloaderVersion: input.modloaderVersion,
		downloads: input.files
			.filter((f) => Boolean(f.url))
			.map((f) => ({
				target: path.posix.join(f.path.replace(/^\.?\/*/, ''), f.name),
				urls: [f.url],
				hash: f.sha1 ? { algo: 'sha1' as const, value: f.sha1 } : null,
				required: true
			})),
		overrideEntries: [],
		zip: null
	};
}
