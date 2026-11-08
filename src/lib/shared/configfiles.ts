/**
 * Which files the mod config form (configform.ts) reads, and when a server takes in a change
 * to one: apart from the form, so pages can ask without loading its parsers.
 */

export type ConfigFormat = 'toml' | 'forgecfg' | 'json';

export function configFormatOf(fileName: string): ConfigFormat | null {
	const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
	if (ext === 'toml') return 'toml';
	if (ext === 'cfg') return 'forgecfg';
	if (ext === 'json' || ext === 'json5' || ext === 'jsonc') return 'json';
	return null;
}

/**
 * When the server takes in a change to this file. Forge and NeoForge watch the configs they
 * manage (`<mod>-common.toml`, `-server.toml`, a world's serverconfig/) and read them again
 * when saved (unless fml.toml's `disableConfigWatcher`); a `-client.toml` is not loaded on a
 * server at all; most else is read once at start.
 */
export function whenApplied(path: string, modloader: string): string {
	const file = path.split('/').at(-1) ?? path;
	const forge = modloader === 'neoforge' ? 'NeoForge' : modloader === 'forge' ? 'Forge' : null;
	if (path.startsWith('defaultconfigs/')) {
		return 'Copied into a world only when the world is created: change the world’s own copy, in its serverconfig folder, for this server.';
	}
	if (forge && /-client\.toml$/i.test(file)) return `A client config: ${forge} does not load it on a server, so changing it here does nothing for the server.`;
	if (forge && /\.toml$/i.test(file) && (/(^|\/)serverconfig\//.test(path) || /-(common|server|startup)\.toml$/i.test(file))) {
		return `${forge} reads this file again when it is saved, while the server runs; some settings still only take effect at the next start.`;
	}
	return 'Most mods read their config when the server starts: restart it to apply a change.';
}
