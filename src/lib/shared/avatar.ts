/** A stable colour per player name, from the theme's palette, for the square standing in for a face. */
const TONES = ['var(--accent)', 'var(--info)', 'var(--warning)', 'var(--error)', 'var(--text-muted)'];

export function avatarTone(name: string): string {
	let hash = 0;
	for (const char of name.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) | 0;
	return TONES[Math.abs(hash) % TONES.length];
}
