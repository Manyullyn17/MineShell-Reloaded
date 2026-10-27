# README screenshots

`npm run screenshots` redraws `docs/screenshots/*.png`, the pictures in the README, from a
throwaway MineShell with invented data. Run it after a change that alters a page shown there
and commit the new pictures with it (or on their own, `docs: ...`).

```sh
npm run screenshots                     # every shot, ~1.5 min
npm run screenshots -- overview mods    # only these
npm run screenshots -- --keep           # leave it running to look around: http://localhost:5198
npm run screenshots -- --serve          # only build the world and start its servers, no pictures (kept)
npm run screenshots -- --cleanup        # end a --keep or --serve run
```

It uses its own data dir (`/tmp/ms-shots`, emptied first), port 5198 and unit prefix
(`msshot` and four random hex digits, new each run, so the console's journal starts empty),
so it never meets real servers or a `devserver.sh` server. It installs that prefix's
template unit and removes it, its drop-ins and its slice again afterwards (also when a
scene fails; `--cleanup` removes any `msshot…` units). It needs the network: some scenes take real names, icons and pack files from
Modrinth and CurseForge, and pages load mod icons and search live.

## The parts

- **`scenes.mjs`**: the world, as an ordered list of scenes, all run every time. `servers`
  (five servers, tags; running: vanilla 26.3 and MeatballCraft on Cleanroom 1.12.2, both
  with the nightly restart; the Cobblemon pack on Fabric 1.21.1 stopped three hours ago, three
  releases behind the newest; Creative build on Fabric 1.21.11 crashed at its last start, with
  restart on crash off so it stays crashed), `history` (a day of CPU/memory samples, a week of
  runs and player sessions), `mods` (Cobblemon's mods: its installed pack version's own file
  list, named through Modrinth by hash; MeatballCraft's ~370 from CurseForge through the
  modpacks.ch mirror, with their real sizes; Creative build's from a recorded crash, below), `world` (Cobblemon's real world, Chunky and
  player files, below).
  A scene gets a context (`run.mjs`, `Context`): `ctx.server({...})`, `ctx.tag(name, ids)`,
  `ctx.mod(id, {...})`, `ctx.sparseFile(path, bytes)`, `ctx.fetchJson(url)`, `ctx.vars` (values
  for shot paths, such as the pack version a preview moves to) and the database itself
  (`ctx.db`, better-sqlite3) for anything else. Seeded times are relative to now.
- **The crash**: Creative build's fake prints a real crash's console output from
  `tests/crashdiag/fixtures` (Simple Datapacks needing Mod Menu, which a server leaves out as
  client-only) and exits 1, and its mods folder is that crash's own, as small jars holding
  just `fabric.mod.json` and the class names the diagnosis reads.
- **The world scene**: Cobblemon gets a real Minecraft 1.21.1 world (`worldgen.mjs`:
  Mojang's own server on seed 8675309 generates 32 x 32 chunks round spawn with `forceload`,
  saves and stops, about a minute and a half the first time), the real Chunky jar, the EULA
  tick with the client jar in place (map colours, item pictures), and player files written
  with MineShell's own `nbt.ts` (Node runs it as TypeScript): Bramblewick's inventory is full
  of enchanted gear, a stocked shulker box and blocks.
- **The pack change preview** hashes the jars a new version ships under the same name, so
  those are Cobblemon's real jars (about 30 MB); everything else is sparse. Downloads like
  these, the `.mrpack` files, Mojang's jars and the generated world are kept in
  `~/.cache/mineshell-screenshots/` between runs (delete it to start over).
- **`shots.mjs`**: one entry per picture: page (or a function of `ctx.vars` giving it), the
  text to wait for, size, an element to crop to, clicks or scripts first, a pause for live
  numbers. Options are those of
  `tests/tools/pageshot.mjs`. Theme: the default, Deep Slate.
- **`fakeserver.mjs`**: a running server without Minecraft. A server given `running: {...}`
  is pinned to a "Java" that runs this script (registered as Java 21) and is started through
  MineShell's own start action, under the real systemd unit. It prints a vanilla log (the
  console, joins, chat from `chat`), answers RCON's `list`, `list uuids` and `tick query`
  (TPS from `mspt`), holds `memoryMb` of memory and burns about `cpuPercent` of one core,
  so status, players, TPS and live graphs all come through MineShell's own code. With
  `crashLog` it prints that file and exits 1 instead (the crash above).
  The console's time column is the log's own `[HH:MM:SS]`, so the log tells the story of
  the uptime while printed at once: startup at the start time, players joining over the
  last hour and a half, chat lines at the gaps the scene gives (`[name, text, seconds after
  the line before]`); later lines (RCON, `say`) at real time.
  Before 1.13 (Forge, Cleanroom) it logs and answers the old way: logger names on every line,
  `forge tps`, "2/20 players online", a Forge mod-loading startup of `startSeconds`.
  `uptimeMinutes` makes it look started that long ago: MineShell's `systemctl` (only the
  throwaway server's, through `$DATA/bin/systemctl` first in its PATH) reports the unit's
  start time that much earlier, and the run it matches that with (`server_runs`, under the
  run's real invocation) is written with the same start and its "Done (" `startSeconds` later.
- **Visits** (`visits` in `shots.mjs`): pages opened once before the pictures, for what the
  browser does on a first visit (a pack server's overview gives it the pack's icon; each
  visit waits until the icon is saved, which from CurseForge took longer than a fixed pause).

Each server gets the files its loader installs (server jar, libraries; sparse) and a week
of gzipped logs, so its disk use is more than the world.
Players are invented names with offline-mode UUIDs (MineShell never looks those up, so no
skins: their faces are the locator-bar colours). Jars and region files are sparse: their
sizes look real and take no disk.

## What it cannot show (yet)

Connect shows this machine's LAN address. Players joined a minute ago (their sessions come
from the fake's log). The rendered world map (BlueMap) is not drawn: it needs a render of
the world first. A modded item's picture needs its real jar, which the scenes do not have
(the inventory holds vanilla items).
