#!/bin/bash
# The loader/version matrix the fixtures were recorded on. Instance ids are the
# ones created as described in README.md; change them to match yours.
R="$(dirname "$0")/crashrun.sh"
for inst in fabric-0.12-mc1.16.5 fabric-0.19-mc1.21.1 quilt-0.20-mc1.20.1; do
	$R $inst needsdep mstest-fabric-needsdep.jar
	$R $inst clientcode mstest-fabric-clientcode.jar
	$R $inst clientonlydep mstest-fabric-consumer.jar mstest-fabric-clientapi.jar
done
for inst in forge-1.12.2 cleanroom-0.4.4 cleanroom-0.5.17; do
	$R $inst needsdep mstest-legacy-needsdep.jar
	$R $inst clientcode mstest-legacy-clientcode.jar
done
for inst in forge-1.16.5 forge-1.20.1; do
	$R $inst needsdep mstest-forge-needsdep.jar
	$R $inst clientcode mstest-forge-clientcode.jar
done
$R neoforge-1.21.1 needsdep mstest-neo-needsdep.jar
$R neoforge-1.21.1 clientcode mstest-neo-clientcode.jar
