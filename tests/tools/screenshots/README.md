# README screenshots

`npm run screenshots` redraws `docs/screenshots/*.png`, the pictures in the README, from a
throwaway MineShell with invented data. Run it after a change that alters a page shown there
and commit the new pictures with it (or on their own, `docs: ...`).

```sh
npm run screenshots                     # every shot, ~1.5 min
npm run screenshots -- overview mods    # only these
npm run screenshots -- --keep           # leave it running to look around: http://localhost:5198
npm run screenshots -- --cleanup        # end a --keep run
```

It uses its own data dir (`/tmp/ms-shots`, emptied first), port 5198 and unit prefix
`msshot`, so it never meets real servers or a `devserver.sh` server. It installs the
`msshot@` template unit and removes it, its drop-ins and its slice again afterwards (also
when a scene fails). It needs the network: some scenes take real names and icons from
Modrinth, and the page loads mod icons.

## The parts

- **`scenes.mjs`**: the world, as an ordered list of scenes, all run every time. `servers`
  (five servers, two running, tags), `history` (a day of CPU/memory samples, a week of runs
  and player sessions), `mods` (the pack server's mods from Modrinth). A scene gets a context
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

Players are invented names with offline-mode UUIDs (MineShell never looks those up, so no
skins: their faces are the locator-bar colours). Jars and region files are sparse: their
sizes look real and take no disk.

## What it cannot show (yet)

Uptime is a minute or so (the fake started just before), and Connect shows this machine's LAN
address. Pages that read real game files - the player editor, chunk and world maps, item
pictures - need a scene that writes those files (NBT, region files, the client jar for
pictures) before they can be added.
