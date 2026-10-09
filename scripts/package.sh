#!/usr/bin/env bash
# Packs a built MineShell (`npm run build` first) into the release archive
# dist/mineshell-<version>.tar.gz and its .sha256, as the Release workflow
# publishes them and scripts/install.sh installs them.
#
# The archive carries its runtime node_modules, so installing needs only Node:
# no npm, no compiler. better-sqlite3 ships prebuilt binaries for every platform
# in its package, so one archive works on x64 and arm64, glibc and musl.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(node -p "require('./package.json').version")
name="mineshell-$version"
stage="dist/$name"

test -f build/index.js || { echo "No build/index.js: run npm run build first." >&2; exit 1; }
rm -rf "$stage" "dist/$name.tar.gz" "dist/$name.tar.gz.sha256"
mkdir -p "$stage/scripts" "$stage/src/lib/server" "$stage/docs"

cp -r build "$stage/build"
cp package.json package-lock.json README.md LICENSE .env.example "$stage/"
cp scripts/setup.mjs scripts/doctor.mjs scripts/install.sh "$stage/scripts/"
# setup.mjs writes the template unit from the same module the app uses.
cp src/lib/server/unit-template.js "$stage/src/lib/server/"
cp docs/DEPLOYMENT.md "$stage/docs/"
echo "$version" > "$stage/VERSION"

# --ignore-scripts: `prepare` (svelte-kit sync) is a development step, and no
# runtime dependency needs an install script.
(cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

tar -C dist -czf "dist/$name.tar.gz" "$name"
(cd dist && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
rm -rf "$stage"
echo "dist/$name.tar.gz"
