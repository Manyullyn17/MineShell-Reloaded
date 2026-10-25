/**
 * A server's mod list as text, like Prism Launcher's "Export mod list": for a
 * forum post, a pack page or a support thread. Formatted in the browser, so
 * the page shows each change of format or field at once.
 */

export type ModListEntry = {
	name: string;
	version: string | null;
	authors: string[];
	url: string | null;
	file: string;
	enabled: boolean;
	clientOnly: boolean;
};

export const MODLIST_FORMATS = [
	{ id: 'markdown', label: 'Markdown', ext: 'md', type: 'text/markdown' },
	{ id: 'text', label: 'Plain text', ext: 'txt', type: 'text/plain' },
	{ id: 'html', label: 'HTML', ext: 'html', type: 'text/html' },
	{ id: 'csv', label: 'CSV', ext: 'csv', type: 'text/csv' },
	{ id: 'json', label: 'JSON', ext: 'json', type: 'application/json' }
] as const;

export type ModListFormat = (typeof MODLIST_FORMATS)[number]['id'];

/** What goes next to each mod's name. */
export const MODLIST_FIELDS = [
	{ id: 'version', label: 'Version' },
	{ id: 'authors', label: 'Authors' },
	{ id: 'url', label: 'Link' },
	{ id: 'file', label: 'File name' }
] as const;

export type ModListField = (typeof MODLIST_FIELDS)[number]['id'];

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Brackets and the like would turn a name into Markdown of its own. */
const escapeMarkdown = (s: string) => s.replace(/([\\`*_[\]<>#|])/g, '\\$1');
const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function formatModList(entries: ModListEntry[], format: ModListFormat, fields: ModListField[]): string {
	const has = (f: ModListField) => fields.includes(f);
	const by = (m: ModListEntry) => (has('authors') && m.authors.length ? m.authors.join(', ') : null);
	const version = (m: ModListEntry) => (has('version') && m.version ? m.version : null);
	const url = (m: ModListEntry) => (has('url') ? m.url : null);
	const file = (m: ModListEntry) => (has('file') ? m.file : null);

	switch (format) {
		case 'markdown':
			return entries
				.map((m) => {
					const name = escapeMarkdown(m.name);
					let line = `- ${url(m) ? `[${name}](${url(m)!.replace(/\)/g, '%29')})` : name}`;
					if (version(m)) line += ` ${escapeMarkdown(version(m)!)}`;
					if (by(m)) line += ` by ${escapeMarkdown(by(m)!)}`;
					if (file(m)) line += ` (\`${file(m)!.replace(/`/g, '')}\`)`;
					return line;
				})
				.join('\n') + '\n';
		case 'text':
			return entries
				.map((m) => {
					let line = m.name;
					if (version(m)) line += ` ${version(m)}`;
					if (by(m)) line += ` by ${by(m)}`;
					if (file(m)) line += ` [${file(m)}]`;
					if (url(m)) line += ` (${url(m)})`;
					return line;
				})
				.join('\n') + '\n';
		case 'html': {
			const items = entries.map((m) => {
				const name = escapeHtml(m.name);
				let line = url(m) ? `<a href="${escapeHtml(url(m)!)}">${name}</a>` : name;
				if (version(m)) line += ` ${escapeHtml(version(m)!)}`;
				if (by(m)) line += ` by ${escapeHtml(by(m)!)}`;
				if (file(m)) line += ` <code>${escapeHtml(file(m)!)}</code>`;
				return `\t<li>${line}</li>`;
			});
			return `<ul>\n${items.join('\n')}\n</ul>\n`;
		}
		case 'csv': {
			const columns: { head: string; value: (m: ModListEntry) => string }[] = [{ head: 'Name', value: (m) => m.name }];
			if (has('version')) columns.push({ head: 'Version', value: (m) => m.version ?? '' });
			if (has('authors')) columns.push({ head: 'Authors', value: (m) => m.authors.join(', ') });
			if (has('url')) columns.push({ head: 'Link', value: (m) => m.url ?? '' });
			if (has('file')) columns.push({ head: 'File', value: (m) => m.file });
			const rows = [columns.map((c) => c.head), ...entries.map((m) => columns.map((c) => c.value(m)))];
			return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
		}
		case 'json':
			return (
				JSON.stringify(
					entries.map((m) => ({
						name: m.name,
						...(has('version') ? { version: m.version } : {}),
						...(has('authors') ? { authors: m.authors } : {}),
						...(has('url') ? { url: m.url } : {}),
						...(has('file') ? { file: m.file } : {}),
						enabled: m.enabled
					})),
					null,
					'\t'
				) + '\n'
			);
	}
}
