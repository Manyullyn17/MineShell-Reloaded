import type { InstancePermission } from '#lib/shared/access.js';

/**
 * What every route needs, in one table: each page's load and form actions,
 * each endpoint's methods. guard.ts applies it to every request before
 * anything runs. Anything not listed here is refused, the owner included, and
 * policy.test.ts fails when a route, action or method has no entry - so a new
 * one cannot be reachable by accident.
 *
 * Instance routes take the server from `params.id`, player routes the player
 * from `params.uuid`. Where the answer depends on what was posted (which list,
 * pin or unpin, a data pack or a mod), the entry is `handler(...)`: the table
 * holds the least it takes, and the handler checks the rest with requireAccess.
 */

export type Requirement =
	/** Anyone, signed in or not. */
	| 'public'
	| 'signedIn'
	/** May add servers. */
	| 'create'
	| 'globalAdmin'
	| 'owner'
	/** A permission on the server in `params.id`; `admin` asks for instance admin. */
	| { instance: InstancePermission | 'admin'; player?: 'uuid' | 'any' | 'all' }
	| { any: Requirement[] }
	| { all: Requirement[] }
	/** `base` here; the handler checks more, for the reason given. */
	| { base: Requirement; handler: string };

export type PagePolicy = { load: Requirement; actions?: Record<string, Requirement> };
export type EndpointPolicy = { methods: Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS', Requirement>> };

const on = (instance: InstancePermission | 'admin', player?: 'uuid' | 'any' | 'all'): Requirement =>
	player ? { instance, player } : { instance };
const handler = (base: Requirement, why: string): Requirement => ({ base, handler: why });

export const POLICY: Record<string, PagePolicy | EndpointPolicy> = {
	// ------------------------------------------------------------ sign-in
	'/login': { load: 'public', actions: { login: 'public', logout: 'public' } },
	'/setup': { load: 'public', actions: { default: 'public' } },

	// ------------------------------------------------------------ MineShell-wide
	'/': { load: 'signedIn' },
	// Your own password and sessions.
	'/account': { load: 'signedIn', actions: { password: 'signedIn', signOutOthers: 'signedIn' } },
	// Where a refused page sends the browser.
	'/denied': { load: 'signedIn' },
	'/about': { load: 'signedIn' },
	'/tasks': { load: 'signedIn', actions: { cancel: handler('signedIn', "admin of the task's server; global admin for others") } },
	'/instances/new': { load: 'create', actions: { loader: 'create', upload: 'create', install: 'create', import: 'create' } },
	// A server exported from another MineShell: uploaded by anyone who may create servers; picked
	// by its path on this machine only by the owner, since that reads any file MineShell can.
	'/api/imports': { methods: { PUT: 'create', POST: 'owner' } },
	'/settings': {
		load: 'globalAdmin',
		actions: {
			downloadJava: 'globalAdmin',
			deleteJava: 'globalAdmin',
			javaDefault: 'globalAdmin',
			scanJava: 'globalAdmin',
			addJava: 'globalAdmin',
			removeJava: 'globalAdmin',
			savePreset: 'globalAdmin',
			updatePreset: 'globalAdmin',
			deletePreset: 'globalAdmin',
			snapshots: 'globalAdmin',
			// A folder on this machine MineShell writes into, as picking an import by its path reads one.
			addBackupFolder: 'owner',
			removeBackupFolder: 'owner',
			backupFolderCompress: 'owner',
			installUnit: 'globalAdmin',
			serverCap: 'globalAdmin',
			portChange: 'globalAdmin',
			portRanges: 'globalAdmin',
			itemIcons: 'globalAdmin',
			sftp: 'globalAdmin',
			trashDays: 'globalAdmin',
			logDays: 'globalAdmin',
			notifications: 'globalAdmin',
			notificationsTest: 'globalAdmin',
			notificationsRemove: 'globalAdmin',
			// Integrations: using them is up to each feature's permission; managing them is the owner's.
			curseforgeKey: 'owner',
			removeCurseforgeKey: 'owner',
			playitLink: 'owner',
			playitRouting: 'owner',
			playitCancel: 'owner',
			playitUnlink: 'owner',
			// Updating MineShell runs its installer.
			checkUpdate: 'owner',
			updateAuto: 'owner',
			update: 'owner',
			downgradePlan: 'owner',
			downgrade: 'owner'
		}
	},
	'/settings/defaults': { load: 'globalAdmin', actions: { save: 'globalAdmin', reset: 'globalAdmin' } },
	// Accounts. Who may change which account (the owner: nobody here; global admins: the owner) is checked in the handlers.
	'/settings/users': { load: 'globalAdmin', actions: { create: handler('globalAdmin', 'only the owner makes global admins') } },
	'/settings/users/[userId]': {
		load: 'globalAdmin',
		actions: {
			flags: handler('globalAdmin', 'accounts.ts mayManage; global admin flag: the owner'),
			disable: handler('globalAdmin', 'accounts.ts mayManage'),
			enable: handler('globalAdmin', 'accounts.ts mayManage'),
			resetPassword: handler('globalAdmin', 'accounts.ts mayManage'),
			signOut: handler('globalAdmin', 'accounts.ts mayManage'),
			delete: handler('globalAdmin', 'accounts.ts mayManage'),
			access: handler('globalAdmin', 'accounts.ts mayManage')
		}
	},
	'/api/tasks': { methods: { GET: 'signedIn' } },
	'/api/update': { methods: { GET: 'owner' } },
	// Lets downloads reach one exact local or private address (downloadaccess.ts).
	'/api/downloads/allowed': { methods: { POST: 'globalAdmin', DELETE: 'globalAdmin' } },
	'/api/skins/[texture]': { methods: { GET: 'signedIn' } },
	// Catalog searches (Modrinth, CurseForge through MineShell's key) for installing and creating.
	'/api/loaders/versions': { methods: { GET: 'signedIn' } },
	'/api/mods/dependencies': { methods: { GET: 'signedIn' } },
	'/api/mods/details': { methods: { GET: 'signedIn' } },
	'/api/mods/filters': { methods: { GET: 'signedIn' } },
	'/api/mods/search': { methods: { GET: 'signedIn' } },
	'/api/mods/versions': { methods: { GET: 'signedIn' } },
	'/api/packs/preview': { methods: { GET: 'signedIn' } },
	'/api/packs/search': { methods: { GET: 'signedIn' } },
	'/api/packs/versions': { methods: { GET: 'signedIn' } },

	// ------------------------------------------------------------ a server
	'/instances/[id]': {
		load: on('view'),
		actions: {
			power: on('power'),
			cancelCountdown: on('power'),
			eula: on('power'),
			dismissNotice: on('power'),
			clearCrashes: on('power'),
			// Starts with fml.queryResult=confirm, which can drop registry entries from the world.
			// server.properties, as Settings' game settings.
			tickLimit: on('settings.edit'),
			forgeAnswer: on('software'),
			retryDownloads: on('software'),
			forgetDownloads: on('software'),
			skipUpdate: on('software'),
			skipModUpdates: on('mods'),
			modFix: on('mods'),
			profile: on('console.command'),
			profileStop: on('console.command'),
			profileCancel: on('console.command'),
			profileUpload: on('console.command'),
			kick: on('players.manage'),
			pin: on('settings.edit'),
			notes: on('settings.edit'),
			addTag: on('settings.edit'),
			removeTag: on('settings.edit')
		}
	},
	'/api/instances/[id]/stats': { methods: { GET: on('view') } },
	'/api/instances/[id]/icon': { methods: { GET: on('view'), PUT: on('settings.edit'), DELETE: on('settings.edit') } },

	'/instances/[id]/console': { load: on('console.read') },
	'/api/instances/[id]/console': { methods: { GET: on('console.read') } },
	'/api/instances/[id]/command': { methods: { POST: on('console.command') } },
	'/api/instances/[id]/macros': { methods: { PUT: on('console.command') } },
	'/instances/[id]/logs': {
		load: on('console.read'),
		actions: { mclogsAnalyse: on('console.read'), mclogsShare: on('console.read'), mclogsUnshare: on('console.read') }
	},

	'/instances/[id]/mods': {
		load: on('view'),
		actions: {
			// Starts the server again and again.
			bisect: { all: [on('mods'), on('power')] },
			bisectCancel: on('mods'),
			bisectDismiss: on('mods'),
			updateMods: on('mods'),
			changeVersion: on('mods'),
			toggle: on('mods'),
			lock: on('mods'),
			remove: on('mods'),
			upload: on('mods'),
			sync: on('mods'),
			install: handler({ any: [on('mods'), on('datapacks')] }, 'mods for a mod, datapacks for a data pack'),
			removeDatapack: on('datapacks'),
			updateDatapacks: on('datapacks')
		}
	},
	'/api/instances/[id]/mod-updates': { methods: { GET: on('mods') } },
	'/api/instances/[id]/datapack-updates': { methods: { GET: on('datapacks') } },
	'/api/instances/[id]/mod-versions': { methods: { GET: on('mods') } },
	'/api/instances/[id]/mod-icon': { methods: { GET: on('view') } },

	'/instances/[id]/world': {
		load: on('view'),
		actions: {
			snapshot: on('backups.create'),
			editSnapshot: on('backups.create'),
			pinSnapshot: handler(on('backups.create'), 'unpinning lets retention delete it: backups.delete'),
			restore: on('backups.restore'),
			deleteSnapshot: on('backups.delete'),
			// Another server's copies (one that is gone): a global admin.
			copyBack: handler(on('backups.create'), "another server's copies: global admin"),
			chunkyStart: on('world'),
			chunkyConfirm: on('world'),
			chunkyPause: on('world'),
			chunkyContinue: on('world'),
			chunkyCancel: on('world'),
			chunkyAuto: on('world'),
			chunkyRestart: on('world'),
			pruneAnalyse: on('world'),
			prune: on('world'),
			resetDimension: on('world'),
			reset: on('world'),
			switchWorld: on('world'),
			createWorld: on('world'),
			renameWorld: on('world'),
			deleteWorld: handler(on('world'), 'deleting its snapshots too: backups.delete'),
			worldFromSnapshot: on('world')
		}
	},
	// A world zip holds every player's data: file access.
	'/api/instances/[id]/world': { methods: { GET: on('files'), PUT: on('world') } },
	'/instances/[id]/world/chunks': { load: on('backups.restore'), actions: { restore: on('backups.restore'), iconEula: on('backups.restore') } },
	// The chunk map shows the world from above: drawn for the page that restores chunks.
	'/api/instances/[id]/chunkmap': { methods: { GET: on('backups.restore') } },
	// Pruning shows the terrain under its heatmap.
	'/api/instances/[id]/chunkmap/region': { methods: { GET: { any: [on('backups.restore'), on('world')] } } },
	// Every chunk's InhabitedTime, from the last analysis: the heatmap on World > Prune chunks.
	'/api/instances/[id]/prune-analysis': { methods: { GET: on('world') } },

	'/instances/[id]/map': {
		load: on('view'),
		actions: {
			setup: on('map.render'),
			modEula: on('map.render'),
			render: on('map.render'),
			dynmapRender: on('map.render'),
			schedule: on('map.render'),
			delete: on('map.render'),
			installMod: on('mods')
		}
	},
	'/instances/[id]/map/full': { load: on('view') },
	// The Map tab's frames, sandboxed: no session comes with them, so the token in the path is
	// the access check (mapframe.ts mapRequest: view; map.render for the live map's POSTs,
	// Dynmap's web chat).
	'/maps/[token]/view/[...path]': { methods: { GET: 'public' } },
	'/maps/[token]/live/[...path]': { methods: { GET: 'public', POST: 'public', OPTIONS: 'public' } },

	'/instances/[id]/players': {
		load: on('view'),
		actions: {
			add: handler(on('players.manage'), 'the ops list also needs console.command'),
			remove: handler(on('players.manage'), 'the ops list also needs console.command'),
			opOptions: { all: [on('players.manage'), on('console.command')] },
			whitelist: on('players.manage'),
			kick: on('players.manage'),
			// The player is in the posted form.
			removeFiles: handler(on('players.data.edit', 'any'), 'the player is posted, checked against players.data.edit')
		}
	},
	'/instances/[id]/players/[uuid]': {
		load: on('players.data.view', 'uuid'),
		actions: {
			// Mojang's EULA for item pictures; the Map's setup accepts the same one.
			iconEula: on('players.data.view', 'uuid'),
			edit: on('players.data.edit', 'uuid'),
			restore: on('players.data.edit', 'uuid'),
			// Fields shown for every player of the server.
			addField: on('players.data.edit', 'all'),
			remapField: on('players.data.edit', 'all'),
			removeField: on('players.data.edit', 'all')
		}
	},
	'/api/instances/[id]/item-icons': { methods: { POST: on('players.data.view', 'any') } },
	'/api/instances/[id]/item-icons/texture': { methods: { GET: on('players.data.view', 'any') } },
	'/api/instances/[id]/item-icons/items': { methods: { GET: on('players.data.edit', 'any') } },

	'/instances/[id]/files': {
		load: on('files'),
		actions: {
			save: on('files'),
			upload: on('files'),
			mkdir: on('files'),
			rename: on('files'),
			delete: on('files'),
			restore: on('files'),
			purge: on('files'),
			emptyTrash: on('files')
		}
	},
	'/instances/[id]/files/usage': { load: on('files'), actions: { deleteOldLogs: on('files') } },
	'/api/instances/[id]/files': { methods: { GET: on('files') } },
	'/api/instances/[id]/file-history': { methods: { GET: on('files') } },
	// A client pack carries the server's configs.
	'/instances/[id]/export': { load: on('files'), actions: { export: on('files') } },
	'/api/instances/[id]/export': { methods: { GET: on('files') } },
	// What the Mods tab shows, as text.
	'/instances/[id]/export/mods': { load: on('view') },
	// The whole server, for another MineShell (serverbundle.ts): all its files, so the same permission.
	'/instances/[id]/export/server': { load: on('files'), actions: { export: on('files') } },
	'/api/instances/[id]/export/server': { methods: { GET: on('files') } },

	'/instances/[id]/properties': { load: on('settings.view') },
	'/instances/[id]/settings': {
		load: on('settings.view'),
		actions: {
			general: on('settings.edit'),
			memory: on('settings.edit'),
			limits: on('settings.edit'),
			network: handler(on('settings.edit'), "moving another server's port needs settings.edit on that server"),
			voiceChat: on('settings.edit'),
			restarts: on('settings.edit'),
			console: on('settings.edit'),
			properties: on('settings.edit'),
			propertiesRaw: on('settings.edit'),
			revealRcon: { any: [on('admin'), on('files')] },
			// Public on the internet through MineShell's playit.gg agent.
			playitPublic: on('admin'),
			playitPrivate: on('admin'),
			addCommand: on('console.command'),
			removeCommand: on('console.command'),
			toggleCommand: on('console.command'),
			snapshotSchedule: on('backups.create'),
			// Retention deletes snapshots; the backup folder's too.
			snapshotPolicy: on('backups.delete'),
			backups: on('backups.delete'),
			launch: on('software'),
			rescanJava: on('software'),
			resolveConfig: on('software'),
			migrate: on('software'),
			changePack: on('software'),
			rollbackPack: on('software'),
			loaderVersion: on('software'),
			updates: on('software'),
			checkUpdates: on('software'),
			unskipUpdate: on('software'),
			// The address is the server admin's to choose; requests to local ones are refused all the same.
			notifications: on('admin'),
			notificationsTest: on('admin'),
			notificationsRemove: on('admin'),
			migrateCleanroom: on('software'),
			revertForge: on('software'),
			cleanroomFixes: on('software'),
			// The copy has every file, player data included, and its creator becomes its admin.
			clone: handler({ all: [on('duplicate'), on('files'), 'create'] }, 'copying the access list too needs a global admin'),
			delete: on('delete')
		}
	},
	'/api/instances/[id]/ports': { methods: { GET: on('settings.view') } },
	'/api/instances/[id]/config-merge': { methods: { GET: on('software') } },
	'/api/instances/[id]/migrate': { methods: { GET: on('software') } },
	'/api/instances/[id]/pack-change': { methods: { GET: on('software'), PUT: on('software') } }
};
