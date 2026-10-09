/**
 * Draws item icons in the browser from what the server resolved
 * (lib/server/itemicons.ts): flat items as their layers, blocks as the
 * inventory shows them - turned by the model's own GUI rotation (30 degrees
 * down, 225 around for most blocks, 135 for stairs), the faces that then
 * point at the viewer drawn back to front and shaded like the game. Textures
 * come from the server's own jars through the texture endpoint.
 */

export type FaceSpec = { texture: string; uv: [number, number, number, number]; tint: string | null };
type Side = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
export type ElementSpec = {
	from: [number, number, number];
	to: [number, number, number];
	faces: Partial<Record<Side, FaceSpec>>;
};
type Vec3 = [number, number, number];
/** A face of a model the game draws in code, placed by the server: texture top left, top right, bottom left. */
export type Quad = { corners: [Vec3, Vec3, Vec3]; normal: Vec3; face: FaceSpec; group: number };
export type IconSpec =
	| { kind: 'flat'; layers: { texture: string; tint: string | null }[] }
	/** `scale`: the size against a block's (1); `center`: the point drawn in the middle (8, 8, 8). */
	| { kind: 'block'; elements: ElementSpec[]; quads?: Quad[]; rotation: [number, number, number]; scale?: number; center?: [number, number, number] };
export type ItemIcon = { spec: IconSpec | null; exact: boolean; variant?: boolean; name?: string };
/** A drawn icon; `name` is a 1.12 variant's own name (itemicons.ts withVariantName). */
export type DrawnIcon = { url: string | null; exact: boolean; variant: boolean; name: string | null };

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
 * multiplied by the colour, keeping the texture's own transparency; and
 * shaded for the side it is on. Shading here touches only the texture's own
 * pixels: shading the face's outline on the icon darkened whatever showed
 * through its holes a second time (a shulker box's base under the lid).
 */
function prepared(img: HTMLImageElement, tint: string | null, shade = 1): HTMLCanvasElement {
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
	if (shade < 1) {
		ctx.globalCompositeOperation = 'source-atop';
		ctx.fillStyle = `rgba(0, 0, 0, ${1 - shade})`;
		ctx.fillRect(0, 0, size, size);
	}
	return canvas;
}

type Point = { x: number; y: number; depth: number };
type View = { yaw: number; pitch: number; scale: number; center: [number, number, number] };

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
const viewOf = (rotation: [number, number, number], scale = 1, center: [number, number, number] = [8, 8, 8]): View => ({
	yaw: ((rotation[1] - 90) * Math.PI) / 180,
	pitch: (rotation[0] * Math.PI) / 180,
	scale,
	center
});

function turn(view: View, x: number, y: number, z: number): [number, number, number] {
	const x1 = x * Math.cos(view.yaw) + z * Math.sin(view.yaw);
	const z1 = -x * Math.sin(view.yaw) + z * Math.cos(view.yaw);
	return [x1, y * Math.cos(view.pitch) - z1 * Math.sin(view.pitch), y * Math.sin(view.pitch) + z1 * Math.cos(view.pitch)];
}

function project(view: View, x: number, y: number, z: number): Point {
	const [x2, y2, z2] = turn(view, x - view.center[0], y - view.center[1], z - view.center[2]);
	return { x: SIZE / 2 + x2 * SCALE * view.scale, y: SIZE / 2 - y2 * SCALE * view.scale, depth: z2 };
}


const NORMAL: Record<Side, [number, number, number]> = {
	up: [0, 1, 0],
	down: [0, -1, 0],
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
		case 'down':
			return [[f[0], f[1], t[2]], [t[0], f[1], t[2]], [f[0], f[1], f[2]]];
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
function shadeOf(view: View, normal: [number, number, number]): number {
	if (normal[1] > 0.7) return 1;
	if (normal[1] < -0.7) return 0.5;
	const [x] = turn(view, ...normal);
	return x < 0 ? 0.8 : 0.62;
}

function drawFace(ctx: CanvasRenderingContext2D, view: View, tex: HTMLCanvasElement, face: FaceSpec, points: Vec3[]) {
	const [a, b, c] = points.map((p) => project(view, ...p));
	const unit = tex.width / 16;
	// A uv given backwards mirrors the texture (1.15+ chests read their sides bottom up).
	const flipU = face.uv[0] > face.uv[2];
	const flipV = face.uv[1] > face.uv[3];
	const [u1, u2] = flipU ? [face.uv[2], face.uv[0]] : [face.uv[0], face.uv[2]];
	const [v1, v2] = flipV ? [face.uv[3], face.uv[1]] : [face.uv[1], face.uv[3]];
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
	if (flipU || flipV) ctx.transform(flipU ? -1 : 1, 0, 0, flipV ? -1 : 1, flipU ? 1 : 0, flipV ? 1 : 0);
	// A hair larger than the face, so neighbouring faces meet without seams.
	ctx.drawImage(tex, u1 * unit, v1 * unit, sw, sh, -0.01, -0.01, 1.02, 1.02);
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.restore();
}

/** Draws one icon; null when a texture it needs is missing. */
export async function renderIcon(spec: IconSpec, textureUrl: (ref: string) => string): Promise<string | null> {
	const refs = new Set<string>();
	if (spec.kind === 'flat') spec.layers.forEach((l) => refs.add(l.texture));
	else {
		spec.elements.forEach((e) => Object.values(e.faces).forEach((f) => f && refs.add(f.texture)));
		spec.quads?.forEach((q) => refs.add(q.face.texture));
	}
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
		const view = viewOf(spec.rotation, spec.scale, spec.center);
		// The faces that point at the viewer, far boxes first so near ones cover them, a
		// box's own faces far first. By box, not by face: a face's middle says little about
		// a big face behind a small box (a chest's lid over its latch). The sort keeps the
		// given order for equal depths: a banner's colour over its cloth.
		const faces: { face: FaceSpec; points: Vec3[]; normal: Vec3; depth: number; group: string }[] = [];
		const centres = new Map<string, { sum: Vec3; n: number }>();
		const add = (group: string, face: FaceSpec, points: Vec3[], normal: Vec3) => {
			const centre = centres.get(group) ?? { sum: [0, 0, 0], n: 0 };
			const [a, b, c] = points;
			const fourth = [0, 1, 2].map((i) => b[i] + c[i] - a[i]) as Vec3;
			for (const p of [a, b, c, fourth]) for (const i of [0, 1, 2]) centre.sum[i] += p[i];
			centre.n += 4;
			centres.set(group, centre);
			if (turn(view, ...normal)[2] <= 0.001) return;
			const mid = [0, 1, 2].map((i) => (points[1][i] + points[2][i]) / 2) as Vec3;
			faces.push({ face, points, normal, depth: project(view, ...mid).depth, group });
		};
		spec.elements.forEach((el, i) => {
			for (const side of Object.keys(el.faces) as Side[]) add(`e${i}`, el.faces[side]!, corners(side, el.from, el.to), NORMAL[side]);
		});
		for (const quad of spec.quads ?? []) add(`q${quad.group}`, quad.face, quad.corners, quad.normal);
		const groupDepth = new Map([...centres].map(([g, c]) => [g, project(view, ...(c.sum.map((v) => v / c.n) as Vec3)).depth]));
		const order = (p: (typeof faces)[number], q: (typeof faces)[number]) =>
			groupDepth.get(p.group)! - groupDepth.get(q.group)! || p.depth - q.depth;
		for (const { face, points, normal } of faces.sort(order)) {
			const img = images.get(face.texture);
			if (img) drawFace(ctx, view, prepared(img, face.tint, shadeOf(view, normal)), face, points);
		}
	}
	return canvas.toDataURL('image/png');
}

/**
 * Icons for one server, fetched in batches: every icon asked for in the same
 * tick goes in one request, and each is drawn once.
 */
/** The most icons one request asks for: what iconsFor answers. */
export const ICON_BATCH = 500;

export function iconLoader(instanceId: string) {
	const base = `/api/instances/${encodeURIComponent(instanceId)}/item-icons`;
	const textureUrl = (ref: string) => `${base}/texture?ref=${encodeURIComponent(ref)}`;
	const drawn = new Map<string, Promise<DrawnIcon>>();
	let pending: { id: string; damage: number | null; resolve: (icon: ItemIcon | null) => void }[] = [];
	let vanilla = $state.raw<boolean | null>(null);
	let version = $state(0);

	function flush() {
		const all = pending;
		pending = [];
		// The server answers at most ICON_BATCH per request (itemicons.ts iconsFor); a big
		// inventory (ProjectE knowledge alone can be hundreds) goes in several.
		for (let i = 0; i < all.length; i += ICON_BATCH) send(all.slice(i, i + ICON_BATCH));
	}

	function send(batch: typeof pending) {
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
		icon(id: string, damage: number | null): Promise<DrawnIcon> {
			const key = iconKey(id, damage);
			let hit = drawn.get(key);
			if (!hit) {
				hit = new Promise<ItemIcon | null>((resolve) => {
					if (!pending.length) queueMicrotask(flush);
					pending.push({ id, damage, resolve });
				}).then(async (icon) => ({
					url: icon?.spec ? await renderIcon(icon.spec, textureUrl).catch(() => null) : null,
					exact: icon?.exact ?? true,
					variant: icon?.variant ?? false,
					name: icon?.name ?? null
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
