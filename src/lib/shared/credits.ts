/**
 * What MineShell is built on and works with, for the About page. README.md's
 * Credits section lists the same (written from this list); change both together.
 */
export type Credit = { name: string; url: string; use: string; license?: string };
export type CreditGroup = { title: string; intro: string; items: Credit[] };

export const CREDITS: CreditGroup[] = [
	{
		title: 'Libraries',
		intro: 'Open source code that ships inside MineShell. Their license texts are in THIRD-PARTY-NOTICES in every release.',
		items: [
			{ name: 'Svelte and SvelteKit', url: 'https://svelte.dev', use: 'The web interface and the server behind it.', license: 'MIT' },
			{ name: 'better-sqlite3', url: 'https://github.com/WiseLibs/better-sqlite3', use: "MineShell's database, with SQLite inside it.", license: 'MIT' },
			{ name: 'SQLite', url: 'https://sqlite.org', use: 'The database engine.', license: 'Public domain' },
			{ name: 'Drizzle ORM', url: 'https://orm.drizzle.team', use: 'Database queries and schema migrations.', license: 'Apache-2.0' },
			{ name: 'marked', url: 'https://marked.js.org', use: 'Mod and pack descriptions and release notes, from Markdown.', license: 'MIT' },
			{ name: 'DOMPurify', url: 'https://github.com/cure53/DOMPurify', use: 'Cleans those descriptions before they are shown.', license: 'Apache-2.0 or MPL-2.0' },
			{ name: 'node-tar', url: 'https://github.com/isaacs/node-tar', use: 'Unpacks Java downloads.', license: 'BlueOak-1.0.0' },
			{ name: 'yauzl and yazl', url: 'https://github.com/thejoshwolfe/yauzl', use: 'Reads and writes zip files: packs, world downloads, client exports.', license: 'MIT' }
		]
	},
	{
		title: 'Built with',
		intro: 'Tools used to make MineShell, not shipped with it.',
		items: [
			{ name: 'Vite', url: 'https://vite.dev', use: 'Builds MineShell and runs it while developing.', license: 'MIT' },
			{ name: 'TypeScript', url: 'https://www.typescriptlang.org', use: 'The language most of MineShell is written in.', license: 'Apache-2.0' },
			{ name: 'Vitest', url: 'https://vitest.dev', use: 'The test suite.', license: 'MIT' },
			{ name: 'Drizzle Kit', url: 'https://orm.drizzle.team/docs/kit-overview', use: 'Generates the database migrations.', license: 'MIT' }
		]
	},
	{
		title: 'Programs',
		intro: 'Downloaded and run by MineShell when a server needs them.',
		items: [
			{ name: 'Eclipse Temurin', url: 'https://adoptium.net', use: 'Java builds MineShell downloads for servers.' },
			{ name: 'Azul Zulu', url: 'https://www.azul.com/downloads/', use: 'Java builds MineShell downloads for servers.' },
			{ name: 'Fabric', url: 'https://fabricmc.net', use: 'Mod loader: its installer and server launcher.' },
			{ name: 'Quilt', url: 'https://quiltmc.org', use: 'Mod loader: its installer.' },
			{ name: 'Minecraft Forge', url: 'https://minecraftforge.net', use: 'Mod loader: its installer.' },
			{ name: 'NeoForge', url: 'https://neoforged.net', use: 'Mod loader: its installer.' },
			{ name: 'Cleanroom', url: 'https://cleanroommc.com', use: 'Mod loader for 1.12.2 packs: its installer, and the client instance for exports.' },
			{ name: 'BlueMap', url: 'https://bluemap.bluecolored.de', use: 'Renders the Map tab for Minecraft 1.13 and newer.' },
			{ name: 'playit.gg agent', url: 'https://playit.gg', use: 'Gives servers a public address without opening ports.' }
		]
	},
	{
		title: 'Mods',
		intro: 'Installed by MineShell or worked with when a server has them.',
		items: [
			{ name: 'Dynmap and DynmapBlockScan', url: 'https://github.com/webbukkit/dynmap', use: 'The live map for 1.12.2 Forge and Cleanroom servers.' },
			{ name: 'BlueMap (mod)', url: 'https://modrinth.com/plugin/bluemap', use: 'A live map with players on it, offered beside the rendered one.' },
			{ name: 'Fugue', url: 'https://modrinth.com/mod/fugue', use: 'Added when a pack moves to Cleanroom, so older mods run on it.' },
			{ name: 'Scalar Legacy', url: 'https://www.curseforge.com/projects/1235372', use: 'Added when a pack moves to Cleanroom: the Scala libraries Forge bundled.' },
			{ name: 'spark', url: 'https://spark.lucko.me', use: "Profiling from the server's overview, and its viewer." },
			{ name: 'Chunky', url: 'https://github.com/pop4959/Chunky', use: 'Pre-generating worlds from the World tab.' },
			{ name: 'Simple Voice Chat', url: 'https://modrinth.com/plugin/simple-voice-chat', use: 'Its port is kept free and tunnelled with the server.' }
		]
	},
	{
		title: 'Services',
		intro: 'Asked by MineShell over the internet.',
		items: [
			{ name: 'Modrinth', url: 'https://modrinth.com', use: 'Mod and pack search, downloads, updates and which mods are client-only.' },
			{ name: 'CurseForge', url: 'https://www.curseforge.com', use: 'Mods and packs, and the files on its CDN.' },
			{ name: 'Feed The Beast (modpacks.ch)', url: 'https://feed-the-beast.com', use: 'FTB packs, and CurseForge mods and packs without an API key.' },
			{ name: 'Mojang', url: 'https://www.minecraft.net', use: 'Game versions, server jars, the Java each version needs, player names and skins.' },
			{ name: 'Adoptium and Azul', url: 'https://adoptium.net', use: 'Lists of their Java builds.' },
			{ name: 'Fabric and Quilt meta', url: 'https://meta.fabricmc.net', use: 'Loader versions per Minecraft version.' },
			{ name: 'mclo.gs', url: 'https://mclo.gs', use: 'Sharing and analysing logs.' },
			{ name: "spark's bytebin", url: 'https://spark.lucko.me', use: 'Uploading profiles spark could not upload itself.' },
			{ name: 'playit.gg', url: 'https://playit.gg', use: 'Tunnels for public access.' },
			{ name: 'GitHub', url: 'https://github.com', use: 'MineShell updates and BlueMap downloads.' }
		]
	},
	{
		title: 'Thanks',
		intro: 'Work MineShell builds on.',
		items: [
			{ name: "Aikar's flags", url: 'https://mcflags.emc.gs', use: 'The recommended JVM preset.' },
			{ name: 'Prism Launcher', url: 'https://prismlauncher.org', use: 'The instance format client exports follow.' }
		]
	}
];

export const MINECRAFT_DISCLAIMER = 'Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.';
