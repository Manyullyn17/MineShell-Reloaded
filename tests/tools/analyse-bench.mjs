// Times a prune analysis (chunkprune.ts analyseRegions) of one dimension folder, read only:
//   npx tsx tests/tools/analyse-bench.mjs <folder holding region/> [runs]
// Also prints how long the event loop was held at most, which is what other requests wait.
import { analyseRegions } from '../../src/lib/server/chunkprune.ts';
import { NO_CHUNK } from '../../src/lib/shared/chunkprune.ts';

const [base, runs = '2'] = process.argv.slice(2);
if (!base) {
	console.error('usage: npx tsx tests/tools/analyse-bench.mjs <folder holding region/> [runs]');
	process.exit(1);
}
for (let run = 1; run <= Number(runs); run++) {
	let worst = 0;
	let last = performance.now();
	const timer = setInterval(() => {
		const now = performance.now();
		worst = Math.max(worst, now - last - 10);
		last = now;
	}, 10);
	const started = performance.now();
	const regions = (await analyseRegions(base)) ?? [];
	clearInterval(timer);
	const chunks = regions.reduce((n, r) => n + r.ticks.filter((t) => t !== NO_CHUNK).length, 0);
	console.log(`run ${run}: ${regions.length} regions, ${chunks} chunks in ${((performance.now() - started) / 1000).toFixed(1)} s; event loop held up to ${worst.toFixed(0)} ms`);
}
