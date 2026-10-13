import net from 'node:net';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { addressKind, allowAddress, removeAllowedAddress } from '#lib/server/downloadaccess.js';
import { audit } from '#lib/server/instances.js';
import { blockedLabel } from '#lib/shared/downloads.js';

/**
 * Allows downloads from one exact non-public address, or takes that back
 * (downloadaccess.ts). Global admins only (access policy): the guard exists
 * to stop accounts that may only create servers.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { address?: unknown; host?: unknown } | null;
	const address = typeof body?.address === 'string' ? body.address.trim() : '';
	if (!net.isIP(address)) error(400, 'That is not an IP address.');
	if (!addressKind(address)) error(400, `${address} is a public address; downloads from it need no allowing.`);
	const host = typeof body?.host === 'string' && body.host.trim() ? body.host.trim().slice(0, 253) : address;
	allowAddress(address, host);
	audit('download-address-allowed', { detail: blockedLabel({ host, address }) });
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ url }) => {
	const address = url.searchParams.get('address') ?? '';
	if (!removeAllowedAddress(address)) error(404, `${address || 'That address'} is not on the allowed list.`);
	audit('download-address-removed', { detail: address });
	return json({ ok: true });
};
