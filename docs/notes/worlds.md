# Worlds, snapshots and maps

Hard-won facts that are not obvious from the code, moved out of CLAUDE.md (2026-10-20).
Keep them current: a change that makes one wrong updates it in the same commit.

## World snapshots, world tools, clones
- Snapshots live in `<server>/.mineshell/snapshots/<id>/` (world folders at their relative
  paths + `manifest.json`), assembled as `<id>.partial` and renamed when complete; recovery
  deletes partial ones. Worlds = `level-name` plus `_nether`/`_the_end` siblings if present.
- The operations take `opts.snapshot` (default false, so tests and other callers opt in);
  routes decide it with `decideSnapshot(instance, form.get('snapshot'), { moves })`, which enforces the
  policy server-side (`-1` = never ask, always snapshot). The step runs first inside the
  journalled `try`, so a failed copy fails the operation before anything moves.
- Reset/replace/restore (`world-change` journal) move the old world straight into the new
  snapshot (rename, no copy); the snapshot is finished before the commit, so a crash after
  commit cannot lose it. Rollback reads from `aside` or, if already finished, `keepAs`.
- Recovery never runs leftover cleanup for a server whose recovery failed: its originals
  are in exactly the folders cleanup deletes.
- Clone: `beingCopied` (in memory) blocks start/requireStopped on the source during the copy.
- World upload is a raw-body PUT to `/api/instances/[id]/world`, not a form action (form
  bodies are buffered whole). Production needs `BODY_SIZE_LIMIT=Infinity` (adapter-node's
  default is 512 KB, which also broke jar/pack uploads); dev has no limit.
- Several worlds (built 2026-10-15, user's calls in ROADMAP-ARCHIVE): the active world is
  `level-name`; switching moves no world, only BlueMap's `web/` (swapped with the arriving
  world's kept one) and properties. Snapshots carry `world` and restore only onto it
  (manifests before 0.17.3 are judged by folders). `worlds.ts` must stay free of heavy
  imports: packchange.ts uses it, and instances.ts -> packchange -> worlds -> instances
  would be a cycle. Per-world records: `.mineshell/worlds.json` (copied with clones).
  Only keys present in server.properties are saved per world: an empty `level-type=` is
  not the default to every version.

## Shared files between snapshots
- Built 2026-10-22 (ARCHITECTURE, "Worlds"). Measured on a throwaway copy of MeatballCraft's
  world (7.1 GB, 4893 files, warm page cache, stopped): the first snapshot took 14.3 s (12 s as
  a plain copy before; hashing what it copied), the next with nothing changed 9.2 s, with three
  region files changed 8.7 s; three snapshots took 7.2 GB instead of 21. A live snapshot keeps
  saving paused for as long, so the hashing is time with saving off.
- Sizes walk every file of every snapshot (by inode): 50 snapshots of a 5000-file world were
  250,000 lookups, 3.1 s one at a time, 1.3 s side by side. The lists are kept in
  `$DATA/cache/snapshot-files/<server>/<snapshot>@<folder inode>.json` (snapshots never change),
  so after a restart the World tab answered in 0.2 s instead of 1.5.
- `du` counts a hard-linked file once per run, so `du -sh .mineshell/snapshots` shows the real
  use; per snapshot folder it shows each in full when measured one at a time.
- Copies that leave the server folder become full again: a backup copy (plain or zip), the
  export with snapshots, `cp -r`. No damage; a copied-back snapshot keeps its `hashes.json`,
  and from a plain backup its times too, so it can be linked to again; from a zip the times
  differ and it is only copied from.
- The free-space check before a snapshot counts what it would add (`snapshotNeeds`): files whose
  size and time match the newest snapshot's records would be links. Size alone is not enough:
  region files grow in 4 KB steps, so a changed one often keeps its size; the game sets the
  time on every write. Records keep times to the millisecond (utimes), live files finer, hence
  the 1 ms tolerance. Nothing is hashed, since page loads ask.
- If linking fails (a file system without hard links, too many names), the file is copied.

## Snapshot retention
- Policy (`snapshots.ts`): newest `keepMin` full / `partialMin` partial always stay, more
  newest-first while all kept fit in `budgetMb` and each type is under its max; pinned are
  outside it. Global row `snapshots.policy`, per-server overrides `snapshots.policy:<id>`
  (only the fields set). An old `{keep}` row reads as `keepMin`. Applied when the next
  snapshot is taken, not on saving settings.
- `minFreeMb` (5 GB): a snapshot that copies the world is refused when it would leave less
  free (`fs.statfs`); the form then offers only "continue without". World-tab operations pass
  `moves: true`: they keep the old world by renaming it, which costs no space.

## Backup copies
- `backups.ts` (built 2026-10-22; ARCHITECTURE, "Backup copies"). Tried on the throwaway dev
  server only, with folders on ext4 under /tmp, so every one there warns "same disk as the
  servers". exFAT/NTFS USB drives and NFS/SMB shares are untried: `fs.cp` there sets times
  (`preserveTimestamps`) and may hit permission or name limits.
- Backup folders may not be inside MineShell's data folder (or contain it), so a test's folder
  goes beside the worker's data folder (`tests/flows/backups.test.ts`), not in `tempDir()`.
- The sync after a snapshot waits 15 s (debounced per server), and longer while the server has
  an operation: a world change's snapshot is finished before its commit.
- Measured 2026-10-22 on a throwaway copy of MeatballCraft (Cleanroom 1.12.2, 7.1 GB world,
  NVMe, nobody online, files mostly in the page cache): stopped, a snapshot took 12 s and its
  backup copy 10 s; running, "Snapshot now" took 21 s (save-off, 5 s of quiet, the copy) and
  the backup copy was done 28 s later (15 s wait, ~13 s copy). Mean tick time went from ~3.1
  to ~3.6 ms during both copies, TPS 20 throughout. A cold cache or a USB drive is slower;
  not measured.
- Region files deflate about 37% smaller although their chunks are compressed (the padding to
  4 KB sectors, mostly): 40 of MeatballCraft's, 143 MB, at gzip -1 and -6 alike, ~80 MB/s on
  one core. Hence compressed backup copies use level 1 for region files; the world download
  still stores them (`STORED` in world.ts), where time matters more than size.
- MeatballCraft ships AromaBackup, which zips the whole world at every start ("the server may
  lag for a bit", 2 minutes) and kept 24 GB of zips in `backups/`: a pack's own backup mod
  doubles what snapshots and backup copies do.

## Scheduled snapshots
- `snapshotschedule.ts`, from the scheduler tick (dev server restart needed after changes).
  "Every N hours" on the clock (user's call, 2026-10-09; the map schedule shares it). Skip-
  when-idle on by default (user's call; the hint warns about chunk-loaded farms). Restarts and
  snapshots wait for each other (ARCHITECTURE, Worlds).
  Live mode tried on the throwaway vanilla 1.21.1 server: save-off, chunks saved, copy after
  5 s of quiet files, save-on - 5 s in all. 1.12 Forge's `save-all flush` and its async chunk
  writer only reasoned about (the quiet wait is for it); stop mode only in tests.
- Simple Voice Chat (`voicechat.ts`): its UDP port is checked before a start and given out
  free to copies and pack installs (the user's dev copies of irithyll/slimes stopped at start:
  the real irithyll holds 24454; dev copies moved to 24455/24456, 2026-10-10). playit: a UDP
  tunnel per server (`voiceTunnelId`) and its address in `voice_host`; only tested against the
  faked API - the first real try is the user's.
- Port 25565 is taken on this machine: irithyll, migrated into the installed MineShell
  (`mineshell@irithyll-go-brrr`, 2026-10-16; it ran outside MineShell before). Tests that
  call start() need their own ports, and a dev server sees it as "something else".

## Dimensions, pruning, data packs
- `dimensions.ts` finds dimensions as folders (region/ or entities/ inside): DIM-1/DIM1,
  1.12 DIM<n> and named mod folders, `dimensions/<ns>/<name>`, Bukkit siblings. The
  overworld is its region/entities/poi only. World changes take `moving` paths; a snapshot of
  some folders is `partial: true` and restores only those.
- Pruning reads InhabitedTime (top level 1.18+, Level.* before); a pruned chunk goes from
  region/, entities/ and poi/ alike, and files are rewritten (zeroing the header frees nothing).
  Live: 45 MB -> 8 MB on a pre-generated 1.20.1 world, which then loaded and regenerated.
  Since 2026-10-18 an analysis comes first (heatmap, threshold marks chunks live, protect on
  the map; ARCHITECTURE, "Worlds"); a prune removes only chunks that analysis marked.
- Removing a world-generation data pack from a world that loaded it stops the world loading
  (level.dat's generation settings name its biomes); MineShell refuses unless confirmed.

## Chunk map and chunk restore
- Built 2026-10-17 (World > Restore chunks; ARCHITECTURE, "Worlds"). RoughlyEnoughIDs/JEID
  1.12 sections (MeatballCraft) carry a `Palette` int array of `id << 4 | meta`; Blocks/Add/
  Data hold the palette index split the way vanilla splits a state, so index =
  `(add << 12) | (blocks << 4) | data` (checked on 6921 real sections: always in range).
- Chunks nobody loaded since an update keep old block names (1.21.11 irithyll still has
  `minecraft:grass`): `RENAMED` in chunkmap.ts. Vanilla 1.12 variants (granite = stone 1)
  come from the item table, not the blockstate's key order (`blockLook`).
- Minecraft's own blocks need the client jar for their colours (per-server EULA tick, as
  item pictures; without it `VANILLA_COLOURS` gives rough ones). The user's dev irithyll had
  no tick, which looked like a tint bug (grey grass and leaves). Testing
  needs a server folder with a world: copy one from a real server (read only) into the
  throwaway dev server's `instances/` after `seed-instance.mjs`.

- Generation status (`Status`, Level.Status before 1.18): from 1.18 the chunks round anything
  loaded are saved partway (structure_starts, biomes; nearer in carvers, initialize_light,
  features with blocks and trees). Chunky's 500-block square on the user's 1.21.11 irithyll
  left 4225 full chunks and about 3300 partial ones out to ~9 chunks further. Only `full` is
  finished: the map dims the rest (`partial` and `bare`).

## World map
- `worldmap.ts`, Map tab. 1.13+: BlueMap 5.28 CLI (`-c config -r -v <mc> -n mods/`), config
  rewritten before every render into `$DATA/maps/<id>/`, web app served statically by
  MineShell (`.gz` + Content-Encoding, 204 for missing tiles/live). Needs Java 21+.
  `accept-download` only after the per-server EULA tick (also for the BlueMap mod: without it
  the mod draws nothing, so a mod from a pack gets its own EULA panel on the Map tab). BlueMap's web app paths are
  relative: its pages need the trailing slash (`trailingSlash = 'ignore'` + own redirect).
- 1.12.2 Forge/Cleanroom: Dynmap + DynmapBlockScan (live, in the game); uNmINeD fails on
  RoughlyEnoughIDs worlds. Mod web servers get `modPort` + 127.0.0.1 written before each
  start; `/maps/<token>/live/` proxies. Tested: MeatballCraft with both mods (renders, black areas
  gone with BlockScan); the proxy against a fake Dynmap server; BlueMap CLI on the throwaway
  server and a copy of ATM10. On plain Forge 1.12.2 (14.23.5.2859) Dynmap 3.7-beta-6, the
  newest 1.12.2 build, crashes at start (`IllegalAccessError` on `Biome.field_76791_y`; FML
  also cannot read its `META-INF/versions/9` classes), so Forge gets the newest build but
  that (`DYNMAP_NOT_ON_FORGE`): 3.7-beta-4 and 3.5 were booted and run, 3.7-beta-4 checked
  through the live map. Cleanroom keeps 3.7-beta-6 (MeatballCraft runs it). The BlueMap mod needs Fabric API on
  Fabric, which a pack usually brings: it is installed with it when no enabled jar declares the
  dependency's slug as its mod id (`installRequiredMods`; tried on a bare Fabric 1.21.1 server).
- The map's sandbox (2026-10-21, ARCHITECTURE "The map's pages are not MineShell's"),
  checked in headless Chrome against a real BlueMap render, a running BlueMap mod and a running
  Dynmap (map, controls, web chat reaching the game): in a
  sandboxed frame (opaque origin) `localStorage` and `document.cookie` throw, and BlueMap
  writes localStorage unguarded (marker visibility, every setting) while Dynmap uses a cookie,
  so both need the shim. Only the frame's own navigation carries the session cookie; every
  request its page makes goes without, hence the token in the path. BlueMap's
  `<script type="module" crossorigin>` needs CORS. Dynmap's jQuery takes the sandboxed page's
  address for its own and adds `X-Requested-With` to every request, so each one is preflighted
  (OPTIONS) and the preflight has to allow that header - allowing only `content-type` left
  Dynmap black, its configuration never loaded; its chat posts JSON. `window.name` is readable in the sandbox and set by the parent before load: the
  shim's way in for saved storage. Panning, the URL hash and the full-screen page work as before.
  `tests/tools/pageshot.mjs --drag` pans a map (real input, reaches into the frame).
