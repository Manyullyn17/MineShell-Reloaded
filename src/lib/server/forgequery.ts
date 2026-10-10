import type { ServerInstance } from './db/schema';
import { InstanceError, start, stop } from './instances';
import { compareVersions } from './java';
import { readJournalEvents, readMessageAt } from './journal';
import { snapshotPrompt } from './snapshots';
import { unitState } from './systemd';
import { snapshotNow } from './world';

/**
 * Forge 1.12 and older (and Cleanroom) stop loading a world to ask on the
 * console: blocks or items no installed mod provides any more, whole missing
 * registries, or a broken level.dat whose backup it would use. The answer is
 * read only from the console's own input ("/fml confirm" from stdin, which a
 * unit does not have); RCON is not listening yet at that point. So the
 * server waits forever, and the way through is starting it again with
 * -Dfml.queryResult=confirm, which Forge takes as the answer to whatever it
 * asks. MineShell passes that for one start only (writeOnceArgs): set for
 * good, a mod gone missing by mistake would later delete its blocks without
 * anyone being asked. Read from Forge 1.12.2-14.23.5.2860 and Cleanroom
 * 0.5.17 (FMLServerHandler.queryUser, StartupQuery, GameData, FMLCommonHandler);
 * the "world was saved with mod X which appears to be missing" lines are only
 * logged there, not asked.
 */

export type ForgeQuestionKind = 'missing-entries' | 'missing-registries' | 'backup-level-dat' | 'other';

export type ForgeQuestion = {
	kind: ForgeQuestionKind;
	/** When Forge asked (journal time, ms). */
	askedAt: number;
	/** Forge's own words, without its "Run the command" lines. */
	text: string;
	/** What is missing: per registry ("minecraft:blocks") for entries, one group for registries. */
	groups: { name: string; entries: string[] }[];
};

/** Forge's answer-or-wait loop exists in Forge before 1.13 and in Cleanroom. */
export function asksAtStartup(instance: Pick<ServerInstance, 'modloader' | 'minecraftVersion'>): boolean {
	if (instance.modloader === 'cleanroom') return true;
	return instance.modloader === 'forge' && compareVersions(instance.minecraftVersion, '1.13') < 0;
}

/** The question's last lines: "Run the command /fml confirm or or /fml cancel to proceed." (sic) */
const PROMPT = /\/fml confirm\b/;
const DONE = /\]: Done \(/;
const LOG_PREFIX = /^\[[^\]]*\] \[[^\]]*\](?: \[[^\]]*\])?: /;

/**
 * The question from the lines of the message that asked it (one journal
 * timestamp; other threads' lines in the same millisecond come before its
 * prefixed first line). Null when there is no prompt among them.
 */
export function parseForgeQuestion(lines: string[], askedAt: number): ForgeQuestion | null {
	let prompt = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (PROMPT.test(lines[i])) {
			prompt = i;
			break;
		}
	}
	if (prompt < 0) return null;
	let first = 0;
	for (let i = prompt - 1; i >= 0; i--) {
		if (LOG_PREFIX.test(lines[i])) {
			first = i;
			break;
		}
	}
	const body = lines.slice(first, prompt).map((line, i) => (i === 0 ? line.replace(LOG_PREFIX, '') : line).trimEnd());
	while (body.length && !body[body.length - 1].trim()) body.pop();
	const head = body[0] ?? '';
	const kind: ForgeQuestionKind = /detected missing registry entries/.test(head)
		? 'missing-entries'
		: /detected missing\/unknown registr/.test(head)
			? 'missing-registries'
			: /backup level\.dat is being used/.test(head)
				? 'backup-level-dat'
				: 'other';

	const groups: ForgeQuestion['groups'] = [];
	if (kind === 'missing-entries') {
		// "Missing minecraft:blocks:" then the ids, indented.
		for (const line of body) {
			const header = line.match(/^Missing (\S+):$/);
			if (header) groups.push({ name: header[1], entries: [] });
			else if (groups.length && /^\s+\S/.test(line)) groups[groups.length - 1].entries.push(line.trim());
		}
	} else if (kind === 'missing-registries') {
		// "Missing Registries:" then one registry name per line.
		const at = body.findIndex((line) => /^Missing Registries:$/.test(line.trim()));
		if (at >= 0) groups.push({ name: 'registries', entries: body.slice(at + 1).map((l) => l.trim()).filter(Boolean) });
	}
	return { kind, askedAt, text: body.join('\n'), groups: groups.filter((g) => g.entries.length) };
}

/**
 * Per server, the run being watched: how far its journal was searched (by
 * cursor, so a poll reads only what is new), whether it got past starting,
 * and the question once asked. A waiting server cannot get past it, so a
 * question found stays until the run changes.
 */
type Watch = { startedAt: number; cursor: string | null; done: boolean; question: ForgeQuestion | null };
const watches = new Map<string, Watch>();

/**
 * The question the running server waits on, or null. `startedAt` is the
 * run's start (ActiveEnterTimestamp); a new run starts a new watch.
 */
export async function pendingForgeQuestion(
	instance: Pick<ServerInstance, 'id' | 'createdAt' | 'modloader' | 'minecraftVersion'>,
	startedAt: number
): Promise<ForgeQuestion | null> {
	if (!asksAtStartup(instance) || !startedAt) return null;
	let watch = watches.get(instance.id);
	if (!watch || watch.startedAt !== startedAt) {
		watch = { startedAt, cursor: null, done: false, question: null };
		watches.set(instance.id, watch);
	}
	if (watch.done || watch.question) return watch.question;
	const { events, cursor } = await readJournalEvents(instance.id, '/fml confirm|\\]: Done \\(', {
		afterCursor: watch.cursor,
		since: Math.max(instance.createdAt, startedAt)
	});
	watch.cursor = cursor;
	let askedAt: number | null = null;
	for (const event of events) {
		if (DONE.test(event.message)) watch.done = true;
		else if (PROMPT.test(event.message)) askedAt = event.at;
	}
	if (watch.done || askedAt === null) return null;
	watch.question = parseForgeQuestion(await readMessageAt(instance.id, askedAt), askedAt);
	return watch.question;
}

/** For tests: forget what was watched. */
export function forgetForgeWatches(): void {
	watches.clear();
}

const CONFIRM_ARG = '-Dfml.queryResult=confirm';

function snapshotLabel(question: ForgeQuestion): string {
	const count = question.groups.reduce((n, g) => n + g.entries.length, 0);
	if (question.kind === 'missing-entries') return `Before Forge removed ${count} missing block, item or other entr${count === 1 ? 'y' : 'ies'}`;
	if (question.kind === 'missing-registries') return `Before Forge removed ${count} missing registr${count === 1 ? 'y' : 'ies'}`;
	if (question.kind === 'backup-level-dat') return 'Before starting from the backup level.dat';
	return "Before answering Forge's startup question";
}

/**
 * Answers the question the server waits on. Cancel stops it. Confirm stops it
 * (the world is not loaded yet, so nothing is lost), snapshots the world when
 * asked to, and starts it once with -Dfml.queryResult=confirm. Returns the
 * message to show and, with a snapshot (the work then runs as a task), its id.
 */
export async function answerForgeQuestion(
	instance: ServerInstance,
	answer: 'confirm' | 'cancel',
	opts: { snapshot: boolean }
): Promise<{ message: string; taskId: string | null }> {
	const state = await unitState(instance.id, { fresh: true });
	const running = state.active === 'active' || state.active === 'activating';
	const question = running ? await pendingForgeQuestion(instance, state.activeEnterTimestamp) : null;
	if (!question) throw new InstanceError('The server is not waiting for an answer any more.');

	if (answer === 'cancel') {
		const stopped = await stop(instance, { graceful: false });
		if (!stopped.ok) throw new InstanceError(stopped.message);
		return { message: 'Stopped without changing the world. Put back what is missing, then start it again.', taskId: null };
	}

	if (opts.snapshot) {
		// Before stopping: a refusal should leave the server as it was.
		const prompt = await snapshotPrompt(instance);
		if (prompt.lowSpace) {
			throw new InstanceError(
				'There is not enough free disk space for a snapshot of this world. Untick the snapshot to go on without one, or free some space first.'
			);
		}
	}
	const stopped = await stop(instance, { graceful: false });
	if (!stopped.ok) throw new InstanceError(stopped.message);
	watches.delete(instance.id);
	const startOnce = async () => {
		const started = await start(instance, { onceJvmArgs: [CONFIRM_ARG] });
		if (!started.ok) throw new InstanceError(started.message);
	};
	if (!opts.snapshot) {
		await startOnce();
		return { message: 'Starting with the answer given.', taskId: null };
	}
	const taskId = await snapshotNow(instance, {
		input: { reason: 'forge-confirm', label: snapshotLabel(question) },
		label: `Snapshot and start ${instance.name}`,
		then: async (task) => {
			task.setProgress(null, 'Starting the server');
			await startOnce();
		}
	});
	return { message: 'Snapshotting the world, then starting with the answer given. Follow it in Tasks.', taskId };
}
