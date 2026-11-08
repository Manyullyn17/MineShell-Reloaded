import { chooseFugue, installChosenMod, isFugueJar, scanModJars } from './cleanroom';
import type { ServerInstance } from './db/schema';
import { InstanceError } from './instances';
import { bestVersion, getModProvider, hasEnabledMod, installModVersion, setModEnabled, syncMods } from './mods';
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
	const key = `${instance.id}:${modId}`;
	installing.add(key);
	return startTask({ label: `Install ${project.name} on ${instance.name}`, instanceId: instance.id }, async (task) => {
		try {
			task.setProgress(null, `Installing ${project.name}`);
			await installModVersion(instance, 'modrinth', project, best);
			task.log(`Installed ${project.name} ${best.versionNumber}.`);
			await installRequiredMods(instance, best, task);
			// Other untracked jars are the user's own, not a pack's.
			await syncMods(instance, { fromPack: false }).catch(() => undefined);
			task.setProgress(100, `Installed; ${project.name} loads the next time the server starts`);
		} finally {
			installing.delete(key);
		}
	});
}

/**
 * A crash diagnosis' "Install a matching Fugue", for a crash it blames on Fugue not fitting
 * the Cleanroom: the build pickFugue finds for the server's Cleanroom, and the Fugue jars
 * enabled before disabled once it is in. Refused before the task when no build fits, or the
 * one that fits is already the one enabled: then another Fugue cannot help, Cleanroom's
 * version is what to change.
 */
export async function installMatchingFugue(instance: ServerInstance): Promise<string> {
	const cleanroom = instance.modloader === 'cleanroom' ? instance.modloaderVersion : null;
	if (!cleanroom) throw new InstanceError('Fugue is only for Cleanroom servers.');
	const chosen = await chooseFugue(instance);
	const { version } = chosen;
	if (!version) throw new InstanceError(`No Fugue build runs on Cleanroom ${cleanroom}: change Cleanroom's version in the server's Settings.`);
	const file = version.files.find((f) => f.primary) ?? version.files[0];
	const enabled = (await scanModJars(instance.path)).filter((j) => j.enabled && (j.modids.includes('fugue') || isFugueJar(j.fileName)));
	if (enabled.some((j) => j.fileName === file?.filename)) {
		throw new InstanceError(
			`Fugue ${version.versionNumber} is installed, and it is the newest build made for Cleanroom ${cleanroom}: change Cleanroom's version in the server's Settings, or disable the mod that crashed.`
		);
	}
	const key = `${instance.id}:fugue`;
	installing.add(key);
	return startTask({ label: `Install Fugue ${version.versionNumber} on ${instance.name}`, instanceId: instance.id }, async (task) => {
		try {
			task.setProgress(null, `Installing Fugue ${version.versionNumber}`);
			const added = await installChosenMod(instance, { ...chosen, version });
			task.log(`Installed Fugue ${version.versionNumber}, made for Cleanroom ${cleanroom}.`);
			// Only once the new one is in: a failed download keeps the old one.
			for (const jar of enabled.filter((j) => j.fileName !== added)) {
				await setModEnabled(instance, jar.fileName, false);
				task.log(`Disabled ${jar.fileName}.`);
			}
			task.setProgress(100, `Installed; Fugue ${version.versionNumber} loads the next time the server starts`);
		} finally {
			installing.delete(key);
		}
	});
}

/** `<instance id>:<mod id>` of the dependency installs whose task is still running; `fugue` also for installMatchingFugue. */
const installing = new Set<string>();

/** The diagnosis' "Install" for this mod was pressed and its task has not ended: the banner says so instead. */
export function installingDependency(instanceId: string, modId: string): boolean {
	return installing.has(`${instanceId}:${modId}`);
}
