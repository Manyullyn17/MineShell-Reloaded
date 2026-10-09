/**
 * What stands in for a server without an icon: up to two initials on a colour
 * made from its name, so servers stay apart in the sidebar.
 */

const SMALL_WORDS = new Set(['the', 'of', 'and', 'a', 'an']);

/** "All the Mods 10" -> AM, "slimes-adventure" -> SA, "MeatballCraft" -> MC, "irithyll" -> I. */
export function serverInitials(name: string): string {
	const words = name
		.split(/[\s\-_.:]+/)
		.map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
		.filter(Boolean);
	const meaningful = words.filter((w) => !SMALL_WORDS.has(w.toLowerCase()));
	const picked = meaningful.length ? meaningful : words;
	if (picked.length >= 2) return (picked[0][0] + picked[1][0]).toUpperCase();
	const word = picked[0] ?? '';
	// One word: its capitals, as in MeatballCraft.
	const capitals = word.match(/\p{Lu}/gu) ?? [];
	if (capitals.length >= 2 && word[0] === capitals[0]) return capitals.slice(0, 2).join('');
	return (word[0] ?? '?').toUpperCase();
}

/** A hue (0-359) from the name, the same every time. */
export function serverHue(name: string): number {
	let hash = 2166136261;
	for (const char of name.toLowerCase()) {
		hash ^= char.codePointAt(0)!;
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) % 360;
}
