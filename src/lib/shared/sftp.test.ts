import { describe, expect, it } from 'vitest';
import { sftpLink } from './sftp';

describe('sftpLink', () => {
	it('names the account, the port unless it is 22, and the folder', () => {
		expect(sftpLink({ user: 'manyullyn', host: '192.168.1.20', port: 2222, path: '/home/manyullyn/.local/share/mineshell/instances/irithyll-go-brrr' })).toBe(
			'sftp://manyullyn@192.168.1.20:2222/home/manyullyn/.local/share/mineshell/instances/irithyll-go-brrr'
		);
		expect(sftpLink({ user: 'mc', host: 'mc-server', port: 22, path: '/srv/mc' })).toBe('sftp://mc@mc-server/srv/mc');
	});

	it('escapes what a URL cannot hold, and brackets an IPv6 address', () => {
		expect(sftpLink({ user: 'mc', host: 'fe80::1', port: 22, path: '/srv/My Server/#1' })).toBe('sftp://mc@[fe80::1]/srv/My%20Server/%231');
		expect(sftpLink({ user: 'mc', host: '[::1]', port: 2222, path: '/x' })).toBe('sftp://mc@[::1]:2222/x');
	});
});
