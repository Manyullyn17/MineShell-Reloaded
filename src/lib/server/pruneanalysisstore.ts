import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CACHE_DIR } from './config';
import { decodeAnalysis, encodeAnalysis, type AnalysedRegion, type AnalysisHead } from '#lib/shared/chunkprune.js';

/**
 * The last prune analysis of each server, kept on disk too
 * (`cache/prune-analysis/<id>.bin.gz`, the page's own encoding) so a restart
 * of MineShell does not mean analysing again: a big world takes a while. It
 * is a picture of the moment it was made, which the page says; the prune
 * reads every chunk again anyway. world.ts keeps the one in use in memory.
 */

export type StoredAnalysis = AnalysisHead & { label: string; chunks: number; unreadable: number; regions: AnalysedRegion[] };

const file = (instanceId: string) => path.join(CACHE_DIR, 'prune-analysis', `${encodeURIComponent(instanceId)}.bin.gz`);

export async function saveAnalysis(instanceId: string, analysis: StoredAnalysis): Promise<void> {
	const { regions, ...rest } = analysis;
	const head = { ...rest, regions: regions.map((r) => ({ x: r.x, z: r.z })) };
	const target = file(instanceId);
	await fs.promises.mkdir(path.dirname(target), { recursive: true });
	await fs.promises.writeFile(`${target}.part`, zlib.gzipSync(encodeAnalysis(head, regions), { level: 4 }));
	await fs.promises.rename(`${target}.part`, target);
}

/** Read once, when the one in memory is gone (a restart); null when there is none or it cannot be read. */
export function loadAnalysis(instanceId: string): StoredAnalysis | null {
	try {
		const bytes = zlib.gunzipSync(fs.readFileSync(file(instanceId)));
		const { head, regions } = decodeAnalysis(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
		const stored = head as AnalysisHead & Partial<StoredAnalysis>;
		if (typeof stored.label !== 'string' || typeof stored.at !== 'number') return null;
		return { ...stored, label: stored.label, chunks: stored.chunks ?? 0, unreadable: stored.unreadable ?? 0, regions };
	} catch {
		return null;
	}
}

export function deleteAnalysis(instanceId: string): void {
	fs.rmSync(file(instanceId), { force: true });
}

/** A server deleted: its analysis goes from disk and from world.ts's memory, or one made under its name would find it. */
export function forgetAnalysis(instanceId: string): void {
	deleteAnalysis(instanceId);
	(globalThis as { __mineshellPruneAnalyses?: Map<string, unknown> }).__mineshellPruneAnalyses?.delete(instanceId);
}
