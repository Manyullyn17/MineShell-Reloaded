#!/usr/bin/env bash
# Prepares a release on main: picks the version from the commits since the last
# tag, bumps package.json, commits, tags and shows the release notes. It does not
# push; it prints the command that does (which starts the Release workflow).
#
#   npm run release                      # version from the commits
#   npm run release -- -m "Intro text"   # with an intro for the release notes
#   npm run release -- patch|minor|major|1.2.3
#
# The rules (DEPLOYMENT.md, "Publishing a release"):
#   fix: only                    -> patch
#   any feat:                    -> minor
#   feat!: / fix!: (breaking)    -> minor before 1.0, major from 1.0 on
#   nothing but docs/test/ci/... -> no release (name a bump to release anyway)
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { printf 'release: %s\n' "$*" >&2; exit 1; }

bump=""
intro=""
while [ $# -gt 0 ]; do
	case "$1" in
		-m) intro="${2:-}"; shift 2 ;;
		*) bump="$1"; shift ;;
	esac
done

[ "$(git branch --show-current)" = main ] || fail "release from main."
[ -z "$(git status --porcelain)" ] || fail "commit or stash your changes first."

current=$(node -p "require('./package.json').version")
last=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)
[ -z "$last" ] || [ "$last" = "v$current" ] || fail "package.json says $current but the last tag is $last."
subjects=$(git log --no-merges --format=%s "${last:+$last..}HEAD")
[ -n "$subjects" ] || fail "nothing since $last."

IFS=. read -r major minor patch <<<"$current"
if [ -z "$bump" ]; then
	if grep -qE '^[a-z]+(\([^)]*\))?!:' <<<"$subjects"; then
		bump=$([ "$major" -eq 0 ] && echo minor || echo major)
	elif grep -qE '^feat(\([^)]*\))?:' <<<"$subjects"; then
		bump=minor
	elif grep -qE '^fix(\([^)]*\))?:' <<<"$subjects"; then
		bump=patch
	else
		fail "no feat: or fix: since $last, so nothing for users. Name a bump (patch) to release anyway."
	fi
fi
case "$bump" in
	major) next="$((major + 1)).0.0" ;;
	minor) next="$major.$((minor + 1)).0" ;;
	patch) next="$major.$minor.$((patch + 1))" ;;
	[0-9]*.[0-9]*.[0-9]*) next="$bump" ;;
	*) fail "unknown bump: $bump (patch, minor, major or a version)." ;;
esac
git rev-parse -q --verify "refs/tags/v$next" >/dev/null && fail "v$next exists already."

npm version "$next" --no-git-tag-version >/dev/null
git commit -q -m "chore: version $next" package.json package-lock.json
if [ -n "$intro" ]; then
	git tag -a "v$next" -m "MineShell $next" -m "$intro"
else
	git tag -a "v$next" -m "MineShell $next"
fi

printf '%s -> %s (%s). Release notes:\n\n' "$current" "$next" "$bump"
scripts/release-notes.sh "v$next"
printf '\nTo publish: git push origin main v%s\n' "$next"
printf 'To undo before pushing: git tag -d v%s && git reset --hard HEAD~1\n' "$next"
