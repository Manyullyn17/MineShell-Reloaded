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

/**
 * Cleanroom 0.6.0 replaced the standard Mixin library with its own fork,
 * CleanMix. Mods that reach into Mixin internals (FermiumBooter) or rely on
 * exact patch targets (Alfheim) fail on it, which is most older Forge packs.
 * No version means "latest", which is on CleanMix.
 */
export function usesCleanMix(loaderVersion: string | null | undefined): boolean {
	if (!loaderVersion) return true;
	const [major = 0, minor = 0] = numericParts(loaderVersion);
	return major > 0 || minor >= 6;
}

export const CLEANMIX_WARNING =
	'Cleanroom 0.6 and newer replace the Mixin library with CleanMix. Mods that hook into Mixin internals (e.g. FermiumBooter) or patch exact game code (e.g. Alfheim) can fail on it; existing Forge packs usually run better on 0.5.x.';

/** The newest pre-CleanMix version from a newest-first list, for Forge packs. */
export function recommendedForForgePacks(versions: string[]): string | null {
	return versions.find((v) => !usesCleanMix(v)) ?? null;
}
