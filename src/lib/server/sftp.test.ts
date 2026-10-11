import { describe, expect, it } from 'vitest';
import { sshdPort, validHost, validUser } from './sftp';

describe('sshdPort', () => {
	it('reads the first Port, ignoring case and comments', () => {
		// This machine's /etc/ssh/sshd_config (October 2026), shortened.
		const config = ['Include /etc/ssh/sshd_config.d/*.conf', '', '#Port 22', 'Port 2222', '#AddressFamily any', 'Port 2223'].join('\n');
		expect(sshdPort(config)).toBe(2222);
		expect(sshdPort('  port   2022  # moved\n')).toBe(2022);
	});

	it('finds none in the stock config, nor inside a Match block', () => {
		expect(sshdPort('#Port 22\nPermitRootLogin no\n')).toBeNull();
		expect(sshdPort('Match User backup\n  Port 2200\n')).toBeNull();
		expect(sshdPort('Port many\n')).toBeNull();
	});
});

describe('settings checks', () => {
	it('takes host names and addresses, nothing that would change the URL', () => {
		for (const ok of ['mc-server', 'mc.example.org', '192.168.1.20', 'fe80::1', '[::1]']) expect(validHost(ok)).toBe(true);
		for (const bad of ['user@host', 'host/path', 'sftp://host', 'host:22', '-host', '']) expect(validHost(bad)).toBe(false);
	});

	it('takes account names', () => {
		expect(validUser('manyullyn')).toBe(true);
		expect(validUser('a b')).toBe(false);
		expect(validUser('x@y')).toBe(false);
	});
});
