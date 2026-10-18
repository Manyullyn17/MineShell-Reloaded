import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rcon = vi.hoisted(() => ({ commands: [] as string[], answer: '' }));
vi.mock('#lib/server/rcon.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/rcon.js')>()),
	rconExec: vi.fn(async (_target: unknown, commands: string[]) => {
		rcon.commands.push(...commands);
		return commands.map(() => rcon.answer);
	})
}));

const names = await import('#lib/server/dimensionnames.js');
const { listDimensions } = await import('#lib/server/dimensions.js');
const { encryptSecret } = await import('#lib/server/crypto.js');
const { invalidateUnitState } = await import('#lib/server/systemd.js');
const { createInstance } = await import('../helpers/instances');
const { fakeProcesses } = await import('../helpers/process');

let active = true;
let enteredAt = 1000;
function fakeUnit() {
	invalidateUnitState();
	fakeProcesses((cmd, args) => {
		if (cmd === 'systemctl' && args.includes('show')) {
			return { stdout: `ActiveState=${active ? 'active' : 'inactive'}\nSubState=running\nActiveEnterTimestampMonotonic=${enteredAt}\n` };
		}
		return {};
	});
}

// Forge 1.12's answer (CommandDimensions: the translated header, then "<type>: <ids>" per type).
const FORGE = 'Currently registered dimensions by type:\noverworld: {0}\nthe_nether: {-1}\ndeep_dark: {-11325}\ntardis_planet: {622, 623}\n';

const CONFIGS = {
	// ExtraUtils2: the category says what the numbers are; the keys are the names.
	'config/extrautils2.cfg': '"dimension ids" {\n    I:"Deep Dark"=-11325\n    I:ExtraUtils2_Quarry_Dim=-9999\n}\n',
	// A biome id with the same number, in a file sorting first, loses to a key saying "dimension".
	'config/Journey.cfg': 'dimension {\n    I:"Cloudia biome ID"=66\n}\n',
	'config/erebus.cfg': 'general {\n    I:"Dimension ID of The Erebus"=66\n}\n',
	// One word: the mod in front. A generic file name: its folder is the mod.
	'config/dimdoors.cfg': 'general {\n    I:baseDimensionID=684\n}\n',
	'config/compactmachines3/settings.cfg': 'internal {\n    I:dimensionId=144\n}\n',
	// Numbers about something else are never dimensions.
	'config/thebetweenlands.cfg': 'world_and_dimension {\n    I:oreGenCountSyrmorite=7\n}\n'
};

async function server() {
	const files: Record<string, string> = { ...CONFIGS, 'server.properties': 'level-name=world\n' };
	for (const dim of ['DIM-1', 'DIM-11325', 'DIM-9999', 'DIM66', 'DIM684', 'DIM144', 'DIM7', 'DIM622']) files[`world/${dim}/region/r.0.0.mca`] = '';
	files['world/region/r.0.0.mca'] = '';
	return createInstance({ modloader: 'forge', minecraftVersion: '1.12.2', rconPasswordEnc: encryptSecret('pw') }, files);
}

beforeEach(() => {
	rcon.commands = [];
	rcon.answer = FORGE;
	active = true;
	fakeUnit();
});

describe('names for numbered dimensions', () => {
	it("reads Forge's list of dimension types", () => {
		expect(names.parseForgeDimensions(FORGE)).toEqual(
			new Map([
				[0, 'Overworld'],
				[-1, 'The Nether'],
				[-11325, 'Deep Dark'],
				[622, 'Tardis Planet'],
				[623, 'Tardis Planet']
			])
		);
	});

	it('guesses from configs until Forge was asked, then uses its names, asking once per run', async () => {
		const s = await server();
		active = false;
		fakeUnit();
		const labels = async () => Object.fromEntries((await names.withDimensionNames(s, await listDimensions(s.path))).map((d) => [path.basename(d.paths[0]), d.label]));
		expect(await labels()).toMatchObject({
			// The overworld's first folder is region/: it keeps its own label (it read "region").
			region: 'Overworld',
			'DIM-1': 'The Nether',
			'DIM-11325': 'DIM-11325 (Deep Dark?)',
			'DIM-9999': 'DIM-9999 (Extra Utils2 Quarry?)',
			DIM66: 'DIM66 (Erebus?)',
			DIM684: 'DIM684 (Dimdoors Base?)',
			DIM144: 'DIM144 (Compactmachines3?)',
			DIM7: 'DIM7',
			DIM622: 'DIM622'
		});
		expect(rcon.commands).toEqual([]);

		// Running: asked in the background, once for this run.
		active = true;
		fakeUnit();
		await names.askForDimensionNames(s);
		await names.askForDimensionNames(s);
		expect(rcon.commands).toEqual(['forge dimensions']);
		expect(await labels()).toMatchObject({ 'DIM-11325': 'Deep Dark (DIM-11325)', DIM622: 'Tardis Planet (DIM622)', DIM66: 'DIM66 (Erebus?)' });

		// A new run asks again.
		enteredAt += 5000;
		fakeUnit();
		await names.askForDimensionNames(s);
		expect(rcon.commands).toHaveLength(2);
	});

	it('asks nothing of servers whose folders carry their names (1.13+), or that are not Forge', async () => {
		const modern = await createInstance({ modloader: 'neoforge', minecraftVersion: '1.21.1', rconPasswordEnc: encryptSecret('pw') });
		await names.askForDimensionNames(modern);
		const fabric = await createInstance({ modloader: 'fabric', minecraftVersion: '1.12.2', rconPasswordEnc: encryptSecret('pw') });
		await names.askForDimensionNames(fabric);
		expect(rcon.commands).toEqual([]);
	});
});
