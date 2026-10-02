import { describe, expect, it } from 'vitest';
import { parsePlayerList } from './rcon';

describe('parsePlayerList', () => {
	it('reads the 1.13+ format', () => {
		expect(parsePlayerList('There are 2 of a max of 20 players online: Alice, Bob')).toEqual({
			online: 2,
			max: 20,
			names: ['Alice', 'Bob']
		});
		expect(parsePlayerList('There are 0 of a max of 10 players online:')).toEqual({ online: 0, max: 10, names: [] });
	});

	it('reads the 1.12-and-older format', () => {
		// "commands.players.list" before 1.13: "There are %s/%s players online:"
		expect(parsePlayerList('There are 1/20 players online:\nAlice')).toEqual({ online: 1, max: 20, names: ['Alice'] });
		expect(parsePlayerList('There are 0/20 players online:')).toEqual({ online: 0, max: 20, names: [] });
	});
});
