import path from 'node:path';
import type { ParsedPack, PackDownload } from './index';
import { resolveProviderPack } from './resolve';
import { projectsByIds, versionsFromHashes } from '../mods/modrinth';
import type { ProjectVersion } from '../mods/types';

/**
 * What a provider pack version installs, shown before installing it: its
 * mods, with the ones Modrinth lists as client-only marked, so the form can
 * install them disabled (or keep one the user wants). The same lookup
 * `clientonly.ts` does after an install, done from the pack's own hashes.
 *
 * The resolved pack is kept for the install that usually follows, so a
 * .mrpack is not downloaded twice.
 */

export type PackPreviewMod = {
	/** Path in the server (mods/x.jar), which the install form sends back. */
	target: string;
	fileName: string;
	name: string;
	/** Why it would be disabled, or null. */
	clientOnly: string | null;
	/** The pack ships it as .disabled (Thread: Fabric API), so it installs disabled unless enabled here. */
	packDisabled: boolean;
	/** Mods of the pack that require this client-only one; it stays enabled by default. */
	neededBy: string[];
};

export type PackPreview = {
	name: string;
	version: string | null;
	minecraftVersion: string;
	modloader: string;
	modloaderVersion: string | null;
	mods: PackPreviewMod[];
	/** Files fetched outside mods/ (resource packs, configs listed one by one). */
	otherFiles: number;
};

type Resolved = { pack: ParsedPack; projectName: string };

const KEEP_MS = 15 * 60_000;
const resolved = new Map<string, { at: number; result: Promise<Resolved> }>();

function cacheKey(source: string, projectId: string, versionId: string): string {
	return `${source}:${projectId}:${versionId}`;
}

function prune(): void {
	for (const [key, entry] of resolved) if (Date.now() - entry.at > KEEP_MS) resolved.delete(key);
}

/** The pack for an install: the one a preview resolved, or a fresh one. Taken once, since installing changes it. */
export function takeProviderPack(source: string, projectId: string, versionId: string): Promise<Resolved> {
	prune();
	const key = cacheKey(source, projectId, versionId);
	const hit = resolved.get(key);
	resolved.delete(key);
	return hit?.result ?? resolveProviderPack(source, projectId, versionId);
}

export async function previewProviderPack(source: string, projectId: string, versionId: string): Promise<PackPreview> {
	prune();
	const key = cacheKey(source, projectId, versionId);
	let entry = resolved.get(key);
	if (!entry) {
		entry = { at: Date.now(), result: resolveProviderPack(source, projectId, versionId) };
		resolved.set(key, entry);
	}
	try {
		return await describePack((await entry.result).pack);
	} catch (err) {
		if (resolved.get(key) === entry) resolved.delete(key);
		throw err;
	}
}

export async function describePack(pack: ParsedPack): Promise<PackPreview> {
	const jars = pack.downloads.filter((d) => d.target && path.posix.dirname(d.target) === 'mods');
	const known = await identify(jars);
	const mods = jars.map((d): PackPreviewMod => {
		const fileName = path.posix.basename(d.target);
		const found = known.get(d.target);
		return {
			target: d.target,
			fileName,
			name: found?.name ?? fileName.replace(/\.disabled$/, '').replace(/\.jar$/i, ''),
			clientOnly: found?.clientOnly ? 'Modrinth lists it as client-only' : null,
			packDisabled: fileName.endsWith('.disabled'),
			neededBy: found?.neededBy ?? []
		};
	});
	// Client-only ones first: they are what the list is there to decide.
	mods.sort((a, b) => Number(!!b.clientOnly) - Number(!!a.clientOnly) || a.name.localeCompare(b.name));
	return {
		name: pack.name,
		version: pack.version,
		minecraftVersion: pack.minecraftVersion,
		modloader: pack.modloader,
		modloaderVersion: pack.modloaderVersion,
		mods,
		otherFiles: pack.downloads.length - jars.length
	};
}

/** Each jar Modrinth knows by hash: its project's name, whether it is client-only, and what needs it. */
async function identify(
	jars: PackDownload[]
): Promise<Map<string, { name: string; clientOnly: boolean; neededBy: string[] }>> {
	const out = new Map<string, { name: string; clientOnly: boolean; neededBy: string[] }>();
	// .mrpack files carry sha512, the CurseForge mirror's file lists sha1.
	const versions = new Map<string, ProjectVersion>();
	for (const algo of ['sha512', 'sha1'] as const) {
		const targets = new Map<string, string>();
		for (const d of jars) if (d.hash?.algo === algo) targets.set(d.hash.value.toLowerCase(), d.target);
		if (targets.size === 0) continue;
		for (const [hash, version] of await versionsFromHashes([...targets.keys()], algo)) {
			const target = targets.get(hash.toLowerCase());
			if (target) versions.set(target, version);
		}
	}
	const projects = await projectsByIds([...versions.values()].map((v) => v.projectId));
	const nameOf = (target: string) => projects.get(versions.get(target)?.projectId ?? '')?.name ?? path.posix.basename(target);
	const flagged = new Set([...versions].filter(([, v]) => projects.get(v.projectId)?.clientOnly).map(([t]) => t));

	// A client-only mod that a mod staying enabled requires stays too -
	// repeated, since keeping one can make what it requires necessary.
	const neededBy = new Map<string, string[]>();
	for (let changed = true; changed; ) {
		changed = false;
		for (const target of flagged) {
			if (neededBy.has(target)) continue;
			const projectId = versions.get(target)!.projectId;
			const dependents = [...versions]
				.filter(([t]) => t !== target && !t.endsWith('.disabled') && (!flagged.has(t) || neededBy.has(t)))
				.filter(([, v]) => v.dependencies.some((d) => d.type === 'required' && d.projectId === projectId))
				.map(([t]) => nameOf(t));
			if (dependents.length) {
				neededBy.set(target, dependents);
				changed = true;
			}
		}
	}

	for (const [target, version] of versions) {
		const project = projects.get(version.projectId);
		if (!project) continue;
		out.set(target, { name: project.name, clientOnly: flagged.has(target), neededBy: neededBy.get(target) ?? [] });
	}
	return out;
}
