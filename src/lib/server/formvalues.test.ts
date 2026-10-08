import { describe, expect, it } from 'vitest';
import { formInt } from './formvalues';

describe('formInt', () => {
	it('keeps the fallback for a field the form does not have, or leaves empty', () => {
		const form = new FormData();
		form.set('serverPort', '25568');
		form.set('empty', ' ');
		expect(formInt(form, 'serverPort', 25565)).toBe(25568);
		// The Game port section posts no RCON port: it used to come out as 0.
		expect(formInt(form, 'rconPort', 25575)).toBe(25575);
		expect(formInt(form, 'empty', 7)).toBe(7);
	});
});
