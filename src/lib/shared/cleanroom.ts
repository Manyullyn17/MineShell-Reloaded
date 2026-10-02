/**
 * Cleanroom facts needed on both sides: the server to install and resolve Java,
 * the forms to decide whether to offer Cleanroom at all.
 */

export const CLEANROOM_MINECRAFT = '1.12.2';

/** Cleanroom replaces Forge 1:1, so it is only an option where Forge 1.12.2 is. */
export function canUseCleanroom(modloader: string, minecraftVersion: string): boolean {
	return modloader === 'forge' && minecraftVersion === CLEANROOM_MINECRAFT;
}

function numericParts(version: string): number[] {
	return version.split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
}

/**
 * Measured from the class-file version of each release's launch wrapper:
 * everything up to 0.4.4-alpha targets Java 21, everything from 0.5.0-alpha
 * targets Java 25. No version means "latest".
 */
export function cleanroomJavaMajor(loaderVersion: string | null | undefined): number {
	if (!loaderVersion) return 25;
	const [major = 0, minor = 0] = numericParts(loaderVersion);
	return major > 0 || minor >= 5 ? 25 : 21;
}

/** Cleanroom's own list of what to remove or replace when moving a pack over. */
export const CLEANROOM_GUIDE_URL = 'https://cleanroommc.com/wiki/end-user-guide/preparing-your-modpack';
