import { describe, expect, it } from 'vitest';
import { formatModList, type ModListEntry } from './modlist';

const jei: ModListEntry = {
	name: 'Just Enough Items',
	version: '15.2.0.27',
	authors: ['mezz'],
	url: 'https://www.curseforge.com/minecraft/mc-mods/jei',
	file: 'jei-1.20.1-forge-15.2.0.27.jar',
	enabled: true,
	clientOnly: false
};
const bare: ModListEntry = { name: 'handmade', version: null, authors: [], url: null, file: 'handmade.jar', enabled: true, clientOnly: false };
const all = ['version', 'authors', 'url', 'file'] as const;

describe('formatModList', () => {
	it('writes each format with every field', () => {
		expect(formatModList([jei, bare], 'markdown', [...all])).toBe(
			'- [Just Enough Items](https://www.curseforge.com/minecraft/mc-mods/jei) 15.2.0.27 by mezz (`jei-1.20.1-forge-15.2.0.27.jar`)\n- handmade (`handmade.jar`)\n'
		);
		expect(formatModList([jei, bare], 'text', [...all])).toBe(
			'Just Enough Items 15.2.0.27 by mezz [jei-1.20.1-forge-15.2.0.27.jar] (https://www.curseforge.com/minecraft/mc-mods/jei)\nhandmade [handmade.jar]\n'
		);
		expect(formatModList([jei], 'html', [...all])).toBe(
			'<ul>\n\t<li><a href="https://www.curseforge.com/minecraft/mc-mods/jei">Just Enough Items</a> 15.2.0.27 by mezz <code>jei-1.20.1-forge-15.2.0.27.jar</code></li>\n</ul>\n'
		);
		expect(formatModList([jei, bare], 'csv', [...all])).toBe(
			'Name,Version,Authors,Link,File\r\nJust Enough Items,15.2.0.27,mezz,https://www.curseforge.com/minecraft/mc-mods/jei,jei-1.20.1-forge-15.2.0.27.jar\r\nhandmade,,,,handmade.jar\r\n'
		);
		expect(JSON.parse(formatModList([bare], 'json', [...all]))).toEqual([
			{ name: 'handmade', version: null, authors: [], url: null, file: 'handmade.jar', enabled: true }
		]);
	});

	it('leaves out the fields not picked', () => {
		expect(formatModList([jei], 'markdown', [])).toBe('- Just Enough Items\n');
		expect(formatModList([jei], 'csv', ['authors'])).toBe('Name,Authors\r\nJust Enough Items,mezz\r\n');
		expect(JSON.parse(formatModList([jei], 'json', ['version']))).toEqual([{ name: 'Just Enough Items', version: '15.2.0.27', enabled: true }]);
	});

	it('keeps names from turning into markup', () => {
		const odd: ModListEntry = { ...bare, name: '[Odd] <b>"mod"</b>, & co', authors: ['A', 'B'] };
		expect(formatModList([odd], 'markdown', ['authors'])).toBe('- \\[Odd\\] \\<b\\>"mod"\\</b\\>, & co by A, B\n');
		expect(formatModList([odd], 'html', [])).toBe('<ul>\n\t<li>[Odd] &lt;b&gt;&quot;mod&quot;&lt;/b&gt;, &amp; co</li>\n</ul>\n');
		expect(formatModList([odd], 'csv', ['authors'])).toBe('Name,Authors\r\n"[Odd] <b>""mod""</b>, & co","A, B"\r\n');
	});
});
