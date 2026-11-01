#!/usr/bin/env bash
# Release notes for a tag, as Markdown on stdout, for the Release workflow (and
# Settings > Updates, which shows them before updating):
#
#   scripts/release-notes.sh v0.2.1
#
# The tag's own message (beyond its first line) comes first, then the commits
# since the previous tag (for a release, the previous release: its betas are left out): feat: under "New", fix: under "Fixed", one line each
# from the subject. docs:, test:, ci: and chore: commits are left out.
set -euo pipefail

tag="$1"
repo="${GITHUB_REPOSITORY:-Manyullyn17/MineShell-Reloaded}"
# A beta's notes are what changed since the tag before it (the last beta); a release's,
# everything since the last release, its betas' changes included.
if [[ "$tag" == *-* ]]; then
	previous=$(git describe --tags --abbrev=0 --match 'v*' "$tag^" 2>/dev/null || true)
else
	previous=$(git describe --tags --abbrev=0 --match 'v*' --exclude 'v*-*' "$tag^" 2>/dev/null || true)
fi
range="${previous:+$previous..}$tag"

intro=$(git tag -l --format='%(contents:body)' "$tag" | sed -e '/^-----BEGIN PGP/,$d')
if [ -n "${intro//[[:space:]]/}" ]; then
	printf '%s\n\n' "$intro"
fi

section() {
	local title="$1" prefix="$2" lines
	lines=$(git log --no-merges --reverse --format='%s' "$range" |
		sed -n "s/^$prefix\(([^)]*)\)\{0,1\}: *//p" |
		sed 's/^./\U&/; s/^/- /')
	if [ -n "$lines" ]; then
		printf '## %s\n\n%s\n\n' "$title" "$lines"
	fi
}
section New feat
section Fixed fix

if [ -n "$previous" ]; then
	printf '**All changes:** https://github.com/%s/compare/%s...%s\n' "$repo" "$previous" "$tag"
fi
