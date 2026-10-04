import { defineEnvVars } from '@sveltejs/kit/env';

/**
 * The environment MineShell reads (see .env.example), served by SvelteKit as
 * `$app/env/private`. Read when the app starts, never inlined into the build.
 * Each one is optional and undefined when unset, as `$env/dynamic/private` had
 * it: config.ts supplies the defaults, some with `??` (an empty
 * MINESHELL_PRIVILEGE_PREFIX means "no prefix", unset means `sudo -n`).
 */
const optional = { schema: (value: string | undefined) => value };

export const variables = defineEnvVars({
	MINESHELL_DATA: optional,
	MINESHELL_SYSTEMD_SCOPE: optional,
	MINESHELL_UNIT_PREFIX: optional,
	MINESHELL_PRIVILEGE_PREFIX: optional,
	MINESHELL_AUTH: optional,
	CURSEFORGE_API_KEY: optional,
	XDG_DATA_HOME: optional,
	XDG_CONFIG_HOME: optional
});
