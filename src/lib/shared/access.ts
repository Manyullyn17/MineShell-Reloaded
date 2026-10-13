/**
 * Who may do what, as data both sides share: the permission ids, what each
 * implies, and `can`, the one answer to "may this account do X on this
 * server". The server loads an account's Access (lib/server/access.ts) and
 * checks every request against its route policy (lib/server/access/policy.ts);
 * pages use the same `can` to decide what to show.
 *
 * The owner and global admins may do everything everywhere. An instance admin
 * may do everything on that server (permissions added later included), but
 * not hand out access. Everyone else has the permissions listed for them per
 * server, with player data limited to all players or chosen UUIDs.
 */

/** Per-server permissions. Every one includes `view`. */
export const INSTANCE_PERMISSIONS = [
	'view',
	'power',
	'console.read',
	'console.command',
	'players.manage',
	'players.data.view',
	'players.data.edit',
	'mods',
	'datapacks',
	'software',
	'settings.view',
	'settings.edit',
	'files',
	'backups.create',
	'backups.restore',
	'backups.delete',
	'world',
	'map.render',
	'duplicate',
	'delete'
] as const;

export type InstancePermission = (typeof INSTANCE_PERMISSIONS)[number];

export const isInstancePermission = (value: unknown): value is InstancePermission =>
	typeof value === 'string' && (INSTANCE_PERMISSIONS as readonly string[]).includes(value);

/**
 * Permissions that can run a program on the machine as MineShell's own user
 * (a mod, a file, a Java path), and through it reach everything MineShell can.
 * Only for people trusted that far; the access editor says so.
 */
export const FULL_TRUST: readonly InstancePermission[] = ['files', 'mods', 'software'];

/** What a permission brings with it, besides `view`. */
const IMPLIES: Partial<Record<InstancePermission, InstancePermission[]>> = {
	'settings.edit': ['settings.view'],
	'players.data.edit': ['players.data.view']
};

/** Player data access on one server: nobody, every player (later ones too), or these UUIDs. */
export type PlayerScope = 'none' | 'all' | string[];

/** An account's access to one server. */
export type InstanceGrant = {
	admin: boolean;
	permissions: InstancePermission[];
	playerView: PlayerScope;
	playerEdit: PlayerScope;
};

/** An account's access, as resolved for a request. Plain data, so a page can be given it. */
export type Access = {
	owner: boolean;
	/** Owner included. */
	globalAdmin: boolean;
	/** May add servers. Global admins may. */
	canCreate: boolean;
	instances: Record<string, InstanceGrant>;
};

/** Which players a check is about: one UUID, at least one player (`any`), or every player (`all`). */
export type PlayerTarget = string | 'any' | 'all';

function scopeCovers(scope: PlayerScope, target: PlayerTarget): boolean {
	if (scope === 'all') return true;
	if (scope === 'none') return false;
	if (target === 'all') return false;
	if (target === 'any') return scope.length > 0;
	return scope.includes(target.toLowerCase());
}

/**
 * Whether the account may do `permission` on the server `instanceId`.
 * `admin` asks for instance admin (or global admin) itself. Player data
 * permissions also need `player`: editing counts as viewing for the same
 * players, so a view check passes on either scope.
 */
export function can(
	access: Access,
	instanceId: string,
	permission: InstancePermission | 'admin',
	player?: PlayerTarget
): boolean {
	if (access.globalAdmin) return true;
	const grant = access.instances[instanceId];
	if (!grant) return false;
	if (grant.admin) return true;
	if (permission === 'admin') return false;
	if (permission === 'players.data.view' || permission === 'players.data.edit') {
		const target = player ?? 'any';
		if (scopeCovers(grant.playerEdit, target)) return true;
		return permission === 'players.data.view' && scopeCovers(grant.playerView, target);
	}
	if (permission === 'view') return true;
	return grant.permissions.some((held) => held === permission || IMPLIES[held]?.includes(permission));
}

/** Everything allowed: what the owner has, and what MINESHELL_AUTH=off gives every request. */
export const FULL_ACCESS: Access = { owner: true, globalAdmin: true, canCreate: true, instances: {} };
