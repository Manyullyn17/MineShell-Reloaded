/**
 * A real Minecraft world for the pictures that read world files (the chunk map
 * under the Chunky planner): Mojang's own server for that version, on a fixed
 * seed, generates a square of chunks around spawn (`forceload`), saves and
 * stops. Kept in the screenshot cache (scenes.mjs), so only the first run
 * waits for it (about a minute). Needs Java new enough for the version on PATH.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * The world folder, generated into `cacheDir` the first time.
 * @param {{ cacheDir: string; version: string; seed: string; radiusChunks: number; download: (url: string, name: string) => Promise<Buffer> }} o
 * @returns {Promise<string>}
 */
export async function generatedWorld({ cacheDir, version, seed, radiusChunks, download }) {
	const dir = path.join(cacheDir, `world-${version}-${seed}-${radiusChunks}`);
	if (fs.existsSync(path.join(dir, 'world/level.dat'))) return path.join(dir, 'world');
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });

	const meta = await versionMeta(version, download);
	fs.writeFileSync(path.join(dir, 'server.jar'), await download(meta.downloads.server.url, `server-${version}.jar`));

	const [port, rconPort] = [await freePort(), await freePort()];
	const password = crypto.randomBytes(12).toString('hex');
	fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
	fs.writeFileSync(
		path.join(dir, 'server.properties'),
		[`level-seed=${seed}`, `server-port=${port}`, 'enable-rcon=true', `rcon.port=${rconPort}`, `rcon.password=${password}`, 'online-mode=false', 'view-distance=4', 'simulation-distance=4', 'spawn-protection=0'].join('\n') + '\n'
	);

	const java = spawn('java', ['-Xmx3G', '-jar', 'server.jar', 'nogui'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
	let log = '';
	java.stdout.on('data', (b) => (log += b));
	java.stderr.on('data', (b) => (log += b));
	const exited = new Promise((resolve) => java.on('exit', resolve));
	try {
		await until(() => /\]: Done \(/.test(log), 300_000, () => `Minecraft ${version} did not start:\n${log.slice(-2000)}`);
		const rcon = await rconClient(rconPort, password);
		// forceload takes at most 256 chunks a call: squares of 16 x 16 chunks.
		for (let x = -radiusChunks; x < radiusChunks; x += 16)
			for (let z = -radiusChunks; z < radiusChunks; z += 16)
				await rcon(`forceload add ${x * 16} ${z * 16} ${(x + 16) * 16 - 1} ${(z + 16) * 16 - 1}`);
		// Forceloaded chunks generate in the background; done once the region files stop growing.
		await settled(path.join(dir, 'world/region'));
		await rcon('forceload remove all');
		await rcon('save-all flush');
		await rcon('stop');
		await Promise.race([exited, new Promise((r) => setTimeout(r, 60_000))]);
	} finally {
		java.kill('SIGKILL');
	}
	return path.join(dir, 'world');
}

/**
 * Mojang's description of a version (its server and client jars).
 * @param {string} version @param {(url: string, name: string) => Promise<Buffer>} download
 */
export async function versionMeta(version, download) {
	const manifest = JSON.parse((await download('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', 'version_manifest_v2.json')).toString());
	const entry = manifest.versions.find((/** @type {{ id: string }} */ v) => v.id === version);
	if (!entry) throw new Error(`Minecraft ${version} is not in Mojang's version list`);
	return JSON.parse((await download(entry.url, `${version}.json`)).toString());
}

/** @returns {Promise<number>} */
function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = /** @type {net.AddressInfo} */ (server.address());
			server.close(() => resolve(port));
		});
	});
}

/** @param {() => boolean} test @param {number} ms @param {() => string} message */
async function until(test, ms, message) {
	const end = Date.now() + ms;
	while (!test()) {
		if (Date.now() > end) throw new Error(message());
		await new Promise((r) => setTimeout(r, 500));
	}
}

/** Waits until the folder's total size has not changed for 10 s (at most 10 minutes). @param {string} folder */
async function settled(folder) {
	const size = () => (fs.existsSync(folder) ? fs.readdirSync(folder).reduce((s, f) => s + fs.statSync(path.join(folder, f)).size, 0) : 0);
	let last = -1;
	let still = 0;
	for (const end = Date.now() + 600_000; Date.now() < end && still < 10; ) {
		await new Promise((r) => setTimeout(r, 1000));
		const now = size();
		still = now === last && now > 0 ? still + 1 : 0;
		last = now;
	}
}

/**
 * A minimal RCON client: one connection, commands in turn.
 * @param {number} port @param {string} password
 * @returns {Promise<(command: string) => Promise<string>>}
 */
async function rconClient(port, password) {
	const socket = net.connect(port, '127.0.0.1');
	await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
	let buffer = Buffer.alloc(0);
	/** @type {((body: string) => void)[]} */
	const waiting = [];
	socket.on('data', (chunk) => {
		buffer = Buffer.concat([buffer, /** @type {Buffer} */ (chunk)]);
		while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
			const length = buffer.readInt32LE(0);
			const body = buffer.subarray(12, 4 + length - 2).toString('utf8');
			buffer = buffer.subarray(4 + length);
			waiting.shift()?.(body);
		}
	});
	let id = 1;
	/** @param {number} type @param {string} body */
	const send = (type, body) =>
		new Promise((resolve) => {
			waiting.push(resolve);
			const payload = Buffer.from(body, 'utf8');
			const packet = Buffer.alloc(14 + payload.length);
			packet.writeInt32LE(10 + payload.length, 0);
			packet.writeInt32LE(id++, 4);
			packet.writeInt32LE(type, 8);
			payload.copy(packet, 12);
			socket.write(packet);
		});
	await send(3, password);
	return (command) => /** @type {Promise<string>} */ (send(2, command));
}
