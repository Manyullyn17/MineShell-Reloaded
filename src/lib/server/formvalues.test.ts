import { describe, expect, it } from 'vitest';
import { fileVersionPairs, formInt } from './formvalues';

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

describe('fileVersionPairs', () => {
	it('reads the pairs as a browser posts them, newline as CRLF', async () => {
		const sent = new FormData();
		sent.append('change', 'sodium-0.5.0.jar\nS2');
		sent.append('change', 'broken');
		// Through a multipart body, as fetch sends a form: the newline arrives as \r\n.
		const received = await new Response(sent).formData();
		expect(String(received.get('change'))).toContain('\r\n');
		expect(fileVersionPairs(received)).toEqual([{ fileName: 'sodium-0.5.0.jar', versionId: 'S2' }]);
	});
});
