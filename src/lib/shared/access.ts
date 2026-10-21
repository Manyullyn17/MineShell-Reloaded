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
 * The permissions as the access editor shows them, in groups. Player data is
 * shown apart from these, with its scopes; `view` comes with any access.
 */
export const PERMISSION_GROUPS: { label: string; permissions: { id: InstancePermission; label: string; hint: string }[] }[] = [
	{
		label: 'Server',
		permissions: [
			{ id: 'power', label: 'Start and stop', hint: 'Start, stop, restart and force stop, with or without a countdown.' },
			{ id: 'duplicate', label: 'Copy it', hint: 'Also needs Files here and "may create servers": the copy has every file, and its maker becomes its admin.' },
			{ id: 'delete', label: 'Delete it', hint: 'Remove the server, and its files if asked.' }
		]
	},
	{
		label: 'Console',
		permissions: [
			{ id: 'console.read', label: 'Read the console and logs', hint: "Output, past runs' logs and crash lines; they show players' IP addresses and chat." },
			{ id: 'console.command', label: 'Send commands', hint: 'The console, saved and scheduled commands, the operators list, the Spark profiler.' }
		]
	},
	{
		label: 'Players',
		permissions: [{ id: 'players.manage', label: 'Manage players', hint: 'Whitelist, bans and IP bans, kicking. Operators also need Send commands.' }]
	},
	{
		label: 'Mods and versions',
		permissions: [
			{ id: 'mods', label: 'Mods', hint: 'Install, update, disable and remove mods, find a crashing one, add a map mod.' },
			{ id: 'datapacks', label: 'Data packs', hint: 'Install and remove data packs.' },
			{ id: 'software', label: 'Loader, modpack and Java', hint: 'Loader and Minecraft versions, pack versions and rollbacks, Cleanroom, the Java runtime and launch settings.' }
		]
	},
	{
		label: 'Settings',
		permissions: [
			{ id: 'settings.view', label: 'See settings', hint: 'Without the RCON password.' },
			{ id: 'settings.edit', label: 'Change settings', hint: 'Name, notes, server.properties, ports, memory, restarts, tags. Not the Java and launch settings.' }
		]
	},
	{
		label: 'World and backups',
		permissions: [
			{ id: 'backups.create', label: 'Take snapshots', hint: 'Snapshots by hand and on a schedule.' },
			{ id: 'backups.restore', label: 'Restore snapshots', hint: 'Put a snapshot back over the world.' },
			{ id: 'backups.delete', label: 'Delete snapshots', hint: 'Delete or unpin them, and how many are kept.' },
			{ id: 'world', label: 'World tools', hint: 'Reset or prune the world, upload one, pre-generate it with Chunky.' },
			{ id: 'map.render', label: 'Render the map', hint: 'Set up, render and schedule the world map. Looking at it needs nothing more.' }
		]
	},
	{
		label: 'Files',
		permissions: [
			{ id: 'files', label: 'Files', hint: "Every file of the server, world downloads, client pack export, the RCON password." }
		]
	}
];

/**
 * Permissions that can run a program on the machine as MineShell's own user
 * (a mod, a file, a Java path), and through it reach everything MineShell can.
 * Only for people trusted that far; the access editor says so.
 */
export const FULL_TRUST: readonly InstancePermission[] = ['files', 'mods', 'software'];

/** The "full trust" tag's explanation: on those permissions, a server's admin, adding servers and MineShell admin. */
export const FULL_TRUST_NOTE = 'Can run programs on this machine as MineShell, and through that reach everything';

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

/** Who may cancel a task: admins of its server; one of no server (a Java download, an update), global admins. */
export const mayCancelTask = (access: Access, task: { instanceId: string | null }): boolean =>
	task.instanceId ? can(access, task.instanceId, 'admin') : access.globalAdmin;

/** Everything allowed: what the owner has, and what MINESHELL_AUTH=off gives every request. */
export const FULL_ACCESS: Access = { owner: true, globalAdmin: true, canCreate: true, instances: {} };

/** Nothing allowed: a visitor who is not signed in. */
export const NO_ACCESS: Access = { owner: false, globalAdmin: false, canCreate: false, instances: {} };
