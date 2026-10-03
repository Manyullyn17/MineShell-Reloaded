/**
 * Minecraft only shows a server-icon.png that is a 64x64 PNG; anything else
 * is ignored with a line in the log. Checked from the PNG header (signature,
 * then the IHDR chunk's width and height), no image library needed.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Far above any 64x64 PNG; keeps a wrong upload from being written. */
const MAX_BYTES = 256 * 1024;

/** Why `bytes` cannot be a server icon, or null when it can. */
export function checkServerIcon(bytes: Buffer): string | null {
	if (bytes.length > MAX_BYTES) return 'That file is too big for a 64x64 icon.';
	if (bytes.length < 24 || !bytes.subarray(0, 8).equals(SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
		return 'The icon must be a PNG.';
	}
	const width = bytes.readUInt32BE(16);
	const height = bytes.readUInt32BE(20);
	if (width !== 64 || height !== 64) return `The icon must be 64x64 pixels; this one is ${width}x${height}.`;
	return null;
}
