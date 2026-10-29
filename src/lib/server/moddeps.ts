import type { ServerInstance } from './db/schema';
import { InstanceError } from './instances';
import { bestVersion, getModProvider, hasEnabledMod, installModVersion } from './mods';
import type { ProjectVersion } from './mods/types';
import { compatibleVersions, filterFor } from './modupdates';
import type { TaskHandle } from './tasks';

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
