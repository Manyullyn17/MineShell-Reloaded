/**
 * Draws item icons in the browser from what the server resolved
 * (lib/server/itemicons.ts): flat items as their layers, blocks as the
 * inventory shows them - turned by the model's own GUI rotation (30 degrees
 * down, 225 around for most blocks, 135 for stairs), the faces that then
 * point at the viewer drawn back to front and shaded like the game. Textures
 * come from the server's own jars through the texture endpoint.
 */

export type FaceSpec = { texture: string; uv: [number, number, number, number]; tint: string | null };
type Side = 'up' | 'north' | 'south' | 'east' | 'west';
export type ElementSpec = {
	from: [number, number, number];
	to: [number, number, number];
	faces: Partial<Record<Side, FaceSpec>>;
};
export type IconSpec =
	| { kind: 'flat'; layers: { texture: string; tint: string | null }[] }
	| { kind: 'block'; elements: ElementSpec[]; rotation: [number, number, number] };
export type ItemIcon = { spec: IconSpec | null; exact: boolean };

export const iconKey = (id: string, damage: number | null) => (damage ? `${id}@${damage}` : id);

const SIZE = 64;

function loadImage(url: string): Promise<HTMLImageElement | null> {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => resolve(null);
		img.src = url;
	});
}

/**
 * One texture's first frame (animated ones are a vertical strip), tinted:
 * multiplied by the colour, keeping the texture's own transparency.
 */
function prepared(img: HTMLImageElement, tint: string | null): HTMLCanvasElement {
	const size = img.width;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(img, 0, 0, size, size, 0, 0, size, size);
	if (tint) {
		ctx.globalCompositeOperation = 'multiply';
		ctx.fillStyle = tint;
		ctx.fillRect(0, 0, size, size);
		ctx.globalCompositeOperation = 'destination-in';
		ctx.drawImage(img, 0, 0, size, size, 0, 0, size, size);
	}
	return canvas;
}

type Point = { x: number; y: number; depth: number };
type View = { yaw: number; pitch: number };

/**
 * Room around the picture, as a slot leaves it in the game: a flat item
 * fills 7/8 of the icon, a full block about 4/5 of its width.
 */
const FLAT_INSET = SIZE / 16;
const SCALE = (SIZE * 0.8) / (16 * Math.SQRT2);

/**
 * The game's y rotation is a quarter turn off this projection's: a block's
 * 225 shows its north face (a furnace's front) on the left, stairs' 135 put
 * their tall half at the back right - as the inventory does.
 */
const viewOf = (rotation: [number, number, number]): View => ({ yaw: ((rotation[1] - 90) * Math.PI) / 180, pitch: (rotation[0] * Math.PI) / 180 });

function turn(view: View, x: number, y: number, z: number): [number, number, number] {
	const x1 = x * Math.cos(view.yaw) + z * Math.sin(view.yaw);
	const z1 = -x * Math.sin(view.yaw) + z * Math.cos(view.yaw);
	return [x1, y * Math.cos(view.pitch) - z1 * Math.sin(view.pitch), y * Math.sin(view.pitch) + z1 * Math.cos(view.pitch)];
}

function project(view: View, x: number, y: number, z: number): Point {
	const [x2, y2, z2] = turn(view, x - 8, y - 8, z - 8);
	return { x: SIZE / 2 + x2 * SCALE, y: SIZE / 2 - y2 * SCALE, depth: z2 };
}

const NORMAL: Record<Side, [number, number, number]> = {
	up: [0, 1, 0],
	north: [0, 0, -1],
	south: [0, 0, 1],
	east: [1, 0, 0],
	west: [-1, 0, 0]
};

/** A face's corners: top-left, top-right, bottom-left of its texture, in model space. */
function corners(side: Side, f: number[], t: number[]): [number, number, number][] {
	switch (side) {
		case 'up':
			return [[f[0], t[1], f[2]], [t[0], t[1], f[2]], [f[0], t[1], t[2]]];
		case 'north':
			return [[t[0], t[1], f[2]], [f[0], t[1], f[2]], [t[0], f[1], f[2]]];
		case 'south':
			return [[f[0], t[1], t[2]], [t[0], t[1], t[2]], [f[0], f[1], t[2]]];
		case 'west':
			return [[f[0], t[1], f[2]], [f[0], t[1], t[2]], [f[0], f[1], f[2]]];
		case 'east':
			return [[t[0], t[1], t[2]], [t[0], t[1], f[2]], [t[0], f[1], t[2]]];
	}
}

/** Lit like the inventory: the top brightest, the side facing left lighter than the one facing right. */
function shadeOf(view: View, side: Side): number {
	if (side === 'up') return 1;
	const [x] = turn(view, ...NORMAL[side]);
	return x < 0 ? 0.8 : 0.62;
}

function drawFace(ctx: CanvasRenderingContext2D, view: View, tex: HTMLCanvasElement, face: FaceSpec, side: Side, el: ElementSpec) {
	const [a, b, c] = corners(side, el.from, el.to).map(([x, y, z]) => project(view, x, y, z));
	const unit = tex.width / 16;
	// A mirrored uv is drawn unmirrored: rare, and hardly visible at this size.
	const [u1, u2] = face.uv[0] <= face.uv[2] ? [face.uv[0], face.uv[2]] : [face.uv[2], face.uv[0]];
	const [v1, v2] = face.uv[1] <= face.uv[3] ? [face.uv[1], face.uv[3]] : [face.uv[3], face.uv[1]];
	const sw = Math.max(1, (u2 - u1) * unit);
	const sh = Math.max(1, (v2 - v1) * unit);
	const d = { x: b.x + (c.x - a.x), y: b.y + (c.y - a.y) };
	ctx.save();
	ctx.beginPath();
	ctx.moveTo(a.x, a.y);
	ctx.lineTo(b.x, b.y);
	ctx.lineTo(d.x, d.y);
	ctx.lineTo(c.x, c.y);
	ctx.closePath();
	ctx.clip();
	ctx.setTransform(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y, a.x, a.y);
	// A hair larger than the face, so neighbouring faces meet without seams.
	ctx.drawImage(tex, u1 * unit, v1 * unit, sw, sh, -0.01, -0.01, 1.02, 1.02);
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	const shade = shadeOf(view, side);
	if (shade < 1) {
		ctx.globalCompositeOperation = 'source-atop';
		ctx.fillStyle = `rgba(0, 0, 0, ${1 - shade})`;
		ctx.fill();
		ctx.globalCompositeOperation = 'source-over';
	}
	ctx.restore();
}

/** Draws one icon; null when a texture it needs is missing. */
export async function renderIcon(spec: IconSpec, textureUrl: (ref: string) => string): Promise<string | null> {
	const refs = new Set<string>();
	if (spec.kind === 'flat') spec.layers.forEach((l) => refs.add(l.texture));
	else spec.elements.forEach((e) => Object.values(e.faces).forEach((f) => f && refs.add(f.texture)));
	const images = new Map(await Promise.all([...refs].map(async (r) => [r, await loadImage(textureUrl(r))] as const)));
	if ([...images.values()].every((i) => !i)) return null;

	const canvas = document.createElement('canvas');
	canvas.width = SIZE;
	canvas.height = SIZE;
	const ctx = canvas.getContext('2d')!;
	ctx.imageSmoothingEnabled = false;
	if (spec.kind === 'flat') {
		for (const layer of spec.layers) {
			const img = images.get(layer.texture);
			if (img) ctx.drawImage(prepared(img, layer.tint), FLAT_INSET, FLAT_INSET, SIZE - 2 * FLAT_INSET, SIZE - 2 * FLAT_INSET);
		}
	} else {
		const view = viewOf(spec.rotation);
		// The faces that point at the viewer, far ones first so near ones cover them.
		const faces: { el: ElementSpec; side: Side; depth: number }[] = [];
		for (const el of spec.elements) {
			for (const side of Object.keys(el.faces) as Side[]) {
				if (turn(view, ...NORMAL[side])[2] <= 0.001) continue;
				const [a, b, c] = corners(side, el.from, el.to);
				const mid = [0, 1, 2].map((i) => (b[i] + c[i]) / 2) as [number, number, number];
				faces.push({ el, side, depth: project(view, ...mid).depth });
			}
		}
		for (const { el, side } of faces.sort((p, q) => p.depth - q.depth)) {
			const face = el.faces[side]!;
			const img = images.get(face.texture);
			if (img) drawFace(ctx, view, prepared(img, face.tint), face, side, el);
		}
	}
	return canvas.toDataURL('image/png');
}

/**
 * Icons for one server, fetched in batches: every icon asked for in the same
 * tick goes in one request, and each is drawn once.
 */
export function iconLoader(instanceId: string) {
	const base = `/api/instances/${encodeURIComponent(instanceId)}/item-icons`;
	const textureUrl = (ref: string) => `${base}/texture?ref=${encodeURIComponent(ref)}`;
	const drawn = new Map<string, Promise<{ url: string | null; exact: boolean }>>();
	let pending: { id: string; damage: number | null; resolve: (icon: ItemIcon | null) => void }[] = [];
	let vanilla = $state.raw<boolean | null>(null);
	let version = $state(0);

	function flush() {
		const batch = pending;
		pending = [];
		fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: batch.map(({ id, damage }) => ({ id, damage })) }) })
			.then((r) => (r.ok ? r.json() : null))
			.then((body: { icons: Record<string, ItemIcon>; vanilla: boolean } | null) => {
				if (body) vanilla = body.vanilla;
				for (const item of batch) item.resolve(body?.icons[iconKey(item.id, item.damage)] ?? null);
			})
			.catch(() => batch.forEach((item) => item.resolve(null)));
	}

	return {
		/** Minecraft's own textures are there; null until the first answer. */
		get vanilla() {
			return vanilla;
		},
		icon(id: string, damage: number | null): Promise<{ url: string | null; exact: boolean }> {
			const key = iconKey(id, damage);
			let hit = drawn.get(key);
			if (!hit) {
				hit = new Promise<ItemIcon | null>((resolve) => {
					if (!pending.length) queueMicrotask(flush);
					pending.push({ id, damage, resolve });
				}).then(async (icon) => ({
					url: icon?.spec ? await renderIcon(icon.spec, textureUrl).catch(() => null) : null,
					exact: icon?.exact ?? true
				}));
				drawn.set(key, hit);
			}
			return hit;
		},
		/** Bumped by reset(): icons drawn before it are asked for again. */
		get version() {
			return version;
		},
		/** After the EULA answer, vanilla textures arrive: draw again. */
		reset() {
			drawn.clear();
			version++;
		}
	};
}
