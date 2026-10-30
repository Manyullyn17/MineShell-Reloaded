import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const { start } = await import('#lib/server/instances.js');
const { readProperties } = await import('#lib/server/properties.js');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { createInstance } = await import('../helpers/instances');
const { fakeProcesses } = await import('../helpers/process');
const { testPorts } = await import('../helpers/ports');

/** systemd starting whatever it is asked to. */
function fakeSystemd() {
	invalidateUnitState();
	fakeProcesses((cmd, args) => {
		if (cmd === 'systemctl' && args.includes('show')) return { stdout: 'ActiveState=inactive\nSubState=dead\nResult=success\n' };
		return {};
	});
}

describe('starting a server older than 1.14', () => {
	// The bug: MineShell wrote difficulty=normal, which 1.12 reads as Easy (and
	// writes back as difficulty=1); the game mode likewise fell back to Survival.
	it('first rewrites a difficulty and game mode given by name as the numbers it reads', async () => {
		fakeSystemd();
		const s = await createInstance(
			{ modloader: 'cleanroom', minecraftVersion: '1.12.2', eulaAccepted: true, ...testPorts() },
			{ 'eula.txt': 'eula=true\n', 'server.properties': 'difficulty=hard\ngamemode=creative\nmotd=Pack\n' }
		);
		expect((await start(s)).ok).toBe(true);
		expect((await readProperties(s.path)).values).toMatchObject({ difficulty: '3', gamemode: '1', motd: 'Pack' });
	});

	it('leaves the file alone on a newer server', async () => {
		fakeSystemd();
		const text = 'difficulty=3\ngamemode=creative\n';
		const s = await createInstance(
			{ modloader: 'vanilla', minecraftVersion: '1.20.1', eulaAccepted: true, ...testPorts() },
			{ 'eula.txt': 'eula=true\n', 'server.jar': 'jar', 'server.properties': text }
		);
		expect((await start(s)).ok).toBe(true);
		// 1.14 and newer read the number too, and write the name back themselves.
		expect(await fs.readFile(path.join(s.path, 'server.properties'), 'utf8')).toBe(text);
	});
});
