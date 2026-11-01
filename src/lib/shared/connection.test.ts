import { describe, expect, it } from 'vitest';
import { connectionKind } from './connection';

describe('how a page came', () => {
	it('is https, this machine, or plain http across the network', () => {
		expect(connectionKind({ protocol: 'https:', hostname: 'box.tail1234.ts.net' })).toBe('https');
		for (const hostname of ['localhost', 'mineshell.localhost', '127.0.0.1', '127.1.2.3', '[::1]']) {
			expect(connectionKind({ protocol: 'http:', hostname }), hostname).toBe('local');
		}
		// The LAN is a network too: anyone else on it can read a plain-http password.
		for (const hostname of ['192.168.0.200', 'box.local', 'box', '100.101.102.103', 'localhost.evil.example']) {
			expect(connectionKind({ protocol: 'http:', hostname }), hostname).toBe('plain');
		}
	});
});
