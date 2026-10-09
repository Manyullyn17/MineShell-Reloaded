/**
 * The colour Minecraft's locator bar (1.21.6+) gives a player who has none set:
 * LocatorBar does ARGB.setBrightness(ARGB.color(255, id.hashCode()), 0.9f),
 * with the UUID's hashCode, or the name's for a waypoint known by name. Ported
 * from the 26.3 client's bytecode, float arithmetic included, and checked
 * against values the game's own ARGB class printed (locatorcolor.test.ts).
 */

const f = Math.fround;

/** java.util.UUID.hashCode: the two 64-bit halves XORed, then folded to 32 bits. */
function uuidHash(uuid: string): number {
	const hex = uuid.replace(/-/g, '');
	const hilo = BigInt.asIntN(64, BigInt(`0x${hex.slice(0, 16)}`)) ^ BigInt.asIntN(64, BigInt(`0x${hex.slice(16, 32)}`));
	return Number(BigInt.asIntN(32, hilo >> 32n)) ^ Number(BigInt.asIntN(32, hilo));
}

/** java.lang.String.hashCode, over UTF-16 code units. */
function stringHash(text: string): number {
	let hash = 0;
	for (let i = 0; i < text.length; i++) hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
	return hash;
}

/** net.minecraft.util.ARGB.setBrightness: to HSB, brightness replaced, back to RGB. */
function setBrightness(rgb: number, brightness: number): number {
	const r = (rgb >> 16) & 255;
	const g = (rgb >> 8) & 255;
	const b = rgb & 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const delta = f(max - min);
	const saturation = max !== 0 ? f(delta / max) : 0;
	const v = f(brightness);
	const channel = (x: number) => Math.floor(f(f(x * 255) + 0.5));
	if (saturation === 0) {
		const grey = channel(v);
		return (grey << 16) | (grey << 8) | grey;
	}
	const rc = f(f(max - r) / delta);
	const gc = f(f(max - g) / delta);
	const bc = f(f(max - b) / delta);
	let hue = r === max ? f(bc - gc) : g === max ? f(f(2 + rc) - bc) : f(f(4 + gc) - rc);
	hue = f(hue / 6);
	if (hue < 0) hue = f(hue + 1);

	const h = f(f(hue - Math.floor(hue)) * 6);
	const fraction = f(h - Math.floor(h));
	const p = f(v * f(1 - saturation));
	const q = f(v * f(1 - f(saturation * fraction)));
	const t = f(v * f(1 - f(saturation * f(1 - fraction))));
	const [rr, gg, bb] = [
		[v, t, p],
		[q, v, p],
		[p, v, t],
		[p, q, v],
		[t, p, v],
		[v, p, q]
	][Math.trunc(h) % 6];
	return (channel(rr) << 16) | (channel(gg) << 8) | channel(bb);
}

/** "#rrggbb" for a UUID (with dashes), or for a name when the UUID is not known. */
export function locatorColor(id: string): string {
	const hash = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? uuidHash(id) : stringHash(id);
	return `#${setBrightness(hash & 0xffffff, 0.9).toString(16).padStart(6, '0')}`;
}
