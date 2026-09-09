import crypto from 'node:crypto';
import fs from 'node:fs';
import { KEY_PATH, ensureDirs } from './config';

/**
 * Secrets (currently only RCON passwords) are encrypted at rest with a key held
 * in a 0600 file next to the database. This is not protection against someone
 * who already has the box - it stops the passwords being readable in a DB dump,
 * a backup, or a screen-share of the sqlite file.
 */

let cachedKey: Buffer | null = null;

function key(): Buffer {
	if (cachedKey) return cachedKey;
	ensureDirs();
	if (!fs.existsSync(KEY_PATH)) {
		const generated = crypto.randomBytes(32);
		fs.writeFileSync(KEY_PATH, generated.toString('base64'), { mode: 0o600 });
	}
	cachedKey = Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'base64');
	if (cachedKey.length !== 32) {
		throw new Error(`Key file ${KEY_PATH} is corrupt: expected 32 bytes.`);
	}
	return cachedKey;
}

export function encryptSecret(plaintext: string): string {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
	const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(
		':'
	);
}

export function decryptSecret(payload: string | null | undefined): string | null {
	if (!payload) return null;
	const parts = payload.split(':');
	if (parts.length !== 3) return null;
	try {
		const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64'));
		const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
	} catch {
		return null;
	}
}

export function randomPassword(bytes = 18): string {
	return crypto.randomBytes(bytes).toString('base64url');
}

export function hashPassword(password: string): string {
	const salt = crypto.randomBytes(16);
	const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
	return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
	const [algo, saltB64, hashB64] = stored.split('$');
	if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
	const expected = Buffer.from(hashB64, 'base64');
	const derived = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
		N: 16384,
		r: 8,
		p: 1
	});
	return crypto.timingSafeEqual(expected, derived);
}
