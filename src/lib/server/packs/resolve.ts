import { getProvider } from '../mods';
import { compareVersions } from '../java';
import type { ModloaderId } from '../modloaders';
import { packFromFileList, parsePack, type ParsedPack } from './index';

/**
 * Turn a provider pack version into a ParsedPack, the one shape both a fresh
 * install and a pack version change work from. Modrinth ships a real .mrpack
 * archive; CurseForge and FTB come back from modpacks.ch as a file list.
 */
export async function resolveProviderPack(
	source: string,
	projectId: string,
	versionId: string
): Promise<{ pack: ParsedPack; projectName: string }> {
	const provider = getProvider(source);
	const [version, project] = await Promise.all([
		provider.getVersion(projectId, versionId),
		provider.getProject(projectId)
	]);

	if (source === 'modrinth') {
		const file = version.files.find((f) => f.primary) ?? version.files[0];
		if (!file) throw new Error('That Modrinth version has no downloadable pack file.');
		const res = await fetch(file.url);
		if (!res.ok) throw new Error(`Could not download the pack (${res.status}).`);
		return { pack: parsePack(Buffer.from(await res.arrayBuffer())), projectName: project.name };
	}

	const loader = (version.loaders[0] ?? 'forge') as ModloaderId;
	// A version can be tagged with several game versions ("1.12" and
	// "1.12.2"); the newest is the one it actually targets. Taking the first
	// installed MeatballCraft on 1.12 with the wrong Forge.
	const minecraftVersion =
		[...version.gameVersions].sort((a, b) => compareVersions(b, a))[0] ?? '';
	const pack = packFromFileList({
		name: project.name,
		version: version.versionNumber,
		minecraftVersion,
		modloader: loader,
		modloaderVersion: version.loaderVersions?.[loader] ?? null,
		files: version.files.map((f) => ({
			path: f.path ?? 'mods',
			name: f.filename,
			url: f.url,
			sha1: f.hash?.algo === 'sha1' ? f.hash.value : null
		}))
	});
	if (!pack.minecraftVersion) {
		throw new Error(
			'That version does not declare a Minecraft version. Download the pack and use the upload option instead.'
		);
	}
	return { pack, projectName: project.name };
}
