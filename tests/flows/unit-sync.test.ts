import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { syncUnit } from '#lib/server/instances.js';
import { TEMPLATE_UNIT, systemdUnitDir } from '#lib/server/config.js';
import { createInstance } from '../helpers/instances';
import { fakeProcesses, spawnCalls } from '../helpers/process';

describe('writing a server’s unit files', () => {
	// The env file went over to quoted arguments while a running dev server's template still
	// had the old start line (it is refreshed at boot only): Java got the quotes.
	it('brings an outdated template up to date before writing the env file the new way', async () => {
		fakeProcesses(() => ({}));
		const file = path.join(systemdUnitDir(), TEMPLATE_UNIT);
		await fs.mkdir(systemdUnitDir(), { recursive: true });
		await fs.writeFile(file, `# Managed by MineShell.\n[Service]\nExecStart=/bin/sh -c 'exec "$MS_JAVA" $MS_JVM_ARGS $MS_LAUNCH_ARGS'\n`);
		await syncUnit(await createInstance({ modloader: 'vanilla', minecraftVersion: '1.21.1' }));
		expect(await fs.readFile(file, 'utf8')).toContain('eval "set -- $MS_JVM_ARGS $a $MS_LAUNCH_ARGS"');
		expect(spawnCalls.map((c) => c.args.join(' '))).toContain('--user daemon-reload');
	});
});
