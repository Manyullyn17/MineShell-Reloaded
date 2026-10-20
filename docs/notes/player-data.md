# Player data

Hard-won facts that are not obvious from the code, moved out of CLAUDE.md (2026-10-20).
Keep them current: a change that makes one wrong updates it in the same commit.

## Player data
- `nbt.ts` reads/writes NBT losslessly (typed tags, compounds as ordered entries, longs as
  bigint, modified UTF-8). `playerdata.ts` edits `<world>/playerdata/<uuid>.dat` through edit
  operations (never a whole tree from the browser), so what the UI does not show survives.
- Item layout follows the file's DataVersion: <1519 Count+Damage, <3837 Count+tag, then
  count+components; 1.21.5+ (4325) armor/offhand in `equipment`, not Inventory slots 100-103/-106.
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
- SNBT: `lib/server/snbt.ts` parses (unquoted strings cannot hold `:`, as in Minecraft);
  `lib/shared/nbt.ts` prints and holds the browser-side tree types.
- Verified against real files for 1.21.1 (slimes-adventure; the user tested ATM10, NeoForge
  1.21.1) and 1.12.2 (the user tested MeatballCraft, Cleanroom), 2026-10-09; 1.21.11
  (components/equipment) tested by the user. Not yet on real files: the flat 1.13-1.20 format
  and versions below 1.12.2 (1.7.10's numeric ids only on the throwaway server's level.dat).
