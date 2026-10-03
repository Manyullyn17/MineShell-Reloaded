import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Every table is defined here. When you change something, run
 * `npm run db:generate` to have drizzle-kit draft a migration into ./migrations,
 * then rename it to the next NNNN_ prefix. The runtime migrator applies plain
 * .sql files in filename order, so drizzle-kit is a convenience, not a runtime
 * dependency.
 */

/** A managed Minecraft server. `id` doubles as the systemd instance name. */
export const serverInstances = sqliteTable('server_instances', {
	/** slug, safe for systemd: [a-z0-9][a-z0-9_-]* */
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	/** Absolute path to the instance directory (WorkingDirectory of the unit). */
	path: text('path').notNull(),

	minecraftVersion: text('minecraft_version').notNull(),
	/** vanilla | fabric | forge | neoforge | quilt | cleanroom */
	modloader: text('modloader').notNull().default('vanilla'),
	modloaderVersion: text('modloader_version'),

	/** Where this instance came from, for display and future update flows. */
	packSource: text('pack_source'), // modrinth | curseforge | ftb | manual
	packProjectId: text('pack_project_id'),
	packVersionId: text('pack_version_id'),
	/** The pack version's label, as people see it; pack_version_id is the provider's id. */
	packVersionName: text('pack_version_name'),
	packName: text('pack_name'),
	/** JSON array: data packs the installed pack version put into the world (see packworld.ts). Null: unknown. */
	packDatapacks: text('pack_datapacks'),

	/** Arguments after the JVM args, e.g. `-jar server.jar nogui` or Forge's `@args` form. */
	launchArgs: text('launch_args').notNull().default('-jar server.jar nogui'),
	jvmArgs: text('jvm_args').notNull().default('-Xms1G -Xmx4G'),
	memoryMaxMb: integer('memory_max_mb').default(4096),
	memoryMinMb: integer('memory_min_mb').default(1024),

	/** Explicit java binary. Null means "resolve automatically from MC version". */
	javaPath: text('java_path'),

	serverPort: integer('server_port').notNull().default(25565),
	rconPort: integer('rcon_port').notNull().default(25575),
	/** Encrypted at rest, see lib/server/crypto.ts */
	rconPasswordEnc: text('rcon_password_enc'),

	/** none | interval | daily */
	restartSchedule: text('restart_schedule').notNull().default('none'),
	restartIntervalHours: integer('restart_interval_hours').default(6),
	/** HH:MM local time, used when restartSchedule = 'daily' */
	restartDailyTime: text('restart_daily_time').default('05:00'),
	restartWarnMinutes: integer('restart_warn_minutes').notNull().default(5),
	/** Postpone a scheduled restart while anyone is online. */
	restartSkipIfPlayers: integer('restart_skip_if_players', { mode: 'boolean' })
		.notNull()
		.default(false),
	restartNextAt: integer('restart_next_at'),

	autoRestartOnCrash: integer('auto_restart_on_crash', { mode: 'boolean' })
		.notNull()
		.default(true),
	crashRestartLimit: integer('crash_restart_limit').notNull().default(5),
	crashRestartWindowSec: integer('crash_restart_window_sec').notNull().default(600),

	/** systemd resource limits (limits.conf drop-in); null = none. CPU in percent of one core. */
	limitMemoryMb: integer('limit_memory_mb'),
	limitCpuPercent: integer('limit_cpu_percent'),

	/** Console view preferences, per instance, unenforced by design. */
	consoleBacklogLines: integer('console_backlog_lines').notNull().default(300),
	consoleBufferLines: integer('console_buffer_lines').notNull().default(2000),

	eulaAccepted: integer('eula_accepted', { mode: 'boolean' }).notNull().default(false),
	pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
	notes: text('notes'),

	/** Set while a create/import task is still running. */
	status: text('status').notNull().default('ready'), // provisioning | ready | failed
	statusMessage: text('status_message'),

	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

/** Mod identity, shared across instances. */
export const mods = sqliteTable(
	'mods',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		/** modrinth | curseforge | ftb | manual */
		source: text('source').notNull().default('manual'),
		/** Modrinth slug / CurseForge project id / filename for manual mods. */
		slug: text('slug').notNull(),
		name: text('name').notNull(),
		author: text('author'),
		summary: text('summary'),
		projectUrl: text('project_url'),
		iconUrl: text('icon_url')
	},
	(t) => ({
		sourceSlug: uniqueIndex('mods_source_slug_idx').on(t.source, t.slug)
	})
);

/** The per-instance, per-mod detail: which file, which version, enabled or not. */
export const instanceMods = sqliteTable(
	'instance_mods',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		instanceId: text('instance_id')
			.notNull()
			.references(() => serverInstances.id, { onDelete: 'cascade' }),
		modId: integer('mod_id')
			.notNull()
			.references(() => mods.id, { onDelete: 'cascade' }),
		version: text('version'),
		versionId: text('version_id'),
		/** Path relative to the instance directory, e.g. mods/sodium-0.5.8.jar */
		filePath: text('file_path').notNull(),
		/** sha512 for Modrinth, sha1 for CurseForge; reserved for integrity + future cache. */
		hash: text('hash'),
		hashAlgo: text('hash_algo'),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
		/** True when the mod arrived as part of a modpack import. */
		fromPack: integer('from_pack', { mode: 'boolean' }).notNull().default(false),
		/** Never touched by bulk update runs. */
		locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
		/** This jar is known not to belong on a dedicated server; see clientonly.ts. */
		clientOnly: integer('client_only', { mode: 'boolean' }).notNull().default(false),
		flags: text('flags'), // JSON array
		installedAt: integer('installed_at').notNull()
	},
	(t) => ({
		byInstance: index('instance_mods_instance_idx').on(t.instanceId),
		uniqueFile: uniqueIndex('instance_mods_file_idx').on(t.instanceId, t.filePath)
	})
);

/** CPU/memory samples pulled from cgroups. 10s cadence, 24h retention. */
export const resourceSamples = sqliteTable(
	'resource_samples',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		instanceId: text('instance_id')
			.notNull()
			.references(() => serverInstances.id, { onDelete: 'cascade' }),
		timestamp: integer('timestamp').notNull(),
		cpuPercent: real('cpu_percent').notNull(),
		memoryBytes: integer('memory_bytes').notNull()
	},
	(t) => ({
		byInstanceTime: index('resource_samples_instance_ts_idx').on(t.instanceId, t.timestamp)
	})
);

/** Discovered (or manually registered) JDKs. */
export const javaRuntimes = sqliteTable('java_runtimes', {
	path: text('path').primaryKey(),
	majorVersion: integer('major_version').notNull(),
	versionString: text('version_string').notNull(),
	vendor: text('vendor'),
	/** Added by hand rather than found by the scanner. */
	manual: integer('manual', { mode: 'boolean' }).notNull().default(false),
	lastSeenAt: integer('last_seen_at').notNull()
});

/** Single-row-per-key app settings. */
export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

/** Console commands on a schedule (lib/server/scheduledcommands.ts). */
export const scheduledCommands = sqliteTable(
	'scheduled_commands',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		instanceId: text('instance_id')
			.notNull()
			.references(() => serverInstances.id, { onDelete: 'cascade' }),
		command: text('command').notNull(),
		/** Exactly one of everyMinutes / dailyTime (HH:MM, server-local) is set. */
		everyMinutes: integer('every_minutes'),
		dailyTime: text('daily_time'),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
		nextAt: integer('next_at'),
		lastRunAt: integer('last_run_at'),
		lastResult: text('last_result'),
		createdAt: integer('created_at').notNull()
	},
	(t) => ({
		byInstance: index('scheduled_commands_instance_idx').on(t.instanceId)
	})
);

export type ScheduledCommand = typeof scheduledCommands.$inferSelect;

/**
 * Operations in progress, one per instance at most; see lib/server/operations.ts.
 * Deleted in the same transaction that commits the operation's result.
 */
export const operations = sqliteTable('operations', {
	instanceId: text('instance_id')
		.primaryKey()
		.references(() => serverInstances.id, { onDelete: 'cascade' }),
	kind: text('kind').notNull(),
	/** JSON: what recovery needs to put the instance back (see Journal). */
	journal: text('journal').notNull(),
	/** Token of the MineShell process running it; recovery skips its own. */
	process: text('process').notNull(),
	startedAt: integer('started_at').notNull()
});

/** Login sessions. Only used when MINESHELL_AUTH is on. */
export const sessions = sqliteTable('sessions', {
	id: text('id').primaryKey(),
	createdAt: integer('created_at').notNull(),
	expiresAt: integer('expires_at').notNull(),
	userAgent: text('user_agent')
});

/** Append-only record of what MineShell did, so surprises are explainable. */
export const auditLog = sqliteTable(
	'audit_log',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		timestamp: integer('timestamp').notNull(),
		instanceId: text('instance_id'),
		action: text('action').notNull(),
		detail: text('detail'),
		/** ui | scheduler | monitor | system */
		actor: text('actor').notNull().default('ui')
	},
	(t) => ({
		byTime: index('audit_log_ts_idx').on(t.timestamp)
	})
);

export type ServerInstance = typeof serverInstances.$inferSelect;
export type NewServerInstance = typeof serverInstances.$inferInsert;
export type Mod = typeof mods.$inferSelect;
export type InstanceMod = typeof instanceMods.$inferSelect;
export type JavaRuntime = typeof javaRuntimes.$inferSelect;

/** Fields mapped onto a path in player NBT, per server (see playerfields.ts). */
export const playerFields = sqliteTable(
	'player_fields',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		instanceId: text('instance_id')
			.notNull()
			.references(() => serverInstances.id, { onDelete: 'cascade' }),
		label: text('label').notNull(),
		/** JSON array of compound keys and list indices. */
		path: text('path').notNull(),
		/** number | checkbox | text */
		kind: text('kind').notNull(),
		createdAt: integer('created_at').notNull()
	},
	(t) => ({
		byInstance: index('player_fields_instance_idx').on(t.instanceId)
	})
);

