/** Add a matching [data-theme='...'] block to src/app.css and list it here. */
export const THEMES = [
	{ id: 'deep-slate', label: 'Deep Slate', note: 'Dark slate with mossy green. The default.' },
	{ id: 'midnight', label: 'Midnight', note: 'Darker background, higher contrast text.' },
	{ id: 'daylight', label: 'Daylight', note: 'Light theme for bright rooms.' }
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];
export const THEME_STORAGE_KEY = 'mineshell:theme';
