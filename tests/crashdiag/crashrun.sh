#!/bin/bash
# Boot one MineShell instance with some crash-test mods and record the log.
#
#   MINESHELL_DATA=/path/to/test-data OUT=/path/to/logs ./crashrun.sh <instance-id> <case> <jar>...
#
# Uses the instance's own unit env file (Java, JVM and launch arguments), so the
# boot matches what systemd would run. Test jars are removed again afterwards;
# a copy of the mods folder is kept next to the log for capture.mjs.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
DATA=${MINESHELL_DATA:?set MINESHELL_DATA to a TEST data directory}
OUT=${OUT:?set OUT to a folder for the logs}
inst=${1:?instance id}; case=${2:?case name}; shift 2
I=$DATA/instances/$inst
ENV=$DATA/units/$inst.env
MS_JAVA=$(sed -n 's/^MS_JAVA=//p' "$ENV")
MS_JVM_ARGS=$(sed -n 's/^MS_JVM_ARGS=//p' "$ENV")
MS_LAUNCH_ARGS=$(sed -n 's/^MS_LAUNCH_ARGS=//p' "$ENV")
mkdir -p "$OUT" "$I/mods"
rm -f "${I:?}"/mods/mstest-*.jar
for j in "$@"; do cp "$HERE/testmods/jars/$j" "$I/mods/"; done
cd "$I" || exit 1
echo eula=true > eula.txt
sed -i 's/^server-port=.*/server-port=25899/; s/^enable-rcon=.*/enable-rcon=false/' server.properties
# shellcheck disable=SC2086 # word-split like the systemd unit does
timeout 150 "$MS_JAVA" $MS_JVM_ARGS $MS_LAUNCH_ARGS < <(sleep 110; echo stop) > "$OUT/$inst--$case.log" 2>&1
echo "$inst $case exit=$? reached-done=$(grep -c 'Done (' "$OUT/$inst--$case.log")"
mkdir -p "$OUT/$inst--$case.mods" && cp "$I"/mods/* "$OUT/$inst--$case.mods/" 2>/dev/null
rm -f "${I:?}"/mods/mstest-*.jar
