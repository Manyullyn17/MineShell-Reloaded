import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

const { answerForgeQuestion, forgetForgeWatches, pendingForgeQuestion } = await import('#lib/server/forgequery.js');
const { start } = await import('#lib/server/instances.js');
const { listSnapshots } = await import('#lib/server/snapshots.js');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { unitOnceArgsFile } = await import('#lib/server/config.js');
const { createInstance, reload, waitForTask } = await import('../helpers/instances');
const { fakeProcesses, spawnCalls } = await import('../helpers/process');

/** When Forge asked, in the journal's microseconds. */
const ASKED_US = 1_791_600_000_123_456;

/** meatballcraft-cleanroom's question (2026-10-08), as journald holds it: one timestamp for every line. */
const QUESTION = [
	'[23:25:55] [Server thread/WARN] [FML]: Forge Mod Loader detected missing registry entries.',
	'There are 2 missing entries in this save.',
	'If you continue the missing entries will get removed.',
	'A world backup will be automatically created in your saves directory.',
	'Missing minecraft:items:',
	'    contenttweaker:kami_cloth',
	'    contenttweaker:kamium_ingot',
	'Run the command /fml confirm or or /fml cancel to proceed.',
	'Alternatively start the server with -Dfml.queryResult=confirm or -Dfml.queryResult=cancel to preselect the answer.'
];

const entry = (message: string, us: number, cursor = `c-${us}`) =>
	JSON.stringify({ __CURSOR: cursor, __REALTIME_TIMESTAMP: String(us), MESSAGE: message, _SYSTEMD_INVOCATION_ID: 'a'.repeat(32) });

/**
 * A fake systemd and journal. A run is up from `systemctl start` on; while
 * `asking`, its journal ends with Forge's question, otherwise with "Done (".
 * Each start records what <id>.once held (the unit's start command reads it).
 */
let active = false;
let run = 0;
let asking = true;
let onceAtStart: (string | null)[] = [];
let instanceId = '';
function fakeSystemd() {
	invalidateUnitState();
	fakeProcesses((cmd, args) => {
		if (cmd === 'systemctl' && args.includes('start')) {
			const file = unitOnceArgsFile(instanceId);
			onceAtStart.push(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null);
			active = true;
			run++;
			invalidateUnitState();
			return {};
		}
		if (cmd === 'systemctl' && args.includes('stop')) {
			active = false;
			invalidateUnitState();
			return {};
		}
		if (cmd === 'systemctl' && args.includes('show')) {
			return {
				stdout: active
					? `ActiveState=active\nSubState=running\nResult=success\nActiveEnterTimestampMonotonic=${run * 1_000_000}\n`
					: 'ActiveState=inactive\nSubState=dead\nResult=success\n'
			};
		}
		if (cmd === 'journalctl') {
			const last = asking ? QUESTION[QUESTION.length - 1] : '[23:30:00] [Server thread/INFO] [minecraft/DedicatedServer]: Done (93.1s)! For help, type "help"';
			if (args.some((a) => a.startsWith('--until='))) return { stdout: QUESTION.map((m) => entry(m, ASKED_US)).join('\n') + '\n' };
			if (args.includes('-g')) {
				if (args.some((a) => a.startsWith('--after-cursor='))) return {};
				return { stdout: entry(asking ? QUESTION[7] : last, ASKED_US) + '\n' };
			}
			return { stdout: entry(last, ASKED_US, `newest-${run}`) + '\n' };
		}
		return {};
	});
}

/** start() checks the ports are free: ones of their own, not 25565 (which a real server here may hold). */
let port = 47900 + (process.pid % 400) * 20;
async function waitingServer() {
	port += 2;
	const s = await createInstance(
		{ modloader: 'cleanroom', minecraftVersion: '1.12.2', eulaAccepted: true, serverPort: port, rconPort: port + 1 },
		{ 'eula.txt': 'eula=true\n', 'server.properties': 'level-name=world\n', 'world/level.dat': 'level', 'world/region/r.0.0.mca': 'chunks' }
	);
	instanceId = s.id;
	await start(s);
	onceAtStart = [];
	return reload(s.id);
}

const startedAt = async (id: string) => {
	const { unitState } = await import('#lib/server/systemd.js');
	return (await unitState(id, { fresh: true })).activeEnterTimestamp;
};

beforeEach(() => {
	active = false;
	run = 0;
	asking = true;
	forgetForgeWatches();
	fakeSystemd();
});

describe('a question Forge waits on at startup', () => {
	// MeatballCraft stopped at "Run the command /fml confirm" after a pack update,
	// and nothing could answer: the unit has no console input and RCON was not up yet.
	it('is found in the running server\'s journal, read once, then only searched past it', async () => {
		const s = await waitingServer();
		const question = await pendingForgeQuestion(s, await startedAt(s.id));
		expect(question).toMatchObject({ kind: 'missing-entries', askedAt: Math.floor(ASKED_US / 1000) });
		expect(question!.groups).toEqual([{ name: 'minecraft:items', entries: ['contenttweaker:kami_cloth', 'contenttweaker:kamium_ingot'] }]);
		const at = await startedAt(s.id);
		spawnCalls.length = 0;
		expect(await pendingForgeQuestion(s, at)).toEqual(question);
		expect(spawnCalls.filter((c) => c.cmd === 'journalctl')).toEqual([]);
	});

	it('is not looked for once the run got past starting, nor on loaders that never ask', async () => {
		const s = await waitingServer();
		asking = false;
		const at = await startedAt(s.id);
		expect(await pendingForgeQuestion(s, at)).toBeNull();
		spawnCalls.length = 0;
		expect(await pendingForgeQuestion({ ...s, modloader: 'neoforge', minecraftVersion: '1.21.1' }, at)).toBeNull();
		expect(spawnCalls).toEqual([]);
	});

	it('confirmed: stops, starts once with the answer preset, and the next start goes without it', async () => {
		const s = await waitingServer();
		expect((await answerForgeQuestion(s, 'confirm', { snapshot: false })).taskId).toBeNull();
		expect(spawnCalls.some((c) => c.cmd === 'systemctl' && c.args.includes('stop'))).toBe(true);
		expect(onceAtStart).toEqual(['-Dfml.queryResult=confirm']);
		// A start the unit never ran leaves the file; the next start through MineShell clears it.
		await start(reload(s.id));
		expect(onceAtStart).toEqual(['-Dfml.queryResult=confirm', null]);
		expect(await listSnapshots(s.path)).toEqual([]);
	});

	it('confirmed with a snapshot: the world is copied first, then the server starts with the answer', async () => {
		const s = await waitingServer();
		const { taskId } = await answerForgeQuestion(s, 'confirm', { snapshot: true });
		expect((await waitForTask(taskId!)).state).toBe('done');
		const [snapshot] = await listSnapshots(s.path);
		expect(snapshot).toMatchObject({ reason: 'forge-confirm', label: 'Before Forge removed 2 missing block, item or other entries', worlds: ['world'] });
		expect(onceAtStart).toEqual(['-Dfml.queryResult=confirm']);
		expect(active).toBe(true);
	});

	it('cancelled: stops, leaving the world and the next start alone', async () => {
		const s = await waitingServer();
		await answerForgeQuestion(s, 'cancel', { snapshot: true });
		expect(active).toBe(false);
		expect(onceAtStart).toEqual([]);
		expect(await listSnapshots(s.path)).toEqual([]);
	});

	it('refuses an answer when nothing is asked', async () => {
		const s = await waitingServer();
		asking = false;
		await expect(answerForgeQuestion(s, 'confirm', { snapshot: false })).rejects.toThrow('not waiting for an answer');
		expect(onceAtStart).toEqual([]);
	});
});
