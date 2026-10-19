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
scene fails; `--cleanup` removes any `msshot…` units). It needs the network: some scenes take real names and icons from
Modrinth, and the page loads mod icons.

## The parts

- **`scenes.mjs`**: the world, as an ordered list of scenes, all run every time. `servers`
  (five servers, tags; running: vanilla 26.3 and MeatballCraft on Cleanroom 1.12.2; the
  Cobblemon pack on Fabric 1.21.1 stopped three hours ago), `history` (a day of CPU/memory samples, a week of runs
  and player sessions), `mods` (Cobblemon's mods from Modrinth, MeatballCraft's ~370 from
  CurseForge through the modpacks.ch mirror, with their real sizes). A scene gets a context
  (`run.mjs`, `Context`): `ctx.server({...})`, `ctx.tag(name, ids)`, `ctx.mod(id, {...})`,
  `ctx.sparseFile(path, bytes)`, `ctx.fetchJson(url)` and the database itself (`ctx.db`,
  better-sqlite3) for anything else. Seeded times are relative to now.
- **`shots.mjs`**: one entry per picture: page, the text to wait for, size, an element to
  crop to, clicks or scripts first, a pause for live numbers. Options are those of
  `tests/tools/pageshot.mjs`. Theme: the default, Deep Slate.
- **`fakeserver.mjs`**: a running server without Minecraft. A server given `running: {...}`
  is pinned to a "Java" that runs this script (registered as Java 21) and is started through
  MineShell's own start action, under the real systemd unit. It prints a vanilla log (the
  console, joins, chat from `chat`), answers RCON's `list`, `list uuids` and `tick query`
  (TPS from `mspt`), holds `memoryMb` of memory and burns about `cpuPercent` of one core,
  so status, players, TPS and live graphs all come through MineShell's own code.
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
  browser does on a first visit (a pack server's overview gives it the pack's icon).

Each server gets the files its loader installs (server jar, libraries; sparse) and a week
of gzipped logs, so its disk use is more than the world.
Players are invented names with offline-mode UUIDs (MineShell never looks those up, so no
skins: their faces are the locator-bar colours). Jars and region files are sparse: their
sizes look real and take no disk.

## What it cannot show (yet)

Connect shows this machine's LAN address. Players joined a minute ago (their sessions come
from the fake's log). Pages that read real game files - the player editor, chunk and world maps, item
pictures - need a scene that writes those files (NBT, region files, the client jar for
pictures) before they can be added.
