import { describe, expect, it } from 'vitest';
import { parseHeapArg, parseHeapInfo, parseMaxHeap, safeToSignal } from './heap';

// GC.heap_info as Java 8, 17, 21 and 25 printed it (October 2026, -Xmx256m).
const K = 1024;
const M = 1024 * 1024;

describe('GC.heap_info', () => {
	it('reads what is used, for every collector and Java version', () => {
		expect(parseHeapInfo('garbage-first heap   total reserved 262144K, committed 262144K, used 113796K [0x00000000f0000000, 0x0000000100000000)\n region size 1024K, 30 young (30720K), 0 survivors (0K)\n')).toBe(113796 * K);
		expect(parseHeapInfo(' garbage-first heap   total 262144K, used 40960K [0x00000000f0000000, 0x00000000f0100800, 0x0000000100000000)\n  region size 1024K, 1 young (1024K), 0 survivors (0K)\n Metaspace       used 2792K, capacity 4486K, committed 4864K, reserved 1056768K\n  class space    used 291K, capacity 386K, committed 512K, reserved 1048576K\n')).toBe(40960 * K);
		const parallel = [
			' PSYoungGen      total 76288K, used 44893K [0x00000000fab00000, 0x0000000100000000, 0x0000000100000000)',
			'  eden space 65536K, 68% used [0x00000000fab00000,0x00000000fd6d74c0,0x00000000feb00000)',
			'  from space 10752K, 0% used [0x00000000ff580000,0x00000000ff580000,0x0000000100000000)',
			' ParOldGen       total 175104K, used 1073K [0x00000000f0000000, 0x00000000fab00000, 0x00000000fab00000)',
			'  object space 175104K, 0% used [0x00000000f0000000,0x00000000f010c710,0x00000000fab00000)',
			' Metaspace       used 2790K, capacity 4486K, committed 4864K, reserved 1056768K'
		].join('\n');
		expect(parseHeapInfo(parallel)).toBe((44893 + 1073) * K);
		expect(parseHeapInfo(' ZHeap           used 84M, capacity 256M, max capacity 256M\n Metaspace       used 142K, committed 384K, reserved 1114112K\n')).toBe(84 * M);
		expect(parseHeapInfo('Shenandoah Heap\n 256M max, 256M soft max, 256M committed, 43008K used\n 1024 x 256K regions\nStatus: not cancelled\n')).toBe(43008 * K);
		expect(parseHeapInfo('java.lang.IllegalArgumentException: Unknown diagnostic command')).toBeNull();
	});

	it('reads the maximum from VM.flags', () => {
		expect(parseMaxHeap('-XX:CICompilerCount=4 -XX:InitialHeapSize=268435456 -XX:MaxHeapSize=17179869184 -XX:+UseG1GC')).toBe(16 * 1024 * M);
		expect(parseMaxHeap('')).toBeNull();
	});

	it('reads the heap a command line asks for, the last flag counting', () => {
		// irithyll-go-brrr, saved at 8192 MB while it ran with this (October 2026).
		const args = ['/usr/lib/jvm/java-21-openjdk-amd64/bin/java', '-Xms1024M', '-Xmx10240M', '-XX:+UseZGC', '-jar', 'server.jar', 'nogui'];
		expect(parseHeapArg(args)).toBe(10240 * M);
		expect(parseHeapArg(['java', '-Xmx4g', '-XX:MaxHeapSize=6G'])).toBe(6 * 1024 * M);
		expect(parseHeapArg(['java', '-Xmx512k'])).toBe(512 * K);
		expect(parseHeapArg(['java', '-Xmx1073741824'])).toBe(1024 * M);
		expect(parseHeapArg(['java', '@user_jvm_args.txt', '-Xms2G'])).toBeNull();
	});

	it('never signals a JVM that would not take SIGQUIT as an attach request', () => {
		expect(safeToSignal(['java', '-Xmx4G', '-XX:+PerfDisableSharedMem', '-jar', 'server.jar'])).toBe(true);
		expect(safeToSignal(['java', '-Xrs', '-jar', 'server.jar'])).toBe(false);
		expect(safeToSignal(['java', '-XX:+DisableAttachMechanism', '-jar', 'server.jar'])).toBe(false);
		expect(safeToSignal(['java', '-XX:+ReduceSignalUsage', '-jar', 'server.jar'])).toBe(false);
	});
});
