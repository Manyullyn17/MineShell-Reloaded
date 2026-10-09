import type { FaceSpec, IconSpec, Quad } from './itemicons';

/**
 * Item pictures for what the game draws in code from entity models (heads,
 * banners, beds, the conduit, the decorated pot, copper golem statues): their
 * parts, read from the 26.3 client's model classes, turned into faces the way
 * the game's ModelPart.Cube builds them - which texture corner lands on which
 * box corner included, so no face needs hand-placing.
 *
 * Coordinates are pixels. A part is placed as ModelPart does it: moved by its
 * offset, turned by its rotation (z, then y, then x), scaled; children inside
 * their parent. `outer` then places the model in the item's space (the item
 * definition's transformation, or the old renderer's PoseStack calls), all in
 * pixels with y up, the space the inventory view turns.
 */

type Vec3 = [number, number, number];
/** A 3x4 matrix, rows x, y, z. */
export type Mat = number[];

export const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export function mul(a: Mat, b: Mat): Mat {
	const out: number[] = [];
	for (let r = 0; r < 3; r++) {
		for (let c = 0; c < 4; c++) {
			const v = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
			out.push(v);
		}
	}
	return out;
}

export const chain = (...ms: Mat[]): Mat => ms.reduce((a, b) => mul(a, b), IDENTITY);
export const translate = (x: number, y: number, z: number): Mat => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
export const scale = (x: number, y = x, z = x): Mat => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0];
export function rotX(a: number): Mat {
	const [c, s] = [Math.cos(a), Math.sin(a)];
	return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0];
}
export function rotY(a: number): Mat {
	const [c, s] = [Math.cos(a), Math.sin(a)];
	return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0];
}
export function rotZ(a: number): Mat {
	const [c, s] = [Math.cos(a), Math.sin(a)];
	return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}

function apply(m: Mat, [x, y, z]: Vec3): Vec3 {
	return [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
}

function direction(m: Mat, [x, y, z]: Vec3): Vec3 {
	const v: Vec3 = [m[0] * x + m[1] * y + m[2] * z, m[4] * x + m[5] * y + m[6] * z, m[8] * x + m[9] * y + m[10] * z];
	const length = Math.hypot(...v) || 1;
	return v.map((n) => n / length) as Vec3;
}

type Face = 'down' | 'up' | 'west' | 'north' | 'east' | 'south';

/** A box as the game's CubeListBuilder takes it: texture offset, corner and size, `grow` (CubeDeformation), mirrored. */
export type Cube = {
	uv: [number, number];
	box: [number, number, number, number, number, number];
	grow?: number;
	mirror?: boolean;
	/** Only these faces (the decorated pot's flat panels). */
	faces?: Face[];
	/** Its own texture and tint, over the model's (a banner's colour layer). */
	texture?: string;
	textureWidth?: number;
	tint?: string | null;
};

export type Part = { offset?: Vec3; rotation?: Vec3; scale?: number; cubes?: Cube[]; children?: Part[] };

const NORMALS: Record<Face, Vec3> = { down: [0, -1, 0], up: [0, 1, 0], west: [-1, 0, 0], north: [0, 0, -1], east: [1, 0, 0], south: [0, 0, 1] };

/**
 * One box's faces, as ModelPart.Cube makes them: eight corners (min and max x
 * swapped when mirrored), each face a polygon whose texture rectangle goes on
 * its corners as Polygon remaps them - the second corner gets the rectangle's
 * top left, the first its top right, the third its bottom left.
 */
function cubeQuads(cube: Cube, m: Mat, texture: string, textureWidth: number, group: number): Quad[] {
	const [x, y, z, w, h, d] = cube.box;
	const g = cube.grow ?? 0;
	let [x0, x1] = [x - g, x + w + g];
	if (cube.mirror) [x0, x1] = [x1, x0];
	const [y0, y1, z0, z1] = [y - g, y + h + g, z - g, z + d + g];
	const v: Vec3[] = [
		[x0, y0, z0],
		[x1, y0, z0],
		[x1, y1, z0],
		[x0, y1, z0],
		[x0, y0, z1],
		[x1, y0, z1],
		[x1, y1, z1],
		[x0, y1, z1]
	];
	const [u, t] = cube.uv;
	const [l1, l2, l3, l4, l5] = [u + d, u + d + w, u + d + w + w, u + d + w + d, u + d + w + d + w];
	const [m1, m2] = [t + d, t + d + h];
	const polygons: [Face, number[], [number, number, number, number]][] = [
		['down', [5, 4, 0, 1], [l1, t, l2, m1]],
		['up', [2, 3, 7, 6], [l2, m1, l3, t]],
		['west', [0, 4, 7, 3], [u, m1, l1, m2]],
		['north', [1, 0, 3, 2], [l1, m1, l2, m2]],
		['east', [5, 1, 2, 6], [l2, m1, l4, m2]],
		['south', [4, 5, 6, 7], [l4, m1, l5, m2]]
	];
	const tex = cube.texture ?? texture;
	const unit = (cube.textureWidth ?? textureWidth) / 16;
	const quads: Quad[] = [];
	for (const [side, corners, [u1, v1, u2, v2]] of polygons) {
		if (cube.faces && !cube.faces.includes(side)) continue;
		const n = NORMALS[side];
		const face: FaceSpec = { texture: tex, uv: [u1 / unit, v1 / unit, u2 / unit, v2 / unit], tint: cube.tint ?? null };
		quads.push({
			corners: [apply(m, v[corners[1]]), apply(m, v[corners[0]]), apply(m, v[corners[2]])],
			normal: direction(m, cube.mirror ? [-n[0], n[1], n[2]] : n),
			face,
			group
		});
	}
	return quads;
}

function partMatrix(part: Part): Mat {
	const [x, y, z] = part.offset ?? [0, 0, 0];
	const [rx, ry, rz] = part.rotation ?? [0, 0, 0];
	return chain(translate(x, y, z), rotZ(rz), rotY(ry), rotX(rx), scale(part.scale ?? 1));
}

export function modelQuads(parts: Part[], outer: Mat, texture: string, textureWidth: number): Quad[] {
	const quads: Quad[] = [];
	let group = 0;
	const walk = (part: Part, parent: Mat) => {
		const m = mul(parent, partMatrix(part));
		for (const cube of part.cubes ?? []) quads.push(...cubeQuads(cube, m, texture, textureWidth, group++));
		for (const child of part.children ?? []) walk(child, m);
	};
	for (const part of parts) walk(part, outer);
	return quads;
}

/**
 * An icon from quads: turned by the item model's GUI rotation (z baked into
 * the quads by the caller, as the view turns about x and y only), sized
 * against a block's 0.625, centred on what it draws.
 */
export function entityIcon(quads: Quad[], rotation: [number, number], guiScale: number): IconSpec {
	const points = quads.flatMap((q) => {
		const [a, b, c] = q.corners;
		return [a, b, c, [b[0] + c[0] - a[0], b[1] + c[1] - a[1], b[2] + c[2] - a[2]] as Vec3];
	});
	const center = [0, 1, 2].map((i) => {
		const values = points.map((p) => p[i]);
		return (Math.min(...values) + Math.max(...values)) / 2;
	}) as Vec3;
	return { kind: 'block', elements: [], quads, rotation: [rotation[0], rotation[1], 0], scale: guiScale / 0.625, center };
}

// ------------------------------------------------------------------ models ---

const head = (texture: string, width: number, hat: boolean): Part[] => [
	{
		cubes: [{ uv: [0, 0], box: [-4, -8, -4, 8, 8, 8] }, ...(hat ? [{ uv: [32, 0] as [number, number], box: [-4, -8, -4, 8, 8, 8] as Cube['box'], grow: 0.25 }] : [])]
	}
];

const PIGLIN: Part[] = [
	{
		cubes: [
			{ uv: [0, 0], box: [-5, -8, -4, 10, 8, 8] },
			{ uv: [31, 1], box: [-2, -4, -5, 4, 4, 1] },
			{ uv: [2, 4], box: [2, -2, -5, 1, 2, 1] },
			{ uv: [2, 0], box: [-3, -2, -5, 1, 2, 1] }
		],
		children: [
			{ offset: [4.5, -6, 0], rotation: [0, 0, -Math.PI / 6], cubes: [{ uv: [51, 6], box: [0, 0, -2, 1, 5, 4] }] },
			{ offset: [-4.5, -6, 0], rotation: [0, 0, Math.PI / 6], cubes: [{ uv: [39, 6], box: [-1, 0, -2, 1, 5, 4] }] }
		]
	}
];

const DRAGON: Part[] = [
	{
		children: [
			{
				offset: [0, -7.986666, 0],
				scale: 0.75,
				cubes: [
					{ uv: [176, 44], box: [-6, -1, -24, 12, 5, 16] },
					{ uv: [112, 30], box: [-8, -8, -10, 16, 16, 16] },
					{ uv: [0, 0], box: [-5, -12, -4, 2, 4, 6], mirror: true },
					{ uv: [112, 0], box: [-5, -3, -22, 2, 2, 4], mirror: true },
					{ uv: [0, 0], box: [3, -12, -4, 2, 4, 6] },
					{ uv: [112, 0], box: [3, -3, -22, 2, 2, 4] }
				],
				// The jaw, a little open: the item's animation is 0, which opens it 0.2.
				children: [{ offset: [0, 4, -8], rotation: [0.2, 0, 0], cubes: [{ uv: [176, 65], box: [-6, 0, -16, 12, 4, 16] }] }]
			}
		]
	}
];

/** The item definition's transformation for heads: to the block's middle, turned upside down (x, 180). */
const HEAD_PLACE = chain(translate(8, 0, 8), rotX(Math.PI));

export type HeadKind = 'skeleton' | 'wither_skeleton' | 'zombie' | 'player' | 'creeper' | 'piglin' | 'dragon';

/** Texture candidates per head, newest place first. */
const HEAD_TEXTURES: Record<HeadKind, { paths: string[]; width: number; hat: boolean }> = {
	skeleton: { paths: ['entity/skeleton/skeleton'], width: 64, hat: false },
	wither_skeleton: { paths: ['entity/skeleton/wither_skeleton'], width: 64, hat: false },
	zombie: { paths: ['entity/zombie/zombie'], width: 64, hat: true },
	player: { paths: ['entity/player/wide/steve', 'entity/steve'], width: 64, hat: true },
	creeper: { paths: ['entity/creeper/creeper'], width: 64, hat: false },
	piglin: { paths: ['entity/piglin/piglin'], width: 64, hat: false },
	dragon: { paths: ['entity/enderdragon/dragon'], width: 256, hat: false }
};

export function headIcon(kind: HeadKind, has: (texture: string) => boolean): IconSpec | null {
	const found = HEAD_TEXTURES[kind];
	const path = found.paths.find((p) => has(p));
	if (!path) return null;
	const texture = `minecraft:${path}`;
	const parts = kind === 'piglin' ? PIGLIN : kind === 'dragon' ? DRAGON : head(texture, found.width, found.hat);
	// The dragon's item model shows it at 0.6, the others at 1.
	return entityIcon(modelQuads(parts, HEAD_PLACE, texture, found.width), [30, 45], kind === 'dragon' ? 0.6 : 1);
}

/** The conduit's shell (its item is the shell alone), around the block's middle. */
export function conduitIcon(has: (texture: string) => boolean): IconSpec | null {
	if (!has('entity/conduit/base')) return null;
	const parts: Part[] = [{ cubes: [{ uv: [0, 0], box: [-3, -3, -3, 6, 6, 6] }] }];
	return entityIcon(modelQuads(parts, translate(8, 8, 8), 'minecraft:entity/conduit/base', 32), [30, 45], 1);
}

/** The decorated pot, plain: its parts are already in the block's pixels, y up. */
export function decoratedPotIcon(has: (texture: string) => boolean): IconSpec | null {
	if (!has('entity/decorated_pot/decorated_pot_base') || !has('entity/decorated_pot/decorated_pot_side')) return null;
	const base = 'minecraft:entity/decorated_pot/decorated_pot_base';
	const side = 'minecraft:entity/decorated_pot/decorated_pot_side';
	const plane: Cube = { uv: [-14, 13], box: [0, 0, 0, 14, 0, 14] };
	const panel: Cube = { uv: [1, 0], box: [0, 0, 0, 14, 16, 0], faces: ['north'], texture: side, textureWidth: 16 };
	const parts: Part[] = [
		{ offset: [0, 37, 16], rotation: [Math.PI, 0, 0], cubes: [{ uv: [0, 0], box: [4, 17, 4, 8, 3, 8] }, { uv: [0, 5], box: [5, 20, 5, 6, 1, 6] }] },
		{ offset: [1, 16, 1], cubes: [plane] },
		{ offset: [1, 0, 1], cubes: [plane] },
		{ offset: [15, 16, 1], rotation: [0, 0, Math.PI], cubes: [panel] },
		{ offset: [1, 16, 1], rotation: [0, -Math.PI / 2, Math.PI], cubes: [panel] },
		{ offset: [15, 16, 15], rotation: [0, Math.PI / 2, Math.PI], cubes: [panel] },
		{ offset: [1, 16, 15], rotation: [Math.PI, 0, 0], cubes: [panel] }
	];
	return entityIcon(modelQuads(parts, IDENTITY, base, 32), [30, 45], 0.6);
}

/** Banner colours: the game's dye colours, which tint the banner's base layer. */
export const DYE_COLORS: Record<string, string> = {
	white: '#f9fffe',
	orange: '#f9801d',
	magenta: '#c74ebd',
	light_blue: '#3ab3da',
	yellow: '#fed83d',
	lime: '#80c71f',
	pink: '#f38baa',
	gray: '#474f52',
	light_gray: '#9d9d97',
	cyan: '#169c9c',
	purple: '#8932b8',
	blue: '#3c44aa',
	brown: '#835432',
	green: '#5e7c16',
	red: '#b02e26',
	black: '#1d1d21'
};

/** A plain banner (no patterns): pole, bar and cloth from banner_base, the cloth's colour as its base layer, tinted. */
export function bannerIcon(color: string, has: (texture: string) => boolean): IconSpec | null {
	const base = ['entity/banner/banner_base', 'entity/banner_base'].find((p) => has(p));
	if (!base || !has('entity/banner/base') || !DYE_COLORS[color]) return null;
	const cloth: Cube['box'] = [-10, 0, -2, 20, 40, 1];
	const parts: Part[] = [
		{ cubes: [{ uv: [44, 0], box: [-1, -42, -1, 2, 42, 2] }] },
		{ cubes: [{ uv: [0, 42], box: [-10, -44, -1, 20, 2, 2] }] },
		{
			offset: [0, -44, 0],
			cubes: [
				{ uv: [0, 0], box: cloth },
				// Drawn after the cloth at the same place, so over it.
				{ uv: [0, 0], box: cloth, texture: 'minecraft:entity/banner/base', tint: DYE_COLORS[color] }
			]
		}
	];
	// The item's view is (30, 20); 70 here, as this projection's turn for models drawn in code was
	// matched to the game's icons by eye (the user's screenshots, 2026-10-09), like the shield's.
	return entityIcon(modelQuads(parts, chain(translate(8, 0, 8), scale(2 / 3, -2 / 3, -2 / 3)), `minecraft:${base}`, 64), [30, 70], 0.5325);
}

/**
 * A bed before 26.x made beds block models: BedRenderer's head and foot
 * (a 16x16x6 slab and two 3x3x3 legs each) laid down as it lays them -
 * up 9/16, turned 90 about x, then half round about z about the block's
 * middle - the foot one block further.
 */
export function bedIcon(color: string, has: (texture: string) => boolean): IconSpec | null {
	const path = `entity/bed/${color}`;
	if (!has(path)) return null;
	const piece = (foot: boolean) =>
		chain(translate(0, 9, foot ? -16 : 0), rotX(Math.PI / 2), translate(8, 8, 8), rotZ(Math.PI), translate(-8, -8, -8));
	const headParts: Part[] = [
		{ cubes: [{ uv: [0, 0], box: [0, 0, 0, 16, 16, 6] }] },
		{ rotation: [Math.PI / 2, 0, Math.PI / 2], cubes: [{ uv: [50, 6], box: [0, 6, 0, 3, 3, 3] }] },
		{ rotation: [Math.PI / 2, 0, Math.PI], cubes: [{ uv: [50, 18], box: [-16, 6, 0, 3, 3, 3] }] }
	];
	const footParts: Part[] = [
		{ cubes: [{ uv: [0, 22], box: [0, 0, 0, 16, 16, 6] }] },
		{ rotation: [Math.PI / 2, 0, 0], cubes: [{ uv: [50, 0], box: [0, 6, -16, 3, 3, 3] }] },
		{ rotation: [Math.PI / 2, 0, (3 * Math.PI) / 2], cubes: [{ uv: [50, 12], box: [-16, 6, -16, 3, 3, 3] }] }
	];
	const texture = `minecraft:${path}`;
	const head = modelQuads(headParts, piece(false), texture, 64);
	const foot = modelQuads(footParts, piece(true), texture, 64).map((q) => ({ ...q, group: q.group + head.length }));
	const quads = [...head, ...foot];
	// The item's view is (30, 160); 220 here, picked by the user from seven turns against the game (2026-10-09).
	return entityIcon(quads, [30, 220], 0.5325);
}

/**
 * A copper golem statue, standing: CopperGolemModel's body layer, every part
 * 24 lower (the statue's own shift). The item's view turns it 180 about z,
 * which is baked in here.
 */
export function statueIcon(texture: string, has: (texture: string) => boolean): IconSpec | null {
	if (!has(texture)) return null;
	const parts: Part[] = [
		{ offset: [0, 19, 0], cubes: [{ uv: [0, 15], box: [-4, -6, -3, 8, 6, 6] }] },
		{
			offset: [0, 18, 0],
			cubes: [
				{ uv: [0, 0], box: [-4, -5, -5, 8, 5, 10], grow: 0.015 },
				{ uv: [56, 0], box: [-1, -2, -6, 2, 3, 2] },
				{ uv: [37, 8], box: [-1, -9, -1, 2, 4, 2], grow: -0.015 },
				{ uv: [37, 0], box: [-2, -13, -2, 4, 4, 4], grow: -0.015 }
			]
		},
		{ offset: [-4, 18, 0], cubes: [{ uv: [36, 16], box: [-3, -1, -2, 3, 10, 4] }] },
		{ offset: [4, 18, 0], cubes: [{ uv: [50, 16], box: [0, -1, -2, 3, 10, 4] }] },
		{ offset: [0, 19, 0], cubes: [{ uv: [0, 27], box: [-4, 0, -2, 4, 5, 4] }] },
		{ offset: [0, 19, 0], cubes: [{ uv: [16, 27], box: [0, 0, -2, 4, 5, 4] }] }
	];
	// The item's view is (30, 45, 180); 225 here, matched to the game's icon by eye.
	return entityIcon(modelQuads(parts, rotZ(Math.PI), `minecraft:${texture}`, 64), [30, 225], 0.55);
}

/**
 * A chest (single; normal, trapped, ender). Since 1.15 ChestModel is upright:
 * the base (14x10x14 at texture 0,19), the lid on it and the lock, as the
 * 1.15+ textures (drawn upside down) expect. Before, ModelChest was built
 * upside down and turned over by its renderer (y and z flipped about the
 * block), with textures the right way up.
 */
export function chestIcon(texture: string, modern: boolean): IconSpec {
	const parts: Part[] = modern
		? [
				{ cubes: [{ uv: [0, 19], box: [1, 0, 1, 14, 10, 14] }] },
				{ offset: [0, 9, 1], cubes: [{ uv: [0, 0], box: [1, 0, 0, 14, 5, 14] }] },
				{ offset: [0, 9, 1], cubes: [{ uv: [0, 0], box: [7, -2, 14, 2, 4, 1] }] }
			]
		: [
				{ offset: [1, 7, 15], cubes: [{ uv: [0, 0], box: [0, -5, -14, 14, 5, 14] }] },
				{ offset: [8, 7, 15], cubes: [{ uv: [0, 0], box: [-1, -2, -15, 2, 4, 1] }] },
				{ offset: [1, 6, 1], cubes: [{ uv: [0, 19], box: [0, 0, 0, 14, 10, 14] }] }
			];
	const place = modern ? IDENTITY : chain(translate(0, 16, 16), scale(1, -1, -1));
	return entityIcon(modelQuads(parts, place, texture, 64), [30, 45], 0.625);
}
