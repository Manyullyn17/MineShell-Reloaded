/**
 * Console lines as they come out of the journal, sorted for the console view:
 * the log level, whether a line belongs to the stack trace above it, and
 * players joining or leaving. Formats seen in the wild:
 *
 *   [16:02:15] [Server thread/ERROR] [FML]: Cannot Hotload Dim: -11        Forge 1.12
 *   \x1b[32m[15:28:14.972] [main/INFO] [Launcher/MODLAUNCHER]: ...          Forge/NeoForge, coloured
 *   [20:01:22] [Server thread/INFO]: Done (10.598s)!                       vanilla, Fabric
 *   \tat net.minecraftforge.common.DimensionManager.getProviderType(...)   a trace, under the error
 *   java.lang.IllegalArgumentException: Could not get provider type ...    its exception line
 */

export type Level = 'error' | 'warn' | 'info' | 'debug';
export type PlayerEvent = 'join' | 'leave';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Forge and NeoForge colour their console; the escape codes showed as "[32m". */
export function stripAnsi(text: string): string {
	return text.replace(ANSI, '');
}

const LEVELS: Record<string, Level> = {
	FATAL: 'error',
	ERROR: 'error',
	SEVERE: 'error',
	WARN: 'warn',
	WARNING: 'warn',
	INFO: 'info',
	DEBUG: 'debug',
	TRACE: 'debug'
};

/** "[thread/LEVEL]" (log4j as Minecraft sets it up), or "[12:00:00 LEVEL]" (Bukkit-style). */
export function levelOf(text: string): Level | null {
	const m =
		text.match(/^\[[^\]]*\] \[[^\]]*\/(FATAL|ERROR|SEVERE|WARN|WARNING|INFO|DEBUG|TRACE)\]/) ??
		text.match(/^\[\d\d:\d\d:\d\d(?:\.\d+)? (FATAL|ERROR|SEVERE|WARN|WARNING|INFO|DEBUG|TRACE)\]/);
	return m ? LEVELS[m[1]] : null;
}

const TRACE_LINE = /^\s+(at |\.\.\. \d+ more|Suppressed: )|^Caused by: /;
const EXCEPTION_LINE = /^[\w$.]+(Exception|Error|Throwable)(: |$)/;

/**
 * Whether a line continues the entry before it: a stack frame anywhere, and an
 * exception's own line ("java.lang.Foo: message") right after an error or
 * warning, which is where loggers print the throwable they were given.
 */
export function continuesPrevious(text: string, previous: { level: Level | null } | undefined): boolean {
	if (!previous) return false;
	if (TRACE_LINE.test(text)) return true;
	return EXCEPTION_LINE.test(text) && (previous.level === 'error' || previous.level === 'warn');
}

const JOIN = /\]: ([.*]?\w{1,16}) joined the game$/;
const LEAVE = /\]: ([.*]?\w{1,16}) (?:left the game|lost connection: .*)$/;

/** A player name, then what happened; 1.12 adds "[/ip:port] logged in with entity id" first. */
export function playerEventOf(text: string): PlayerEvent | null {
	return playerEventWithName(text)?.event ?? null;
}

/**
 * The same, with who. Chat cannot fake it: a chat line is "<name> text", and
 * "[Server] x joined the game" from /say has a space inside the bracket.
 */
export function playerEventWithName(text: string): { event: PlayerEvent; name: string } | null {
	const line = stripAnsi(text).trimEnd();
	const join = line.match(JOIN);
	if (join) return { event: 'join', name: join[1] };
	const leave = line.match(LEAVE);
	return leave ? { event: 'leave', name: leave[1] } : null;
}

/**
 * Chat: a player's ("<Steve> hi"; 1.19+ marks unsigned messages "[Not Secure] <Steve> hi"),
 * /me ("* Steve waves") and broadcasts with say ("[Server] hi" from the console, "[Rcon] hi"
 * from MineShell, "[@] hi" from a command block), right after the "[time] [thread/LEVEL]"
 * prefix (and Forge's logger tag), so text inside a message cannot fake it.
 * "[Rcon: Banned Notch]" (an admin broadcast) is not chat.
 */
const CHAT = /^\[[^\]]*\] \[[^\]]*\](?: \[[^\]]*\])?: (?:\[Not Secure\] )?(?:<[^>]{1,48}> |\* [.*]?\w{1,16} |\[(?:Server|Rcon|@)\] )/;

export function isChat(text: string): boolean {
	return CHAT.test(stripAnsi(text));
}

/** systemd's own lines about the unit ("Started mstest@x.service - ...", "x.service: Consumed 2min CPU time"). */
const SYSTEMD_LINE = /^(Started|Starting|Stopped|Stopping) \S+\.service\b|^\S+\.service: /;

/**
 * A line of a message logged over several lines: Fabric's mod list, a banner.
 * Only the first line has the "[time] [thread/LEVEL]" prefix.
 */
function continuesMessage(text: string): boolean {
	return !text.startsWith('[') && !SYSTEMD_LINE.test(text);
}

/**
 * The server logging each RCON connection open and close: two lines per
 * command, and MineShell sends several a minute (player list, TPS, the
 * scheduler), so they bury everything else. Forge and NeoForge add the
 * logger's name ("[minecraft/RconClient]") before the colon.
 */
export function isRconConnection(text: string): boolean {
	return /^(?:\[[^\]]*\] )?\[RCON (Listener|Client)[^\]]*\](?: \[[^\]]*\])?: Thread RCON Client \S+ (started|shutting down)$/.test(text.trimEnd());
}

export type ConsoleTone = 'error' | 'warn' | 'rcon' | 'meta' | 'player' | 'chat' | '';

export function toneOf(text: string, level: Level | null, player: PlayerEvent | null): ConsoleTone {
	if (player) return 'player';
	if (level !== 'error' && level !== 'warn' && isChat(text)) return 'chat';
	if (level === 'error') return 'error';
	if (level === 'warn') return 'warn';
	if (text.startsWith('[rcon]')) return 'rcon';
	if (text.startsWith('[mineshell]') || text.startsWith('[journal]') || SYSTEMD_LINE.test(text)) return 'meta';
	return '';
}

export type ConsoleEntry = {
	id: number;
	text: string;
	level: Level | null;
	tone: ConsoleTone;
	player: PlayerEvent | null;
	/** One of the server's lines about an RCON connection opening or closing. */
	rconConnection: boolean;
	chat: boolean;
	/** Stack trace lines folded under this one. */
	trace: string[];
};

/** A trace longer than this keeps its first lines; the rest is rarely read in a browser. */
export const MAX_TRACE_LINES = 400;

/**
 * Appends one raw journal line to `entries`, folding it into the previous
 * entry when it continues a stack trace. Returns the new entry, or null when
 * the line was folded.
 */
export function appendLine(entries: ConsoleEntry[], raw: string, id: number): ConsoleEntry | null {
	const text = stripAnsi(raw);
	const previous = entries[entries.length - 1];
	if (continuesPrevious(text, previous)) {
		if (previous.trace.length < MAX_TRACE_LINES) previous.trace.push(text);
		return null;
	}
	// A bare exception line is a throwable printed on its own (printStackTrace): an error.
	const level =
		levelOf(text) ??
		(EXCEPTION_LINE.test(text) ? 'error' : previous && continuesMessage(text) ? previous.level : null);
	const player = playerEventOf(text);
	const tone = toneOf(text, level, player);
	const entry: ConsoleEntry = { id, text, level, tone, player, rconConnection: isRconConnection(text), chat: tone === 'chat', trace: [] };
	entries.push(entry);
	return entry;
}

export type ConsoleFilter = { levels: Set<Level>; playersOnly: boolean; chatOnly?: boolean; search: string; rconConnections: boolean };

/**
 * Lines without a level (RCON answers, MineShell's notes, plain output) only
 * answer to the search. RCON connection lines are a kind of their own, shown
 * by their chip whatever the level chips say: they are info lines, so with
 * Info off the chip used to show nothing. "Joins & leaves" and "Chat" narrow the view to
 * those lines (either, with both on), likewise whatever the level chips say.
 */
export function matchesFilter(entry: ConsoleEntry, filter: ConsoleFilter): boolean {
	if (filter.playersOnly || filter.chatOnly) {
		if (!((filter.playersOnly && entry.player) || (filter.chatOnly && entry.chat))) return false;
	} else if (entry.rconConnection) {
		if (!filter.rconConnections) return false;
	} else if (entry.level && !filter.levels.has(entry.level)) return false;
	const query = filter.search.trim().toLowerCase();
	if (!query) return true;
	return entry.text.toLowerCase().includes(query) || entry.trace.some((line) => line.toLowerCase().includes(query));
}
