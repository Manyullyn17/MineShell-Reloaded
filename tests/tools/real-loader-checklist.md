# Real-loader checklist

A manual pass over every loader on real downloads, before 1.0 and later releases. It runs on
the throwaway dev server (CLAUDE.md, "Trying things against real loaders"), never on real data,
and takes about 25 minutes, mostly downloads. Every step is a form action posted with
`act.mjs`, so a pass can be pasted; the page does the same.

Last pass: 2026-10-25 (before 1.0), all steps green on every loader. Found: a Quilt export
carried Quilt's remapped game jars (fixed), and `wait-start.sh` missing a Done line (fixed).

## Setup

```sh
tests/tools/devserver.sh start
A="node tests/tools/act.mjs"; U=http://127.0.0.1:5199
$A "$U/settings?/installUnit"
```

`boot <id>` below means: start it, wait for "Done (", stop it and wait until it has stopped:

```sh
boot() {
	$A "$U/instances/$1?/power" verb=start | grep message
	sleep 3; tests/tools/wait-start.sh "mstest@$1" 600
	$A "$U/instances/$1?/power" verb=stop | grep message
	until [[ $(systemctl --user is-active "mstest@$1") == inactive ]]; do sleep 2; done
}
```

One server at a time: every new server defaults to an 8 GB heap (16 GB before 1.1), and a start that would
overcommit memory asks first (the action answers with that question and starts nothing).
Tasks (installs, changes, imports) are listed by `curl -s $U/api/tasks`; wait until none
is `running` before the next step.

## The servers

Each starts one loader build behind the newest, on a Minecraft version with a newer one to
move to. Pick the builds from `curl -s "$U/api/loaders/versions?loader=<id>&mc=<version>"`
(newest first; Quilt's betas are listed first).

| Server | Minecraft | Loader, then | Move to |
|---|---|---|---|
| Vanilla | 1.21.1 | - | 1.21.4 |
| Fabric | 1.20.1 | one build back, then the newest | 1.21.1 |
| Quilt | 1.20.1 | one stable build back, then the newest stable | 1.21.1 |
| Forge | 1.20.1 | one build back, then the newest | 1.21.1 |
| NeoForge | 1.21.1 | one build back, then the newest | 1.21.4 |
| Forge Old | 1.12.2 | one build back, then the newest | Cleanroom (its own migration) |
| Cleanroom | 1.12.2 | one build back, then the newest | - |

## Steps

1. **Install**, with Java downloaded if missing:
   `$A "$U/instances/new?/loader" name=Fabric minecraftVersion=1.20.1 modloader=fabric modloaderVersion=<build> downloadJava=temurin acceptEula=on`
   - [ ] every install task `done`; `boot` each: "Done (" on every one
2. **Loader update** to the newest build:
   `$A "$U/instances/fabric/settings?/loaderVersion" modloaderVersion=<newest> snapshot=yes downloadJava=temurin`
   - [ ] `boot` each; the journal names the new build (`Fabric Loader <v>`,
     `--fml.forgeVersion, <v>`, `--fml.neoForgeVersion, <v>`, `cleanroom-<v>-universal`)
3. **Move** to the newer Minecraft version (Vanilla, Fabric, Quilt, Forge, NeoForge):
   `$A "$U/instances/fabric/settings?/migrate" minecraft=1.21.1 loader=fabric confirmMinecraft=on snapshot=yes downloadJava=temurin`;
   Forge Old to Cleanroom: `$A "$U/instances/forge-old/settings?/migrateCleanroom" snapshot=yes downloadJava=temurin`
   - [ ] `boot` each: "Starting minecraft server version <new>", the world loaded (no new
     spawn generation from scratch), a `-migrate` snapshot in `.mineshell/snapshots/`
   - [ ] Forge Old boots Cleanroom with Fugue and Scalar Legacy in `mods/`
4. **Export** with worlds, snapshots and logs:
   `$A "$U/instances/fabric/export/server?/export" worlds=on snapshots=on logs=on`
   - [ ] the zips (`/tmp/ms-test/tmp/server-exports/*/`) are about world + snapshots in size:
     no loader libraries, `versions/`, `.fabric-cache/`, `.cache/quilt_loader/`
5. **Import** each as a new server:
   ```sh
   id=$(curl -s -X PUT --data-binary @<zip> -H "origin: $U" "$U/api/imports?name=x.zip" | node -p 'JSON.parse(require("fs").readFileSync(0)).id')
   $A "$U/instances/new?/import" importId=$id name="Fabric Imported" acceptEula=on downloadJava=temurin
   ```
   - [ ] every import task `done`; `boot` each `<id>-imported`

## Afterwards

`tests/tools/devserver.sh clean` stops everything and removes the `mstest@` units and the data.
Note the date and anything found under "Last pass" above.
