#!/usr/bin/env bash
# Runs the whole test suite several times with the test files in a shuffled order, each run
# with its own seed, and lists the seeds that failed with the command that repeats each.
# Shared workers (`isolate: false`) carry module state from one file to the next, so a file
# that leaves something behind (a fake clock left on stalled other files) fails only in some
# orders. Every fifth run uses one worker: every shared file then follows every other.
#
#   tests/tools/repeat-tests.sh [runs, default 20]
#
# Tests inside a file keep their order: flow tests build on the test before (link, then use).
# The Scheduled CI workflow runs it weekly.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
runs="${1:-20}"
failed=()
for ((i = 1; i <= runs; i++)); do
	seed=$((RANDOM * 32768 + RANDOM))
	options=(--sequence.shuffle.files "--sequence.seed=$seed")
	((i % 5 == 0)) && options+=(--maxWorkers=1)
	printf 'Run %d of %d: %s\n' "$i" "$runs" "${options[*]}"
	out=$(npx vitest run "${options[@]}" 2>&1)
	if [ $? -ne 0 ]; then
		# Without the colour codes, which GitHub's runners get: the lines did not match.
		printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^ +(FAIL|Test Files|Tests) ' | sed 's/^/  /'
		failed+=("npx vitest run ${options[*]}")
	fi
done
if ((${#failed[@]})); then
	printf '\n%d of %d runs failed. Each again:\n' "${#failed[@]}" "$runs"
	printf '  %s\n' "${failed[@]}"
	exit 1
fi
printf '\nAll %d runs passed.\n' "$runs"
