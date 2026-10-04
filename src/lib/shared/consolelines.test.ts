import { describe, expect, it } from 'vitest';
import { appendLine, isRconConnection, levelOf, matchesFilter, playerEventOf, stripAnsi, type ConsoleEntry, type Level } from './consolelines';

/** Lines recorded from real servers' journals (MeatballCraft on Cleanroom, Pixelmon on NeoForge, a Fabric 1.20.1 server). */
const FORGE_1_12_ERROR = [
	'[16:02:15] [Server thread/ERROR] [FML]: Cannot Hotload Dim: -11',
	'java.lang.IllegalArgumentException: Could not get provider type for dimension -11, does not exist',
	'\tat net.minecraftforge.common.DimensionManager.getProviderType(DimensionManager.java:164) ~[DimensionManager.class:14.23.5.2864]',
	'\tat net.minecraftforge.common.DimensionManager.initDimension(DimensionManager.java:252) ~[DimensionManager.class:14.23.5.2864]',
	'Caused by: java.lang.NullPointerException',
	'\t... 12 more',
	'[16:02:16] [Server thread/INFO] [FML]: Unloading dimension 1'
];

function feed(lines: string[]): ConsoleEntry[] {
	const entries: ConsoleEntry[] = [];
	lines.forEach((line, i) => appendLine(entries, line, i));
	return entries;
}

describe('console lines', () => {
	it('reads the level in every format seen', () => {
		expect(levelOf('[16:02:15] [Server thread/ERROR] [FML]: Cannot Hotload Dim: -11')).toBe('error');
		expect(levelOf('[20:01:22] [Server thread/INFO]: Done (10.598s)! For help, type "help"')).toBe('info');
		expect(levelOf('[15:28:14.972] [main/INFO] [Launcher/MODLAUNCHER]: ModLauncher running')).toBe('info');
		expect(levelOf('[12:05:02] [Server thread/WARN]: Can\'t keep up! Is the server overloaded?')).toBe('warn');
		expect(levelOf('[12:00:00] [main/FATAL]: boom')).toBe('error');
		expect(levelOf('[12:00:00 WARN]: Bukkit style')).toBe('warn');
		expect(levelOf('[spark-worker-pool-1-thread-1/INFO]: no timestamp')).toBeNull();
		expect(levelOf('Started minecraft@x.service - Minecraft server')).toBeNull();
	});

	it('strips the colour codes modern Forge prints', () => {
		const raw = '\x1b[32m[15:28:14.972] [main/INFO] [Launcher/MODLAUNCHER]: ModLauncher running\x1b[m';
		expect(stripAnsi(raw)).toBe('[15:28:14.972] [main/INFO] [Launcher/MODLAUNCHER]: ModLauncher running');
		expect(feed([raw])[0].level).toBe('info');
	});

	it('folds a stack trace, its exception and causes under the error', () => {
		const entries = feed(FORGE_1_12_ERROR);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ level: 'error', tone: 'error' });
		expect(entries[0].trace).toHaveLength(5);
		expect(entries[0].trace[0]).toMatch(/^java\.lang\.IllegalArgumentException/);
		expect(entries[1].level).toBe('info');
	});

	it('keeps an exception line after an info line as its own entry, with its frames under it', () => {
		const entries = feed([
			'[10:00:00] [Server thread/INFO]: Preparing spawn area',
			'java.lang.RuntimeException: printed with printStackTrace',
			'\tat com.example.Mod.init(Mod.java:10)'
		]);
		expect(entries.map((e) => [e.tone, e.trace.length])).toEqual([
			['', 0],
			['error', 1]
		]);
	});

	it("gives a multi-line message's later lines its level, but not systemd's lines", () => {
		const entries = feed([
			'[20:42:27] [main/INFO]: Loading 3 mods:',
			'\t- fabricloader 0.19.5',
			'\t   \\-- mixinextras 0.5.5',
			'mstest@sparktest.service: Consumed 1min 55.691s CPU time, 2.2G memory peak.',
			'Started mstest@sparktest.service - Minecraft server (sparktest) managed by MineShell.'
		]);
		expect(entries.map((e) => [e.level, e.tone])).toEqual([
			['info', ''],
			['info', ''],
			['info', ''],
			[null, 'meta'],
			[null, 'meta']
		]);
	});

	it('spots players joining and leaving, but not a server list ping', () => {
		expect(playerEventOf('[15:08:31] [Server thread/INFO]: Manyullyn17 joined the game')).toBe('join');
		expect(playerEventOf('[15:09:00] [Server thread/INFO]: Manyullyn17 lost connection: Disconnected')).toBe('leave');
		expect(playerEventOf('[15:09:00] [Server thread/INFO]: Alex left the game')).toBe('leave');
		expect(playerEventOf('[15:09:00] [Server thread/INFO]: .BedrockSteve joined the game')).toBe('join');
		expect(playerEventOf('[15:08:31] [Server thread/INFO]: /192.168.0.20:48290 lost connection: Disconnected')).toBeNull();
		expect(playerEventOf('[15:08:31] [Server thread/INFO]: <Alex> I joined the game')).toBeNull();
	});

	it("hides the server's lines about RCON connections unless asked", () => {
		const entries = feed([
			'[20:44:44] [RCON Listener #1/INFO]: Thread RCON Client /127.0.0.1 started',
			'[20:44:44] [RCON Client /127.0.0.1 #2/INFO]: Thread RCON Client /127.0.0.1 shutting down',
			'[20:42:35] [Server thread/INFO]: RCON running on 0.0.0.0:25575',
			'[20:29:38] [Server thread/INFO]: [Rcon: Banned Notch: griefing]'
		]);
		expect(isRconConnection(entries[0].text)).toBe(true);
		const shown = (rconConnections: boolean) =>
			entries.filter((e) => matchesFilter(e, { levels: new Set(['info'] as Level[]), search: '', playersOnly: false, rconConnections })).length;
		expect(shown(false)).toBe(2);
		expect(shown(true)).toBe(4);
	});

	it('filters by level, players and search; unlevelled lines only answer to the search', () => {
		const entries = feed([
			...FORGE_1_12_ERROR,
			'[15:08:31] [Server thread/INFO]: Manyullyn17 joined the game',
			'[rcon] There are 1 of a max of 20 players online'
		]);
		const show = (levels: Level[], search = '', playersOnly = false) =>
			entries.filter((e) => matchesFilter(e, { levels: new Set(levels), search, playersOnly, rconConnections: true })).map((e) => e.text.slice(0, 30));
		expect(show(['error'])).toEqual(['[16:02:15] [Server thread/ERRO', '[rcon] There are 1 of a max of']);
		expect(show(['error', 'warn', 'info', 'debug'], 'DimensionManager')).toEqual(['[16:02:15] [Server thread/ERRO']);
		expect(show(['error', 'warn', 'info', 'debug'], '', true)).toEqual(['[15:08:31] [Server thread/INFO']);
	});
});
