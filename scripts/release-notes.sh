#!/usr/bin/env bash
# Release notes for a tag, as Markdown on stdout, for the Release workflow (and
# Settings > Updates, which shows them before updating):
#
#   scripts/release-notes.sh v0.2.1
#   scripts/release-notes.sh --draft > notes.md   # the next release's, from HEAD, to edit
#
# The tag's own message (beyond its first line) comes first, then the commits
# since the previous tag (for a release, the previous release: its betas are left out): feat: under "New", fix: under "Fixed", one line each
# from the subject. docs:, test:, ci: and chore: commits are left out.
#
# A tag made with `npm run release -- -N notes.md` carries its notes whole (NOTES_MARK):
# they are printed as written, comments taken out, with no lists of their own. --draft
# writes the lists for that file, leaving out a fix whose changed lines all came in after
# the last release: it fixed something this release added, which no release ever had. Those
# are named in a comment at the end, to put back by hand.
set -euo pipefail

NOTES_MARK='<!-- release notes: as written -->'
draft=no
[ "$1" = --draft ] && { draft=yes; set -- HEAD; }
tag="$1"
repo="${GITHUB_REPOSITORY:-Manyullyn17/MineShell-Reloaded}"
# A beta's notes are what changed since the tag before it (the last beta); a release's,
# everything since the last release, its betas' changes included. A draft is a release's.
if [ "$draft" = yes ]; then
	previous=$(git describe --tags --abbrev=0 --match 'v*' --exclude 'v*-*' HEAD 2>/dev/null || true)
elif [[ "$tag" == *-* ]]; then
	previous=$(git describe --tags --abbrev=0 --match 'v*' "$tag^" 2>/dev/null || true)
else
	previous=$(git describe --tags --abbrev=0 --match 'v*' --exclude 'v*-*' "$tag^" 2>/dev/null || true)
fi
range="${previous:+$previous..}$tag"

compare() {
	if [ -n "$previous" ]; then
		printf '**All changes:** https://github.com/%s/compare/%s...%s\n' "$repo" "$previous" "$tag"
	fi
}

intro=""
[ "$draft" = yes ] || intro=$(git tag -l --format='%(contents:body)' "$tag" | sed -e '/^-----BEGIN PGP/,$d')
if grep -qF "$NOTES_MARK" <<<"$intro"; then
	# Written by hand: as it is, without its comments (the draft's list of what it left out).
	grep -vF "$NOTES_MARK" <<<"$intro" | perl -0pe 's/<!--.*?-->\n?//gs; s/\n{3,}/\n\n/g; s/\s+\z/\n/'
	printf '\n'
	compare
	exit 0
fi
if [ -n "${intro//[[:space:]]/}" ]; then
	printf '%s\n\n' "$intro"
fi

# Every line commit $1 changed or removed (in src/, scripts/, migrations/) was written after
# the last release. Only adding lines, or only to new files, says nothing: not counted.
fixes_new_only() {
	local commit="$1" file start count changed=no old
	[ -n "$previous" ] || return 1
	while read -r file; do
		while read -r start count; do
			[ "$count" -eq 0 ] && continue
			changed=yes
			old=$(git blame --porcelain -L "$start,+$count" "$commit^" -- "$file" | grep -oE '^[0-9a-f]{40} ' | sort -u |
				while read -r line; do git merge-base --is-ancestor "$line" "$previous" && echo old; done)
			[ -z "$old" ] || return 1
		done < <(git diff -U0 "$commit^" "$commit" -- "$file" | sed -n 's/^@@ -\([0-9]*\)\(,\([0-9]*\)\)\{0,1\} .*/\1 \3/p' | awk '{ print $1, ($2 == "" ? 1 : $2) }')
	done < <(git diff --name-only --diff-filter=M "$commit^" "$commit" -- src scripts migrations)
	[ "$changed" = yes ]
}

line() { sed -n "s/^$1\(([^)]*)\)\{0,1\}: *//p" <<<"$2" | sed 's/^./\U&/; s/^/- /'; }
left_out=""
section() {
	local title="$1" prefix="$2" lines="" hash subject
	while IFS=' ' read -r hash subject; do
		[ -n "$hash" ] || continue
		if [ "$draft" = yes ] && [ "$prefix" = fix ] && fixes_new_only "$hash"; then
			left_out+="$(line "$prefix" "$subject") (${hash:0:7})"$'\n'
		else
			lines+="$(line "$prefix" "$subject")"$'\n'
		fi
	done < <(git log --no-merges --reverse --format='%H %s' "$range" | grep -E "^[0-9a-f]+ $prefix(\([^)]*\))?:")
	if [ -n "$lines" ]; then
		printf '## %s\n\n%s\n' "$title" "$lines"
	fi
}
section New feat
section Fixed fix

if [ "$draft" = yes ]; then
	if [ -n "$left_out" ]; then
		printf '<!-- Left out: fixes of what this release added (all the lines they changed came in after %s).\n%s-->\n' "$previous" "$left_out"
	fi
	exit 0
fi
compare
