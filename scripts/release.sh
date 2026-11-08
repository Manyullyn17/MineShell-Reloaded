#!/usr/bin/env bash
# Prepares a release on main: picks the version from the commits since the last
# tag, bumps package.json, commits, tags and shows the release notes. It does not
# push; it prints the command that does (which starts the Release workflow).
#
#   npm run release                      # version from the commits
#   npm run release -- -m "Intro text"   # with an intro for the release notes
#   npm run release -- -F intro.md       # the intro from a file (Markdown, headings kept)
#   npm run release -- -N notes.md       # the whole notes from a file, no lists of their own:
#                                        # start from `scripts/release-notes.sh --draft > notes.md`
#   npm run release -- patch|minor|major|1.2.3
#   npm run release -- beta              # the next version's next beta: 1.1.0-beta.1, -beta.2, ...
#   npm run release -- --ignore-ci       # even though the last scheduled check failed (below)
#
# The rules (DEPLOYMENT.md, "Publishing a release"), counted from the last release (not beta):
#   fix: only                    -> patch
#   any feat:                    -> minor
#   feat!: / fix!: (breaking)    -> minor before 1.0, major from 1.0 on
#   nothing but docs/test/ci/... -> no release (name a bump to release anyway)
# After betas, `npm run release` without a bump releases the version they were betas of.
# It refuses while the last run of a scheduled check (nightly.yml, weekly.yml: what breaks
# without a commit) failed, read with gh, so a red result cannot go unnoticed.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { printf 'release: %s\n' "$*" >&2; exit 1; }

bump=""
intro=""
ignore_ci=no
while [ $# -gt 0 ]; do
	case "$1" in
		-m) intro="${2:-}"; shift 2 ;;
		-F) [ -f "${2:-}" ] || fail "no file ${2:-} for -F."; intro=$(cat "$2"); shift 2 ;;
		# Marked so release-notes.sh prints them as written (its NOTES_MARK).
		-N) [ -f "${2:-}" ] || fail "no file ${2:-} for -N."; intro="$(cat "$2")"$'\n\n<!-- release notes: as written -->'; shift 2 ;;
		--ignore-ci) ignore_ci=yes; shift ;;
		*) bump="$1"; shift ;;
	esac
done

[ "$(git branch --show-current)" = main ] || fail "release from main."
[ -z "$(git status --porcelain)" ] || fail "commit or stash your changes first."

# A run older than this many days: the schedule may be paused (60 days without activity).
scheduled_check() { # workflow, days
	local line conclusion created url
	line=$(gh run list --workflow "$1" --branch main --status completed --limit 1 \
		--json conclusion,createdAt,url --jq '.[0] | "\(.conclusion) \(.createdAt) \(.url)"' 2>/dev/null) ||
		{ printf 'release: could not read the runs of %s, so it was not looked at.\n' "$1" >&2; return 0; }
	[ -n "$line" ] || { printf 'release: %s has not run yet.\n' "$1" >&2; return 0; }
	read -r conclusion created url <<<"$line"
	[ "$conclusion" = success ] ||
		fail "the last $1 run ended $conclusion ($url). Look at it first, or release anyway with --ignore-ci."
	if [ $(( ($(date +%s) - $(date -d "$created" +%s)) / 86400 )) -gt "$2" ]; then
		printf 'release: the last %s run is from %s: is its schedule paused (Actions tab)?\n' "$1" "${created%T*}" >&2
	fi
	return 0
}
if [ "$ignore_ci" = no ]; then
	if command -v gh >/dev/null; then
		scheduled_check nightly.yml 3
		scheduled_check weekly.yml 10
	else
		printf 'release: gh is not installed, so the scheduled checks were not looked at.\n' >&2
	fi
fi

current=$(node -p "require('./package.json').version")
last=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)
[ -z "$last" ] || [ "$last" = "v$current" ] || fail "package.json says $current but the last tag is $last."
[ -n "$(git log --no-merges --format=%s "${last:+$last..}HEAD")" ] || fail "nothing since $last."
# The version is picked from everything since the last release, betas included: 1.1's betas
# and its release are all 1.1.0, whatever each beta brought.
stable=$(git describe --tags --abbrev=0 --match 'v*' --exclude 'v*-*' 2>/dev/null || true)
subjects=$(git log --no-merges --format=%s "${stable:+$stable..}HEAD")

IFS=. read -r major minor patch <<<"${stable#v}"
[ -n "$stable" ] || IFS=. read -r major minor patch <<<"${current%%-*}"
beta=no
[ "$bump" = beta ] && { beta=yes; bump=""; }
picked=no
[ -n "$bump" ] || picked=yes
if [ -z "$bump" ]; then
	if grep -qE '^[a-z]+(\([^)]*\))?!:' <<<"$subjects"; then
		bump=$([ "$major" -eq 0 ] && echo minor || echo major)
	elif grep -qE '^feat(\([^)]*\))?:' <<<"$subjects"; then
		bump=minor
	elif grep -qE '^fix(\([^)]*\))?:' <<<"$subjects"; then
		bump=patch
	else
		fail "no feat: or fix: since ${stable:-the start}, so nothing for users. Name a bump (patch) to release anyway."
	fi
fi
case "$bump" in
	major) next="$((major + 1)).0.0" ;;
	minor) next="$major.$((minor + 1)).0" ;;
	patch) next="$major.$minor.$((patch + 1))" ;;
	[0-9]*.[0-9]*.[0-9]*) next="$bump" ;;
	*) fail "unknown bump: $bump (patch, minor, major, beta or a version)." ;;
esac
# Running a beta of a version past the picked one (a minor's beta, then only fixes): that version.
if [ "$picked" = yes ] && [[ "$current" == *-* ]] && [ "$(printf '%s\n' "${current%%-*}" "$next" | sort -V | tail -n 1)" = "${current%%-*}" ]; then
	next="${current%%-*}"
fi
if [ "$beta" = yes ]; then
	if [[ "$current" == "$next"-beta.* ]]; then
		next="$next-beta.$((${current##*-beta.} + 1))"
	else
		next="$next-beta.1"
	fi
fi
git rev-parse -q --verify "refs/tags/v$next" >/dev/null && fail "v$next exists already."

npm version "$next" --no-git-tag-version >/dev/null
git commit -q -m "chore: version $next" package.json package-lock.json
if [ -n "$intro" ]; then
	# whitespace, not git's default strip: that drops every line starting with #, Markdown's headings.
	git tag -a --cleanup=whitespace "v$next" -m "MineShell $next" -m "$intro"
else
	git tag -a "v$next" -m "MineShell $next"
fi

printf '%s -> %s (%s). Release notes:\n\n' "$current" "$next" "$bump"
scripts/release-notes.sh "v$next"
printf '\nTo publish: git push origin main v%s\n' "$next"
printf 'To undo before pushing: git tag -d v%s && git reset --hard HEAD~1\n' "$next"
