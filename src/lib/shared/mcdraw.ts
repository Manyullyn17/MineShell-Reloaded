/**
 * What the Minecraft previews draw for themselves instead of the game's textures (which MineShell
 * does not ship): a grain for buttons and the old dirt background, and a stand-in for the default
 * server icon. Drawn on a canvas in the browser, the same every time (a seeded random).
 */

function seeded(seed: number) {
	let s = seed;
	return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** A square of noise around one colour, as a data URL for a CSS background; '' without a canvas. */
export function grain([r, g, b]: [number, number, number], spread: number, seed: number, size = 16): string {
	if (typeof document === 'undefined') return '';
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d');
	if (!ctx) return '';
	const rnd = seeded(seed);
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) {
			const d = (rnd() - 0.5) * spread;
			ctx.fillStyle = `rgb(${Math.round(r + d)},${Math.round(g + d)},${Math.round(b + d)})`;
			ctx.fillRect(x, y, 1, 1);
		}
	return canvas.toDataURL();
}

/** Button face: grey with a light grain (the game's is a stone-like texture). */
export const buttonGrain = () => grain([111, 111, 111], 12, 3);
/** The menus' dirt before 1.20.5, already darkened as the game draws it (lists darker still). */
export const dirtGrain = (list: boolean) => (list ? grain([22, 16, 11], 10, 11) : grain([40, 29, 20], 16, 11));

/** A 32 px grey landscape on the canvas, where the game shows its default icon for a server without one. */
export function drawDefaultIcon(canvas: HTMLCanvasElement): void {
	canvas.width = canvas.height = 32;
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	const rnd = seeded(7);
	for (let y = 0; y < 32; y++)
		for (let x = 0; x < 32; x++) {
			const hill = 17 + Math.round(3 * Math.sin(x / 5) + 2 * Math.sin(x / 2.3 + 1));
			const ground = 23 + Math.round(Math.sin(x / 7 + 2));
			let v = y < hill ? 200 - y * 2 + rnd() * 10 : y < ground ? 120 + rnd() * 25 : 80 + rnd() * 40;
			const [tx, ty] = [x - 22, y - 13];
			if ((tx * tx) / 16 + (ty * ty) / 25 < 1) v = 70 + rnd() * 30;
			if (x === 22 && y >= 17 && y < ground) v = 55;
			const c = Math.round(v);
			ctx.fillStyle = `rgb(${c},${c},${c})`;
			ctx.fillRect(x, y, 1, 1);
		}
}
