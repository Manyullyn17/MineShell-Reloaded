# Player data

Hard-won facts that are not obvious from the code, moved out of CLAUDE.md (2026-10-20).
Keep them current: a change that makes one wrong updates it in the same commit.

## Player data
- `nbt.ts` reads/writes NBT losslessly (typed tags, compounds as ordered entries, longs as
  bigint, modified UTF-8). `playerdata.ts` edits `<world>/playerdata/<uuid>.dat` (`players/data/` from Minecraft 26) through edit
  operations (never a whole tree from the browser), so what the UI does not show survives.
- Item layout follows the file's DataVersion: <1519 Count+Damage, <3837 Count+tag, then
  count+components; 1.21.5+ (4325) armor/offhand in `equipment`, not Inventory slots 100-103/-106.
  26.3 (5023) is read as it is: items, enchantments, equipment and stats checked on the user's
  own player file (2026-10-29); only the folders moved.
  Before 1.8 (no DataVersion, server version < 1.8) ids are shorts: `itemids.ts` reads them as
  names through FML > ItemData (`\u0002` = item, `\u0001` = block) or vanilla 1.7.10's fixed
  table, and writes numbers back (`idTag`); an id the world lacks is refused (a string id
  loads as nothing in 1.7). 1.7.10 Forge server for trying things: see the 1.7.10 notes.
- Names for player files (`profiles.ts`): usercache, whitelist, ops and ban lists, then Mojang's
  sessionserver (`/session/minecraft/profile/<uuid>`; 204 = no such account), cached in
  `cache/profiles.json` (names 30 days, misses 1 day), at most 60 per page load, streamed to
  the Players page. Version-3 UUIDs are offline-mode (MD5 of "OfflinePlayer:<name>"): never asked.
- Faces (`PlayerFace.svelte`): the skin's texture id comes with the profile (base64
  `textures` property; found profiles kept 2 days), the PNG through `/api/skins/<id>` into
  `cache/skins/` (an id never names another image). Drawn on a canvas as the game does: face
  opaque, hat over it, except an old 64x32 skin with no transparent pixel in its hat area gets
  none (the game's "Notch transparency hack" - Notch's own skin is black there). No skin:
  the locator bar's colour, `ARGB.setBrightness(ARGB.color(255, uuid.hashCode()), 0.9f)` (the
  name's String.hashCode when only the name is known), read from the 26.3 client's
  `LocatorBar` and checked on 200 UUIDs against the game's own ARGB (`locatorcolor.ts`).
- An online player is never written (the server overwrites on logout): `list uuids`, or
  `list` + usercache.json; unknown names, RCON down or an unparseable answer refuse. A file
  that changed since it was read (sha1) is refused. Backups in
  `.mineshell/playerdata-backups/<uuid>/`, one per 10-minute session, newest 10.
- Removing a player (Players > Manage, `removePlayerFiles`): player file, `.dat_old`, stats,
  advancements and MineShell's backups go to the Files trash; mods' per-player data elsewhere
  stays. Refused while online (the server writes them back on leaving).
- Names and lore (`playeritems.ts`, `mctext.ts`): custom names and lore are italic in game unless
  their text says otherwise (`italic: false`); 1.12 makes them italic whatever they say. So JSON
  and NBT text without `italic` reads as `§o`, and MineShell writes inside a non-italic root: an
  anvil name edited keeps looking italic, typed text is not. A 1.21.5+ name written as a plain
  string tag (what MineShell wrote before 1.3) shows italic. NBT lists hold one type: lore with
  mixed strings and compounds cannot exist, the converter writes compounds throughout.
- `playeritems.ts`: item fields (name, lore, enchantments, unbreakable, durability) per format
  (legacy/flat/components, and 1.21.5's NBT text and plain enchantment map), and item lists:
  known ones (BlockEntityTag.Items, minecraft:container `{slot,item}`, bundle contents) plus any
  list whose entries all look like items (mod backpacks, Trinkets/Curios). A new entry copies the
  shape of the list's existing ones; `{Items, Size}` (Forge item handlers) uses int slots.
- Curios (NeoForge 1.21, ATM10): `neoforge:attachments` > `curios:inventory` > `Curios`, a
  list with one entry per slot type (`Identifier: "ring"`, `StacksHandler` > `Stacks`/`Cosmetics`
  > {Items, Size}): 21 types, 42 lists. Lists inside one list's entries form a `group`, each
  named by the entry's Identifier/id/name; the page shows a group as one closed section.
- `enchantnames.ts`: 1.12 enchantment numbers are per world (Forge's table in level.dat,
  FML > Registries > minecraft:enchantments > ids {K, V}); a vanilla world has none. Display
  names: vanilla built in (its 1.12 lang keys like enchantment.damage.all follow no rule),
  mods from en_us.lang (also en_US, also disabled jars) by guessed keys, else from the id.
- `playerfields.ts`: built-in fields as path candidates (first that exists wins), effects (the
  existing entries' style beats DataVersion: mods leave old-form lists), and user-mapped fields
  (`player_fields` table, per server, copied on clone) - greyed with Remap/Remove when the path
  is gone or holds another type.
- An effect lasting forever is duration -1 only from 1.19.4 (DataVersion 3337). Before it
  an effect ends once its duration is not above 0, so -1 vanished on the next tick: older
  files get 2147483647 ticks (`foreverTicks`), read back as forever too.
- SNBT: `lib/server/snbt.ts` parses (unquoted strings cannot hold `:`, as in Minecraft);
  `lib/shared/nbt.ts` prints and holds the browser-side tree types.
- Verified against real files for 1.21.1 (slimes-adventure; the user tested ATM10, NeoForge
  1.21.1) and 1.12.2 (the user tested MeatballCraft, Cleanroom), 2026-10-09; 1.21.11
  (components/equipment) tested by the user. Not yet on real files: the flat 1.13-1.20 format
  and versions below 1.12.2 (1.7.10's numeric ids only on the throwaway server's level.dat).
- Reading an online player (vanilla 1.21.1 and 1.21.11 with a headless client joined,
  2026-11-08): `data get entity <name> <field>` answers `<name> has the following entity data:
  <SNBT>` (with spaces: `{pos: [I; 10, 70, -20], forced: 1b, ...}`), `Found no elements matching
  <field>` for one it lacks, `No entity was found` for nobody. `respawn` (1.21.5+) and
  SpawnX/Y/Z/SpawnDimension/SpawnForced (before) exist only once a spawn point is set; a
  /spawnpoint one is `forced`. Dimension is a string from 1.16, a number (0, -1, 1) before. `tp`
  with whole numbers centres x and z on the block (10 -> 10.5).
- A bed or anchor spawn point is the block's position (a bed's head), not where the player
  stands: the game looks for a spot beside it only when they respawn. Teleporting on top of a bed
  in a room two blocks high puts their head in the ceiling (the user, 2026-11-08), so MineShell
  asks first: `execute in <dim> unless block x y z minecraft:air unless block ...` per block
  (feet, head, and a floor under spots beside). Over RCON a passing test answers `Test passed`,
  a failing one `Test failed` on 1.21.1 but nothing at all on 1.21.11, a chunk that is not loaded
  `That position is not loaded` (common: a bed far from everyone), an unknown block name
  `Unknown block type ...` for the whole command (so only names every version from 1.13 has).
  Unloaded chunks are read from the region file instead (`savedBlocks`, world.ts): the server
  saved them when it let them go. Probed on vanilla 1.21.1 and 1.21.11, 2026-11-08;
  `tests/fixtures/regions/bed-1.21.11.mca` is 1.21.11's chunk with a bed under a low ceiling.

## NBT editor (Files)
- What NBT files look like on real servers (`tests/tools/nbt-sweep.ts`, the four dev servers,
  2026-11-08, 3,921 files): 2,471 gzipped and 144 plain `.dat`, 931 gzipped and 8 plain `.nbt`
  (Open Parties and Claims writes plain), none zlib, none with bytes after the root tag, every one
  written back byte for byte (gzipped ones compared unpacked: gzip's own bytes differ). 189 `.dat`
  files are empty and 173 are not NBT at all (RedstoneEther's maps, JEI's ItemFavorites, AE2's
  compass): the first byte rules most out, the whole-file parse the rest.
- Sizes: ATM10's `level.dat` holds 230,000 tags (FML's registries; about 10 MB as JSON), 23 files
  over 100,000; Twilight Forest's structure caches reach 39 MB unpacked and 2.7 million tags.
  Parsed, a 19 MB file took 280 MB of heap and 2 s to write: hence the 8 MiB limit and the
  partial tree.
- The player editor's error class is the tree edits' (`PlayerDataError` is `NbtEditError`), so
  its messages and `instanceof` checks are unchanged.
