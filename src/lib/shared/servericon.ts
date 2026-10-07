/**
 * Any image as the 64x64 PNG Minecraft shows next to a server (server-icon.png):
 * centre-cropped to a square and scaled, in the browser, which decodes every
 * format pack icons come in (PNG, WebP, JPEG). Browser only.
 */
export async function toServerIcon(source: Blob): Promise<Blob> {
	const image = await createImageBitmap(source);
	const side = Math.min(image.width, image.height);
	const canvas = document.createElement('canvas');
	canvas.width = 64;
	canvas.height = 64;
	const ctx = canvas.getContext('2d')!;
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 64, 64);
	return new Promise((resolve, reject) =>
		canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not convert the image.'))), 'image/png')
	);
}

/** The pack's own icon (fetched by MineShell, so the canvas may read it) as the server's icon. */
export async function applyPackIcon(instanceId: string): Promise<void> {
	const url = `/api/instances/${encodeURIComponent(instanceId)}/icon`;
	const source = await fetch(`${url}?source=pack`);
	if (!source.ok) throw new Error((await source.json().catch(() => null))?.message ?? 'The pack has no icon to use.');
	const res = await fetch(url, { method: 'PUT', body: await toServerIcon(await source.blob()) });
	if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Saving the icon failed.');
}
