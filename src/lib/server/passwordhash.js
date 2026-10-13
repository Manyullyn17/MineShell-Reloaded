import crypto from 'node:crypto';

/**
 * Account password hashes (scrypt), in one place. Plain JavaScript with no
 * imports beyond node's, so scripts/reset-password.mjs (plain Node, outside
 * SvelteKit) writes hashes the app reads; crypto.ts re-exports these.
 */

const SCRYPT = { N: 16384, r: 8, p: 1 };

/**
 * @param {string} password
 * @returns {string} `scrypt$<salt>$<hash>`, base64
 */
export function hashPassword(password) {
	const salt = crypto.randomBytes(16);
	const derived = crypto.scryptSync(password, salt, 64, SCRYPT);
	return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * @param {string} password
 * @param {string} stored a hashPassword() result
 * @returns {boolean}
 */
export function verifyPassword(password, stored) {
	const [algo, saltB64, hashB64] = stored.split('$');
	if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
	const expected = Buffer.from(hashB64, 'base64');
	const derived = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
	return crypto.timingSafeEqual(expected, derived);
}
