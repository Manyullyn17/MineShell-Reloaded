import { describe, expect, it } from 'vitest';

const { leaderboard } = await import('#lib/server/playerstats.js');
const { createInstance } = await import('../helpers/instances');

const KEPT = '0310ade9-590d-4dde-a6b1-3f913f2a2924';
const DROPPED = 'a40b2ef3-c074-4fb0-8103-7c357eda2e63';
const stats = (ticks: number) => JSON.stringify({ stats: { 'minecraft:custom': { 'minecraft:play_time': ticks } }, DataVersion: 4671 });

describe('the leaderboard', () => {
	it('ranks only the players the player list shows, not a stats file whose player file was deleted', async () => {
		const s = await createInstance(
			{ modloader: 'vanilla', minecraftVersion: '1.21.11' },
			{
				'server.properties': 'level-name=world\n',
				[`world/stats/${KEPT}.json`]: stats(72000),
				[`world/stats/${DROPPED}.json`]: stats(140)
			}
		);
		const board = await leaderboard(s, new Set([KEPT]));
		expect(board.players.map((p) => p.uuid)).toEqual([KEPT]);
		expect(board.players[0].values['minecraft:play_time']).toBe(72000);
	});
});
