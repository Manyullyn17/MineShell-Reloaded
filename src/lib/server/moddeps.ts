import type { ServerInstance } from './db/schema';
import { InstanceError } from './instances';
import { bestVersion, getModProvider, hasEnabledMod, installModVersion, syncMods } from './mods';
import type { ProjectVersion } from './mods/types';
import { compatibleVersions, filterFor } from './modupdates';
import { startTask, type TaskHandle } from './tasks';

/**
 * What a mod MineShell adds for a feature (the BlueMap mod, Chunky) needs and
 * the server does not have yet: on Fabric, Fabric API, which a pack usually
 * brings and a bare server lacks. Present is a jar declaring the project's
 * slug as its mod id, as Fabric API's does.
 */
export async function installRequiredMods(instance: ServerInstance, version: ProjectVersion, task: TaskHandle): Promise<void> {
	const provider = getModProvider('modrinth');
	for (const dep of version.dependencies.filter((d) => d.type === 'required' && d.projectId)) {
		const project = await provider.getProject(dep.projectId!);
		if (await hasEnabledMod(instance.path, project.slug)) continue;
		const needed = dep.versionId
			? await provider.getVersion(dep.projectId!, dep.versionId)
			: bestVersion(await compatibleVersions('modrinth', dep.projectId!, filterFor(instance)));
		if (!needed) throw new InstanceError(`${version.name} needs ${project.name}, which has no build for ${instance.modloader} ${instance.minecraftVersion}.`);
		await installModVersion(instance, 'modrinth', project, needed);
		task.log(`Installed ${project.name} ${needed.versionNumber}, which it needs.`);
	}
}

/**
 * The Modrinth project of a library mods require by id, where the two differ: Fabric API's id
 * was `fabric` until 0.43 (2021), and mods like Chunky still declare that. Any other id is
 * tried as a project slug, which most mods keep the same as their id.
 */
const LIBRARY_PROJECTS: Record<string, string> = {
	fabric: 'fabric-api',
	'fabric-api': 'fabric-api',
	quilted_fabric_api: 'qsl',
	qsl: 'qsl',
	'fabric-language-kotlin': 'fabric-language-kotlin',
	architectury: 'architectury-api',
	'cloth-config': 'cloth-config',
	'cloth-config2': 'cloth-config'
};

/**
 * A crash diagnosis' "Install": the mod a crashed server's mod needs, by the id the loader
 * named, in the build for this server's loader and Minecraft version, with what that build
 * needs in turn. Looked up before the task, so a mod Modrinth does not have, or has no build
 * of for this server, is refused with a reason rather than a failed task.
 */
export async function installDependency(instance: ServerInstance, modId: string): Promise<string> {
	if (!/^[a-z0-9_.-]+$/.test(modId)) throw new InstanceError('That is not a mod id.');
	const provider = getModProvider('modrinth');
	const slug = LIBRARY_PROJECTS[modId] ?? modId;
	const project = await provider.getProject(slug).catch(() => null);
	if (!project) throw new InstanceError(`Modrinth has no mod "${modId}": find it on the Mods tab, or disable the mod that needs it.`);
	const best = bestVersion(await compatibleVersions('modrinth', project.id, filterFor(instance)));
	if (!best) throw new InstanceError(`${project.name} has no build for ${instance.modloader} ${instance.minecraftVersion} on Modrinth.`);
	return startTask({ label: `Install ${project.name} on ${instance.name}`, instanceId: instance.id }, async (task) => {
		task.setProgress(null, `Installing ${project.name}`);
		await installModVersion(instance, 'modrinth', project, best);
		task.log(`Installed ${project.name} ${best.versionNumber}.`);
		await installRequiredMods(instance, best, task);
		// Other untracked jars are the user's own, not a pack's.
		await syncMods(instance, { fromPack: false }).catch(() => undefined);
		task.setProgress(100, `Installed; ${project.name} loads the next time the server starts`);
	});
}
