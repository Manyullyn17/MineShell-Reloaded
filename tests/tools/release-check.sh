#!/usr/bin/env bash
# scripts/release.sh and release-notes.sh in a throwaway git repository: the versions they
# pick and the notes they write, betas included. Nothing is pushed; this repository is not
# touched.
#
#   tests/tools/release-check.sh
#
# The path: 1.0.0, a feat: -> beta gives 1.1.0-beta.1, a fix: -> beta gives -beta.2, then a
# plain release gives 1.1.0 (notes: everything since 1.0.0, no betas' notes), a fix: then
# 1.1.1, and a breaking change's beta 2.0.0-beta.1.
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/repo"
cd "$work/repo"
git init -q -b main
git config user.name check && git config user.email check@example.invalid
mkdir scripts
cp "$root/scripts/release.sh" "$root/scripts/release-notes.sh" scripts/
printf '{ "name": "x", "version": "1.0.0", "private": true }\n' > package.json
printf '{ "name": "x", "version": "1.0.0", "lockfileVersion": 3, "requires": true, "packages": { "": { "name": "x", "version": "1.0.0" } } }\n' > package-lock.json
git add -A && git commit -qm 'chore: version 1.0.0' && git tag -a v1.0.0 -m 'MineShell 1.0.0'

failures=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi; }
commit() { git commit -q --allow-empty -m "$1"; }
release() { scripts/release.sh "$@" > "$work/out" 2>&1; }
version() { node -p "require('./package.json').version"; }
notes() { scripts/release-notes.sh "$1"; }

commit 'feat: a new page'
release beta
check 'a feat: then beta: 1.1.0-beta.1' '[ "$(version)" = 1.1.0-beta.1 ] && git rev-parse -q --verify refs/tags/v1.1.0-beta.1 >/dev/null'

commit 'fix: the new page loads'
release beta
check 'a fix: then beta: -beta.2, not 1.1.1' '[ "$(version)" = 1.1.0-beta.2 ]'
check "a beta's notes: only since the last beta" 'notes v1.1.0-beta.2 | grep -q "The new page loads" && ! notes v1.1.0-beta.2 | grep -q "A new page"'

commit 'fix: one more'
printf 'Intro\n\n## Highlights\n\n- one\n' > "$work/intro.md"
release -F "$work/intro.md"
check 'then a release: 1.1.0' '[ "$(version)" = 1.1.0 ]'
check "the release's notes: everything since 1.0.0, headings kept" 'n=$(notes v1.1.0); grep -q "A new page" <<<"$n" && grep -q "The new page loads" <<<"$n" && grep -q "One more" <<<"$n" && grep -q "^## Highlights" <<<"$n" && grep -q "compare/v1.0.0...v1.1.0" <<<"$n"'

commit 'fix: after the release'
release
check 'a fix: after it: 1.1.1' '[ "$(version)" = 1.1.1 ]'

commit 'feat!: a breaking change'
release beta
check 'a breaking change, beta: 2.0.0-beta.1' '[ "$(version)" = 2.0.0-beta.1 ]'
release
check 'nothing since the beta: refused' 'grep -q "nothing since" "$work/out" && [ "$(version)" = 2.0.0-beta.1 ]'
commit 'fix: before 2.0'
release 2.0.0
check 'a named version wins' '[ "$(version)" = 2.0.0 ]'

[ "$failures" -eq 0 ] && echo "all passed" || { echo "$failures failed; the last output:"; cat "$work/out"; exit 1; }
