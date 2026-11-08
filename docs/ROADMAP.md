# Roadmap

Open work only: planned, later, undecided and rejected ideas, with the reasoning behind the
decisions. This is not a schedule. Built features, with their notes and decisions, are in
[ROADMAP-ARCHIVE.md](ROADMAP-ARCHIVE.md); when an entry here is built, it moves there and
whatever it leaves out stays here.

## Current direction

Versions (user's calls, 2026-10-16 and 2026-10-30): 1.0 came out 2026-11-01 (its checklist,
"Road to 1.0", is in ROADMAP-ARCHIVE). 1.1.0 came out 2026-11-03; 1.2 is next (below). After it maybe a few minor additions,
then plugin servers (Paper and Purpur) as the first major update, 2.0; not before. GT New Horizons also
has an agreed install-flow plan. None of this has a delivery date.

Releasing (user's calls, 2026-10-30 and 2026-11-01; DEPLOYMENT, "Publishing a release", bound
by "What 1.x keeps" there): `next` held the features for after 1.0 and is merged into `main`;
work stays on `main`, and a branch comes back only for 2.0's breaking work. A candidate is a
beta (`1.1.0-beta.N`, a GitHub pre-release that installs only with "Offer betas too" on);
fixes go out as the next beta, and the release follows after about three days on the real
install with nothing big. A fix for the release before meanwhile goes on a `release/1.0`
branch from its tag. Fixes are batched, at most one release a day.

1.1's scope (user's call, 2026-10-31): what was on `next`, plus servers that are really
sandboxed and quoted JVM arguments (one template change for both), the Minecraft versions a
loader has builds for, sorting the mods list by its headers, a paused server's header showing
a running pre-generation and moving a server to an older Minecraft (all built, ROADMAP-ARCHIVE).
The other leftovers of those features (Cancel for version moves and loader changes, database
copies to a backup folder, CurseForge data packs, zipping chosen files, Chunk Pregenerator)
are extensions and wait.

Release guide from 1.2 on (user's call, 2026-11-03: a guideline to keep releases a reasonable
size, not a fixed list; entries move and get added along the way):
- **1.2**: built - uploaded and CurseForge-only jars identified, names and versions from the
  jar, joining over Tailscale, data packs on a version move, data pack loaders changing,
  dropping into a folder in Files, the Data packs tab showing what loader mods read (with an
  upload), looking again when a CurseForge key is set, game mode and teleport for online
  players, game rules, world spawn and border (the four 1.21.9 settings back in Settings),
  server.properties coverage (LZ4 chunks included), the Remote access follow-ups.
- **1.3** (user's call, 2026-11-08; may grow, what joins is decided on the way), in this
  order: the Fugue gaps and Java builds (both built 2026-11-08); formatted text (colour codes) with the server list
  preview, also for item names and lore (built 2026-11-08); the mod config editor (the headline, built 2026-11-08); the NBT editor
  (wanted in 1.3 even if it makes the release larger; built 2026-11-08); more for online players (built 2026-11-08) anywhere in
  between. At the end if there is room, else 1.4: maintenance mode, the server resource pack,
  Add mods choosing a data pack's folder. Scheduled CI near the end or whenever convenient
  (not MineShell's own code).
- **1.4 or later**: schedules (step 6), diagnosis and copies (step 7), then GT New Horizons,
  item icons and the status page as ordered below. Whenever convenient: Chunk Pregenerator,
  single files from a snapshot.

After 1.1 (user's calls, 2026-10-21 to 2026-10-27): everything under "Later", in the
suggested order of its steps: upkeep and quick wins, files, mod configs, world, players,
schedules, diagnosis and copies, GT New Horizons, item icons, the status page. Then plugin
servers as 2.0. Accounts and permissions are covered well enough that nothing more is planned
for them (user's call, 2026-11-01); item icons get what is still fairly easy, since the user
likes the feature, though most of what it could do is done.

Portability notes: arm64 and musl (Alpine) are not tested (user's calls, 2026-10-18 and
2026-10-21: no such hardware here, and a home server is nearly always x64). What depends on
them is only what MineShell downloads for a machine: Java builds (`javadownload.ts` picks
x64/aarch64 and glibc/musl) and playit.gg's agent. A Java added by path works on any of them,
and better-sqlite3 in the release archive carries prebuilt binaries for all four.

---

## Planned

### Plugin servers (Paper, Purpur)

Asked about 2026-10-08; written up rather than built (user's call). Planned as the next big
update, once the modded and general features are finished. What it would take:

- **Server types**: Paper and Purpur as entries in `modloaders.ts`, installed as one jar
  (`-jar server.jar`, like vanilla). Paper's builds come from PaperMC's download API (Fill,
  `fill.papermc.io/v3`; the old `api.papermc.io/v2` is being retired), Purpur's from
  `api.purpurmc.org/v2/purpur/<mc>`. Both to be checked against the live APIs when built.
- **A Plugins tab** instead of Mods: `plugins/` with enable/disable (`.disabled`, which
  Paper ignores like Forge does), install and update from Modrinth (loaders `paper`,
  `purpur`, `spigot`, `bukkit`, `folia`) and Hangar (PaperMC's own repository). SpigotMC
  (through Spiget) is the biggest catalog but many downloads are external links or paid:
  later, if at all.
- **What already works on them**: RCON, the console, players, history, snapshots and the
  World tab (Bukkit keeps `world_nether`/`world_the_end` as siblings; `dimensions.ts` and
  snapshots already handle that), scheduled restarts, the Java table (same as vanilla).
- **What needs work**: TPS (Paper has `tps`, not `tick query` on older versions), crash
  diagnosis (plugin stack traces name plugins, not mods; crashdiag only knows mod jars),
  the pack install form (no plugin packs), the migration (a plugin server moves by
  swapping the jar; plugins mostly survive a Minecraft update).
- **Hybrids** that load Forge/NeoForge mods and plugins together (Mohist, Arclight, Youer):
  first judged not worth it (fragile with big packs, and every crash becomes "is it the
  hybrid"); reopened 2026-11-04 as research, Undecided, "Legacy versions, more loaders and
  hybrids".

---

## Later

After 1.0 and before 2.0 (plugin servers). A suggested order (2026-10-27; the user asked for
one so there is a place to start after 1.0; any step can move): steps by theme, each a few
entries that share code, the cheapest and most needed first. A step is not a version:
finished `feat:` commits are gathered into a minor every few days or more (DEPLOYMENT,
"Publishing a release"), not released one by one as in 0.x. Within a step, entries are
in the order to build them where one needs another.

1. **Upkeep and quick wins**: TypeScript 7 (waits for Kit); servers that are really
   sandboxed and quoted JVM arguments built 2026-10-31 (two sandbox tests left, Leftovers). Small, mostly reading what MineShell already has: a calm first
   step after the freeze.
2. **Files**: built (the better file editor, search in files, earlier versions of edited
   files, zips and folders); the NBT editor (built 2026-11-08, ROADMAP-ARCHIVE).
3. **Mod configs**: the mod config editor, on step 2's editor, search and file history.
4. **World**: game rules, world spawn and border, with the per-world game settings left from
   "Several worlds" (Leftovers); single files from a snapshot.
5. **Players and how the server shows itself**: game mode and teleport for online players
   (built), shared player lists, the server list preview (built), the server resource pack, maintenance mode
   (which changes the description the preview shows); joining over Tailscale, wanted for 1.2
   (user's call, 2026-11-02), so built first whatever step is under way.
6. **Schedules**: hours a server runs, on the scheduler that restarts today, and one view of
   everything scheduled, which then includes them.
7. **Diagnosis and copies**: where a stuck server hangs, the change history per server, then
   bringing a copy's changes back (the largest; the history's record of what changed helps it).
8. **GT New Horizons** as its own install option (user's call, 2026-10-27).
9. **Item icons and names**: the leftovers of that name (Leftovers), a whenever thing given
   this slot (user's call, 2026-10-27): right after GT New Horizons, which brings more 1.7.10
   item work anyway.
10. **The status page**, once its open questions are answered; it reuses step 5's rendering
    of the description and icon.

The other leftovers are picked up when their area is worked on. Undecided entries, if
agreed, join the step of their area (the management server step 5), the rest wherever they
fit. Steps 1, 5 and 6 took in undecided entries the user agreed to on 2026-10-27.

### 1. Upkeep and quick wins

#### TypeScript 7

Waits until after 1.0 (user's call, 2026-10-21, with the minor dependency updates done
before the freeze). Development tooling only: check that svelte-check and Kit work with it
before switching.

Tried 2026-10-28 (TypeScript 7.0.2, in a scratch worktree): not yet possible. Its package is
the native compiler with no JavaScript API (`require('typescript')` has only `version`), and
Kit's `svelte-kit sync` reads tsconfig.json through that API, so `npm run check`, `dev` and
`build` all fail ("Cannot read properties of undefined (reading 'readFile')"). Kit 3 declares
`typescript: ^6.0.0` and svelte-check 4.7.7 `^5 || ^6`; `tsc --noEmit` alone runs. Check
again when Kit and svelte-check list 7 in their peer ranges.

#### Scheduled CI

Agreed 2026-11-06, after 1.2. The tests take about 7 s and run offline, so a scheduled run is
not for what is too slow for a push: it is for what can break without a commit. In this order:
1. **Real APIs**: API code replays recorded responses, so Modrinth, CurseForge, the mirror or a
   loader's metadata changing shape leaves CI green. Call the real ones and check the shape,
   nightly (the only part that needs to be).
2. **A real server on real systemd**: boot vanilla, then stop, Force stop and a crash, weekly.
   `--kill-whom=all` passed its mocked test and failed on a real unit, and the RCON deadlock
   took a real server. First check that GitHub's runners allow user units.
3. **Repeated tests**: 20 runs in shuffled order, weekly. Shared workers (`isolate: false`) make
   order bugs real: a fake clock left on stalled other test files.
4. **Ubuntu versions**: installer, `doctor` and smoke test on 22.04 and 24.04, weekly, since
   `ubuntu-latest` can move.

`page-sweep.mjs` (overflow, page errors) could join in. Property-based tests belong in the normal
suite (`snbt.ts`, NBT, zip: a parser bug can damage player data), with more random seeds on the
schedule. Mutation testing only by hand now and then, on critical files (access policy, path
safety). Not wanted: pixel diffs (they flag every intended UI change), benchmarks (shared runners
vary too much).

For one person: weekly unless there is a reason for nightly, `npm run release` warns or refuses
when the last run failed so a red result cannot be missed, and GitHub pauses schedules after 60
days without repo activity.

#### Mods from outside Modrinth's hash lookup

Asked for 2026-10-29. Uploads, CurseForge fingerprints, names and versions from the jar and
looking again when a key is set built 2026-11-03 (ROADMAP-ARCHIVE, "Identifying uploaded and
CurseForge-only jars"). Left:
- DynmapBlockScan updates: it is on no catalog. dynmap.us/builds/DynmapBlockScan/ is a plain
  directory listing with builds per Minecraft version and a `.MD5` beside the newer ones;
  1.12.2 has 3.6 (2023) and 3.7-beta-6 (2025-01-09) besides the 3.4-beta-1 MineShell
  installs, so the update check could read it. Before offering or installing a newer one:
  boot it with Dynmap on Forge 1.12.2 (where Dynmap beta-6 itself does not load) and on
  Cleanroom, and check modded blocks are still drawn.

### 2. Files

All built (ROADMAP-ARCHIVE: the file editor, search in files, earlier versions, zips).

### 3. Mod configs

Built 2026-11-08 (ROADMAP-ARCHIVE, "Mod config editor"); what it leaves is under "Leftovers of
built features".

### 4. World

#### Game rules: what is left

From "Game rules, world spawn and border" (built 2026-11-03 with the four 1.21.9 settings back
in Settings, ROADMAP-ARCHIVE): the spawn picked on the chunk map; on 1.21.9+ the management
server (Undecided) could list and set rules with types.

#### Pre-generation before 1.16 (Chunk Pregenerator)

Asked for 2026-10-29 (user: something for 1.12.2). Chunky starts at 1.16, so 1.12.2 and
Cleanroom servers only get the reason on World > Pre-generate. Speiger's Chunk Pregenerator
(CurseForge 267193) covers Forge 1.7.10 to 1.21.1: the same tab with it as a second
backend (install, start with shape/centre/radius from the planner, progress, stop). To find
out first, on its 1.12.2 jar: the command syntax (`/pregen ...`), whether it answers over
RCON, how it reports progress and keeps tasks across restarts, and whether its radius is
in chunks or blocks. Whether it is worth it for one Minecraft version is open.

#### Single files from a snapshot

Agreed 2026-10-27. A snapshot can be restored whole, by dimension, by chunk, or a player's
data, but not one file: a mod's file in `world/data/`, one region file, `level.dat`. A
snapshot browsed like Files, with "restore this file" (and folder); what it replaces goes
to the trash. Files the running server writes (region files, `level.dat`) only with it
stopped, as other world restores.

### 5. Players and how the server shows itself

#### Shared player lists

Agreed 2026-10-27. Whitelist, ops and bans are per server, so someone running several
servers for the same group adds each player everywhere. A shared list (named, in MineShell's
settings) that servers follow: adding or removing there applies to each following server,
over RCON while it runs and to its JSON file while stopped, as the Players tab already does
for one. To decide: whether a following server can still have its own extra entries, and
what joining a list does with the entries a server already has.

#### Formatted text: what is left

From the server list preview and formatted text (built 2026-11-08, ROADMAP-ARCHIVE): more
places that hold Minecraft text, on the same model and input (`mctext.ts`,
`FormattedTextInput.svelte`): `resource-pack-prompt` (JSON text) with the resource pack work,
`pack.mcmeta` descriptions on the Data packs tab (shown only), the status page. The preview's
widths are exact for the bitmap fonts' 2413 glyphs; others (CJK, emoji) come from Unifont and
are guessed (9 wide or 6), so a description in them may break a word early or late.

#### Server resource pack

Nothing yet (user, 2026-10-26: long meant to, never mentioned): the pack is only reachable as
extra `server.properties` keys (`resource-pack`, `resource-pack-sha1`,
`require-resource-pack`, `resource-pack-prompt`, `resource-pack-id` on newer versions).
Typed fields in the server's settings, with MineShell downloading the pack once to work out
the SHA-1 (and again when the URL changes), and the prompt as text. To check: which keys
each Minecraft version reads (the prompt and `require-resource-pack` came in 1.17).

Split in two (user's call, 2026-11-08):
1. **Now (1.3 if there is room)**: a resource pack browser like the mod browser (Modrinth's
   and CurseForge's resource packs, for the server's Minecraft version), and the server
   points players at the catalog's own download: `resource-pack` is the file's URL and
   `resource-pack-sha1` comes from the catalog (Modrinth lists a sha1 per file; CurseForge's
   file hashes include one). MineShell hosts nothing. A URL typed by hand stays possible, for
   packs on other sites or the owner's own file hosting; then MineShell downloads it once for
   the SHA-1. A missing download URL does not stop CurseForge (checked 2026-11-08): the API
   gives none for projects that opted out of third-party downloads, but the file's CDN path
   follows from its id and name (`curseforgeCdnUrl`), as pack installs and mods already use;
   give players `mediafilez.forgecdn.net` directly, since `edge.forgecdn.net` only redirects.
   Whether pointing clients at an opted-out project's file is fine is the user's call (mods
   are already downloaded that way). A pack found but with no usable file is still listed,
   with a note saying CurseForge gives no download for it, so a search for it does not just
   come up empty (user, 2026-11-08). To check: whether the modpacks.ch mirror lists resource
   packs (searching without a key; as for CurseForge data packs, unchecked), and the update
   check (a newer pack version means a new URL and SHA-1, so clients download it again). If
   CurseForge has no good way in, Modrinth alone first and CurseForge once a way is found.
2. **Later**: MineShell hosting an uploaded pack, for custom packs no catalog has. The hard
   part of the whole feature: it needs an address players' clients can reach over HTTP
   (playit.gg does not carry HTTP; a port forward or Tailscale only reach some players), so
   it is left until it is worth that.

Settings' `initial-enabled-packs` and `initial-disabled-packs` are one long string of data pack
ids: functional, not nice (user, 2026-11-05). Revisit them with this work, as a list to pick from.

#### Maintenance mode

Agreed 2026-10-27 (was undecided). One switch that turns the whitelist on, kicks whoever is
not on it with a message, and changes the description to say so; off puts all three back.
For pack updates and other work players should stay out of.

With pack changes (2026-11-08, a note, not a must): a "maintenance mode during this" tick on
a pack change or version move. A pack change already stops the server, and nobody sees a
stopped server's description, so it only helps work done with the server running (before the
stop, or checking the result before letting players back in).

#### More for online players

From the 1.2 beta's in-game check on Irithyll (user, 2026-11-07); the spawn point, game mode and
dimension built 2026-11-08 (ROADMAP-ARCHIVE). Left:
- **The player page while they are online**: the editor refuses then (the game writes the file
  over it). What has a command could work live instead: game mode first, then XP, health,
  giving or clearing items. Arbitrary edits cannot: vanilla refuses `data modify` on a player.

### 6. Schedules

#### Hours a server runs

Agreed 2026-10-27 (was undecided). Started and stopped on a schedule (only evenings, off
overnight); the scheduler only restarts today. Fits beside scheduled restarts, with the same
delay while players are online.

#### One view of everything scheduled

Agreed 2026-10-27 (was undecided). Upcoming restarts, snapshots, map renders and scheduled
commands across all servers in one list, showing what runs tonight and where heavy jobs of
different servers land at the same time.

### 7. Diagnosis and copies

#### Where a stuck server hangs

Agreed 2026-10-27. Stuck detection says a server stopped ticking, not why. `heap.ts`
already speaks the JVM's attach protocol (`GC.heap_info`); `Thread.print` the same way gives
a thread dump, taken when a server is found stuck (and kept with the run). The server
thread's stack usually names the mod's package it hangs in, so the stuck notice can say
"stuck in <mod>" (packages mapped to jars as the crash diagnosis does) with the same
one-click disable. To check: a dump of a big modded server is several MB, and a JVM too
far gone may not answer the attach at all (then as today).

#### Change history per server

Agreed 2026-10-27. One timeline per server, for "it crashes since yesterday, what
changed?": mod installs, updates and removals, config saves, settings changes, pack and
loader changes, Minecraft migrations, beside its crashes, restarts and starts. The Activity
page has the actions, but for all servers and without the runs; history has the runs. A
crash diagnosis could point at the changes made since the last clean run.

#### Bringing a copy's changes back

Agreed 2026-10-27. "Copy server" is for trying changes safely, but nothing carries the
result back: the owner redoes it on the original by hand. A comparison of a copy with the
server it was copied from (mods added, removed, updated or disabled; config and other text
files changed, as diffs; settings and `server.properties`), with the chosen changes applied
to the original after a snapshot, as one journalled operation. Needs the copy to remember
its original (and when it was copied, to tell what changed on which side); a change made on
both sides is shown, not overwritten, as the config merge does for pack updates.

### 8. GT New Horizons

#### GT New Horizons as its own install option

Agreed (2026-10-07), not started. GTNH's own docs say to take server files only from
`gtnewhorizons.com/downloads` (its wiki, "Server Setup"); the downloads page calls
CurseForge and Technic "not recommended, provided for convenience" (Prism is recommended
for clients). MineShell's pack browser would today build a server from the CurseForge
listing (project 252507, on the mirror up to 2.8.4 and 2.9.0-RC-2): the client pack, on
Forge 1.7.10, so Java 8 only. The official server pack has a Java 17-25 variant, which GTNH
recommends for performance, and server and clients must run the exact same GTNH version.

Shape: a fourth card on the first step of Add a server, next to Modpack / Upload / Mod
loader: "GT New Horizons". Picking it never enters the Modrinth/CurseForge flow, so the
browser needs no GTNH special case. Its step 2 lists GTNH versions (stable, and betas
behind a toggle) and the Java variant (17-25 by default, 8 offered); step 3 is the usual
configure step.

Work it needs:
- **Version list**: the server zips are
  `downloads.gtnewhorizons.com/ServerPacks/GT_New_Horizons_<version>_Server_Java_<range>.zip`,
  but the folder listing answers "not found". The docker-minecraft-server image
  (`TYPE=GTNH`, `GTNH_PACK_VERSION=latest|latest-beta|2.8.1`) resolves versions somehow;
  read how before choosing (a page to scrape, a JSON in GTNH's GitHub, or their releases).
- **Install**: the official server zip is already a server (its own Forge 1.7.10 and
  libraries), so it unpacks rather than going through a loader install. The rejection of
  CurseForge server packs below does not apply: this is one known, maintained layout, and
  the pack's official route.
- **Java 17+ launch**: lwjgl3ify's setup: `java9args.txt` and `lwjgl3ify-forgePatches.jar`
  (`@java9args.txt -jar lwjgl3ify-forgePatches.jar nogui`), a new launch shape for
  `isLoaderInstallEntry` and Java planning (needs 17+, not 8 as Forge 1.7.10 would say).
  The Java 8 variant is a plain Forge 1.7.10 server.
- **Updates**: GTNH's update steps replace mods and configs and keep the world, which is
  what a pack version change does already (`old-configs/`); it needs the version list as
  its source and GTNH's notes on files to delete (the wiki lists ones to remove when
  switching to Java 17+). The docker image keeps old configs in `gtnh-upgrade-<date>` folders.
- **Client side**: the client pack export has nothing to add here; GTNH clients install
  from GTNH (Prism zip). The server page could link the matching client download.
- **Map**: GTNH's own Web Map (its Dynmap fork, tuned for 1.7.10 mods) comes with this
  option (ROADMAP-ARCHIVE, "A map of the world").

### 9. Item icons and names

The "Item icons and names" leftovers (Leftovers of built features), picked up in any
step when convenient; this slot is where they are done at the latest. Nothing is built before
1.1's testing is done (user's call, 2026-11-01). Analysed 2026-11-01, from the code, the client
jars (1.12.2-26.3) and `npm run check:icons` on MeatballCraft (with `--world`: 414k stacks,
7% without a picture) and ATM10:

- **First, one change everything below except the code-only variants needs**: icons are
  asked for and kept by id and damage only (`iconKey`, `iconsFor`'s memo, the browser's
  `drawn` map). Heads, banners, shields and filled-in names depend on the stack's own NBT or
  components. `describeItem` (playeritems.ts, which knows all three formats) would add a small
  `look` to ItemView (skin, patterns, base colour, the strings a name template needs); the
  page passes it with the icon request, the endpoint checks it (lengths, a pattern list of at
  most 16, ids by regex), and it becomes part of the key. The picker has no stacks and stays
  as it is. The same channel would also carry what is not on the leftovers list but common in
  a world: potion colours and names (3020 potions and 208 tipped arrows in MeatballCraft's
  world; needs the effect colour table from the game's code), 1.12's one spawn egg with its
  `EntityTag` (501), dyed leather (214, `display.color` / `dyed_color`). Each is small once the
  channel is there.
- **Player heads' own skins (easy, after the channel)**: 1.12 `skull` damage 3 with
  `SkullOwner` (a compound, or only a name), 1.13-1.20.4 `SkullOwner`, 1.20.5+ the
  `minecraft:profile` component; 26.x's `ResolvableProfile` also has a partial/dynamic form and
  a skin `patch` that names a resource texture instead. The texture id comes out of the base64
  `textures` property the way `profiles.ts` `skinTexture` reads it, and `/api/skins/<id>`
  already fetches and caches the PNG: the browser's `textureUrl` sends a `skin:<id>` ref there.
  `headIcon('player')` takes the skin in place of Steve. Missing pieces: the old 64x32 skins'
  opaque hat (the hack `PlayerFace.svelte` already does, needed in the renderer too); a head
  with an id but no textures gets the default skin the game picks by uuid hash (26.3: 9 names x
  wide/slim in `entity/player/`; before 1.19.3 Steve or Alex); a name alone needs a name lookup
  MineShell does not make yet (Steve until then). Its name, "Notch's Head", is the lang
  template `block.minecraft.player_head.named` / `item.skull.player.name` filled with the
  profile's name. MeatballCraft's world has 3 player heads: rare there, common on servers
  with head drops or decorative head packs, which carry their own textures and work the same.
- **Banner patterns on banners and shields (medium)**: `bannerIcon` already draws the cloth with
  the base colour as a tinted layer; patterns are more layers of the same box, textures
  `entity/banner/<name>` and `entity/shield/<name>`. Stored as `BlockEntityTag.Patterns`
  `[{Pattern: "bri", Color: n}]` up to 1.20.4 (short codes: a table of about 40 from the
  game's code; check whether 1.12's `Color` counts from black like its dye damage or from
  white like 1.13+), then the `minecraft:banner_patterns` component (`{pattern, color}`, the
  pattern an id or, 1.21+, an inline `{asset_id}` from a data pack: draw what has a texture,
  skip the rest). Shields add a base colour (`BlockEntityTag.Base`, later
  `minecraft:base_color`) over `entity/shield_base`. The textures changed format in 1.15: up to
  1.14 they are opaque grey, brightness = coverage; from 1.15 white with alpha = coverage. The
  renderer's `mask` only works on flat icons, so 1.12-1.14 need a "brightness as alpha" step
  for a quad's texture (in the browser, when the image loads). MeatballCraft's world: 76
  banners and 183 shields, most plain; the ominous banner is the common patterned one.
- **Lang templates' filled-in text (small, per mod)**: names with gaps ("… Vis Crystal").
  MeatballCraft has 26 such items, ATM10 372, but only a few matter in a world: Thaumcraft's
  vis crystal (3910 stacks in MeatballCraft's world; the gap is the aspect key from NBT,
  capitalised: `Aspect.getName()` is `capitalizeFully(tag)`, so "Aer Vis Crystal", while
  `tc.aspect.aer=Air` is only the tooltip's description; add-on aspects work the same way,
  MeatballCraft has seven Thaumcraft add-ons, Thaumic Additions with 9 aspects of its own, the
  test case), botany's pigments, Electroblob's Wizardry scrolls (the spell by damage),
  Tinkers' casts and patterns, Forge's filled bucket (`FluidName`), Thaumcraft phials. In ATM10
  one rule names 314 of the 372: Theurgy's `<key>.source` sibling holds the text for its one
  gap. Sophisticated Storage's wood type is NBT (`wood_name.sophisticatedstorage.<wood>`). So:
  the vanilla player head, the Theurgy sibling rule, and a short table of per-mod fillers that
  read the stack's NBT, each checked against its mod's jar; the picker keeps the "…".
  Names only, not colours: the crystals share one texture the mod tints per aspect in code
  (`Aspect`'s colour per aspect), and add-ons bring their own aspects, so a colour table would
  never end. The tooltip's name tells them apart; the picture stays the untinted crystal.
- **1.12 variants only the mod's code names (hard in general, a heuristic covers much)**: the
  damage -> variant name map is in the mod's classes. Immersive Engineering's `ItemMaterial`
  lists `stick_treated, stick_iron, ...` in damage order in its constant pool, exactly the files
  in `models/item/material/`; Botania keeps `manaPearl, manaDiamond, ...` in `LibItemNames`
  (camelCase of its snake_case textures). So: find, in the mod's classes, the longest run of
  string constants that name its model or texture files (case and `_` ignored), and take its
  order as the damages, flagged as a guess like the other variant guesses. AE2 (ae2-uel)
  gives its damages in the enum's constructor, with gaps: needs reading `<clinit>`'s bytecode,
  or a table. Damage values cannot change without breaking worlds, so a table, once right,
  stays right through a mod's updates. Worth it by MeatballCraft's world: Actually Additions
  6771 stacks (jam, crystals, misc), Botania 12413 (but 9961 are mushrooms whose guess is
  right), IE 2494, AE2 1415. Mekanism is not in MeatballCraft; Advanced Rocketry 11 stacks.
- **Not on the list, for scale**: the most stacks without any picture in MeatballCraft are
  models drawn in code by mods (Blockcraftery 5237, Forestry 2966, the Betweenlands 2358,
  Extra Utilities 2 2118). Those are beyond what reading jars can do; leave them.

Order when built: the channel with player heads (the smallest whole piece), then banners and
shields, then the name fillers and potions/eggs/leather as wanted, the class-reading
heuristic last.

### 10. The status page

#### Status page

Optional, off by default, for players without an account (accounts already cover users):
the owner turns it on per server and ticks what it shows. Parked (user's call, 2026-10-18)
with the open questions below; the user is thinking them over. After 1.0 (user's call,
2026-10-21).

Proposal (not agreed):
- **Where it lives**: (A) a path on MineShell's own port, `/status/<server>`: least work,
  fine on the LAN or a tailnet, but sharing it on the internet exposes the panel, against
  the LAN-only stance. (B, recommended) a second listener on its own port, off until turned
  on in MineShell settings, that serves only the status pages (no login, forms or panel
  routes): plain server-rendered HTML refreshed by a few lines of JS, safe to forward or
  put behind a proxy. playit.gg's HTTP/TCP tunnels are premium, so a free account shares it
  by port forward or Tailscale.
- **Fields, ticked per server**: status (online / starting / offline / "sleeping, join to
  wake it"; a crash only reads offline), MOTD with colours and the icon, player count; off
  by default: player names with faces (privacy), TPS, uptime and the next scheduled restart.
  On by default also version (Minecraft, loader, pack) and address (playit's, else typed in;
  voice chat's too). An owner's notice in free text ("down for the update until 8 pm").
- **Client pack download** (makes it the join page): the owner builds the export once (Mods
  tab's export) and publishes it; the page serves that file with short join steps for Prism,
  the CurseForge app and Modrinth, and says when the server's pack is newer than the export.
  Never built per visit (heavy, and anyone could set it off).
- **Details**: one URL per server plus an optional index of enabled ones; a ~15 s server-side
  cache so visitors cause no RCON traffic; its own simple light/dark look, phone first.
  Maybe a JSON of the same ticked fields beside each page (for a Discord bot or a website):
  the page's own data, not the rejected REST API.
- **Later**: a public map (BlueMap is behind the login), join history, player stats.

Open questions: A or B; are those field defaults right (names off); client pack download
in the first version or later; the JSON or not.

### Leftovers of built features

What the built entries in the archive left out, in one place. Picked first (user,
2026-10-29), in this order: restoring the database from the page, the pruning ones and cancelling
an install or pack change with a rollback (all built 2026-10-29), then backing up a whole
server with progress and Cancel for a copy. Other backup destinations wait: which to support
is open, and each needs a test setup.

- **Limits on going back**: the last 0.x, once gone back to from 1.x, offers the older betas
  again; it could refuse going below itself once its database has seen 1.x (optional). The
  release candidate can be that last 0.x, so going back lands on a tested release.
- **MineShell's database copies**: copying them to a backup folder along with the snapshots.
- **playit.gg**: dedicated IPs and custom domains (set up on playit.gg); adopting tunnels
  made on playit's dashboard (listed, left alone).
- **NBT editor**: zlib-wrapped files (none found on the dev servers; `parseNbt` reads gzip and
  plain only); files over 8 MiB unpacked (structure caches); chunks inside region files and
  structures inside jars; a link from World > Game rules to `level.dat`; a search that filters
  the tree in place, as the player editor's does, instead of a list of matches. Changing the
  running world (user, 2026-11-08: nice some day, read-only is fine for now): only what has a
  command could go live, as game rules do over RCON (`time set`, `weather`, `difficulty`); a raw
  edit cannot, the server saves over it. The same as the player page while online (More for
  online players).
- **Mod configs**: FTB's SNBT configs (`config/ftb*.snbt`, comments above keys, typed
  numbers like `0.0d`; about ten files a pack; FTB Quests' `.snbt` quest book is data, not for
  this form); JSON configs that are
  a list at the top (whitelists), now text only; YAML and `.properties` configs. A list of
  objects or an inline table is edited as its text, not field by field.
- **Data packs**: CurseForge data packs (a separate class, "Data Packs", the mod browser
  does not search; the mirror's coverage of it is unchecked). Add mods choosing a data pack's
  folder (user's call, 2026-11-06: after 1.2): it always installs to `world/datapacks`, and
  tracking assumes that folder in install, listing, removal, updates and version moves, so a
  loader folder needs a folder column on `instance_datapacks` and all of those; untracked
  installs would stop updating without saying so. Uploading on the tab reaches every folder.
- **Item icons and names**: 1.12 mod damage variants whose model names only the mod's code
  maps (AE2 material/part, IE metal, Botania manaresource; user's call: decide later), names
  a mod links to its id only in code (advancedrocketry:advrocketmotor is tile.advRocket),
  variants that exist only in code (Actually Additions crystals, Mekanism basic blocks),
  lang templates' filled-in text, banner patterns on banners and shields, player heads' own
  skins (analysed: Later, step 9).
- **Files**: packing chosen files into a zip in place; unpacking other archives (`.tar.gz`,
  `.7z`); a diff between earlier versions of a file, and versions following a rename.
- **World map**: a map for pre-1.13 versions other than 1.12.2 (GTNH's: Later, step 8).
- **Installer and updates**: installing Node for the user (the installer says how to get
  it), installing updates automatically.
- **Server export and import**: data packs, resource packs and other files from Modrinth are
  carried, not linked (only mods/ jars are); not tried for real with a CurseForge pack or a world of
  gigabytes.
- **Client pack export**: a pack icon (none of the formats has a place both launchers read),
  CurseForge fingerprint lookups to link manually added jars in a CurseForge pack (needs the
  official API key), packwiz.
- **Snapshots**: a scheduler hook running a script after a snapshot. Shared files: snapshots
  made by moving the world (world changes) have no hash records, so the next copied one cannot
  link to them; an export with snapshots and a backup copy hold each snapshot in full.
- **Backup copies**: destinations other than a folder (rclone, S3-compatible, SFTP: more
  stores in `backups.ts`); the rest of a server (mods, configs) beside its worlds, so a lost
  server comes back from the folder alone (today: make it again, copy a backup back, use it as
  the world); a backup folder in New server defaults; a copy of a server does not take over its
  source's backup setting; no progress within one copy, and no Cancel. exFAT/NTFS drives and
  NFS/SMB shares not tried (only folders on ext4).
- **Restoring chunks**: a setting for other map controls (user's call, 2026-10-17: kept
  open; built is drag to pan, click to toggle, Shift/Ctrl-drag). Map colours: blocks a mod tints in code
  (Forestry/ExtraTrees leaves, Tinkers' slime grass and molten metals) are grey or untinted, and so are ones
  whose model only the mod's code names (Chisel's variants); the overview is chunk
  presence only, not shaded by InhabitedTime as first planned.
- **Cancelling tasks**: only the ones listed in ARCHITECTURE ("Cancelling") can be; a pack
  change waits for a loader installer under way (the installer is not stopped), and Minecraft
  moves and loader changes outside a pack change have no Cancel.
- **Cancel stops a loader installer** (user's call, 2026-11-02; no version yet). Cancel waits
  for the installer to finish: on a fresh install of ATM10 that was most of 39 s, NeoForge's
  installer pulling a few hundred MB of libraries. A pack install could kill the installer's
  process at once (nothing of the server is kept); a pack change could too, since its old
  loader files are in the journal and the change is put back from it either way - to check
  first that a half-written `libraries/` is among what the rollback restores or removes.
- **Undoing a version move**: a Minecraft or loader move has no undo once it is done (its
  rollback only runs when the move fails); going back is moving again and, for a kept world,
  its snapshot. A one-click rollback of the last move, as a pack change has (user, 2026-11-02:
  a future feature, no version yet).
- **The servers' sandbox** (ROADMAP-ARCHIVE, "The servers' sandbox", with its test list): a
  broken or missing AppArmor profile not tried (the user manager should still start, `doctor`
  warn, a server fail with `226/NAMESPACE`), nor a non-Ubuntu system (a Debian or Fedora VM).
  Keeping a server from signalling MineShell or another server needs a PID namespace
  (`PrivatePIDs=`, systemd 257; Ubuntu 24.04 has 255).
- **Dimension names**: Forge's answer is only asked while the server runs (no boot to ask).
- **Roofs on the map**: decided per region, so a region at a roofed dimension's edge with too
  few columns under the roof shows its surface; a free height slider (caves anywhere) was
  talked about, 2026-10-18, not built.
- **Pruning chunks**: the terrain view is a second read (the user's call, 2026-10-18: a fast heatmap-only
  analysis, terrain only for the regions looked at).
- **Several worlds**: difficulty, gamemode, hardcore and other game settings per world
  (user's call: server settings for now, maybe later); the BlueMap mod's live map was not checked
  after a switch (Dynmap names its worlds by folder).
- **Pausing empty servers**: nothing for versions before 1.21.2 (a mod per loader, not
  researched).
- **Player stats**: read only (no editing or resetting), no history over time; 1.12 mob
  names come from lang files (no pictures for mobs); pre-1.8 numeric ids and achievements are
  shown raw or left out (not checked on a real world). Stats on the status page, once that is
  decided.
- **Old and optional world formats** (found 2026-10-29, after 1.0): servers before 1.7.6 keep
  their lists as `ops.txt`, `white-list.txt`, `banned-players.txt` (names, one per line) and
  players as `world/players/<name>.dat`, so the Players tab's lists and the player editor are
  empty there (checked on vanilla 1.6.4 with `mc-probe.mjs`); their log is `server.log` beside
  the server, with "<name>[/ip] logged in" for joins (the Logs tab and join detection are
  unchecked on it).
- **Update availability**: pack versions, loader builds and (servers without a pack) mods
  are checked periodically (`updatecheck.ts`); a newer build of a downloaded Java shows in
  MineShell settings (Java) only, with no notification (built 2026-11-08). Pack
  servers are not offered loader builds or single mod updates (the pack picks them; user's
  calls).

---

## Undecided

Suggested, not yet confirmed or rejected:

- **A player's in-game `/stop`** (user, 2026-11-06: would be nice, a bit difficult to do well):
  MineShell holds its RCON commands back from any stop it sends, because a command reaching a
  stopping server hangs it for good (`docs/notes/runtime.md`). It cannot see a `/stop` typed in
  the game coming, so its polling can still meet one, and the stuck banner does not show either:
  MineShell does not know the server is stopping until Stop is pressed. Reading "Stopping
  server" from the console stream would close most of it, but only after the race has started.

- **For public setups only** (suggested 2026-11-01, after the security pass): a notification
  on a sign-in from an unknown address, two-factor sign-in. (The other Remote access
  follow-ups were built: ROADMAP-ARCHIVE, "Remote access follow-ups".)

- **One place for in-app messages** (user, 2026-11-04, during the 1.2 beta: revisit, not
  planned yet): three kinds of message today. The green/red banner under a page's header
  (`Flash`, a form's answer, gone after a few seconds), the toasts at the bottom right (a
  task finished, from the task stream) and the bell's list at the top right (notifications
  and tasks). The banner pushes the page down while it is there. To decide: which messages
  go where, whether a form's answer becomes a toast, and what the bell keeps.
- **When the way out of a major is offered** (user, 2026-11-04: revisit when 2.0 comes into
  view): `mayGoBackTo` offers the last release of the previous major from any release of
  the running one (2.5.0 -> last 1.x, as 1.2 offers 0.33.0 today). Only an unsafe migration
  stops it, by accident rather than by rule, and 2.1+ data would be left to a 1.x. The
  user's model: going back is for a release that broke something, so the way out belongs to
  the release right after it. Suggested: offer it only while on `X.0.x` (its patches and the
  `X.0.0` betas too); DEPLOYMENT's "or to the last 0.x" changes with it. Left open: an
  install that skipped `X.0` (1.4 -> 2.3 straight) would lose it; covering that means
  offering "the version updated from" (the database copies' names hold it), likely not
  worth it at one release a day.
- **Reversible migrations** (user, 2026-11-04: look at it when a major needs a schema change
  an older MineShell cannot read; nothing safe today changes, so not urgent): a migration an
  older version cannot work with ships its down beside its up, owned by the newer version,
  so going back converts the database instead of refusing (`planDowngrade`) or needing the
  pre-update copy, which stays the fallback. A down puts data back in its old shape and
  removes what the old schema lacks; newer data it cannot express is dropped or set aside
  for the next update's up. The newest version holds every down, so going back several
  releases runs them newest first. Notes from the first look:
  - The marker grows: `-- downgrade: safe | reversible | lossy - <what is lost> | unsafe -
    <why>`. A lossy one lists what goes in the going-back dialog and asks to confirm
    (guard rails, with the database copy taken as always), not a refusal.
  - Order: today a failed downgrade leaves the database untouched and the installer keeps
    the current version. With downs, the newer version converts and then hands over; if that
    install fails it restarts on a database it no longer reads. Run the downs on a copy that
    replaces the database only once the older version is in, or put the pre-downgrade copy
    back on failure.
  - A down removes its `_migrations` row, so the next update runs the up again. Data set
    aside comes back through that up, which has to reconcile with what the older version
    changed or deleted meanwhile.
  - Testable without per-migration checks: every up, then the downs back to release X,
    compared with a fresh database given only X's migrations (schema, indexes).
  - Database only: data on disk a newer version writes differently (`LEFT_BEHIND`, folder
    layouts, units) needs its own way back or stays a warning in the dialog.
  - With downs, the way out of a major no longer depends on the major staying additive, so
    when it is offered (the entry above) becomes a choice rather than a limit.
- **Legacy versions, more loaders and hybrids** (user, 2026-11-04: ideas for majors, nothing
  set; each needs research into how it works and whether it is worth it):
  - Minecraft before 1.2.5 (betas, alphas): Mojang's manifest has no server jars there
    (`OLDEST_SERVER_RELEASE`), so they would come from community archives; how complete and
    trustworthy those are decides it.
  - Legacy Fabric (Fabric before 1.14) and Ornithe.
  - Hybrids beside plugin servers: Arclight, Mohist, Magma, SpongeForge (see Planned,
    "Plugin servers", for why they were first left out).
  - Order (user): legacy versions and loaders before plugin servers, as they extend the
    modded management rather than adding a parallel ecosystem; hybrids with or after plugins.
  - Numbering, open: the user's reading of a major is "going back from it breaks something
    its new features made". A 1.x MineShell meeting a loader it does not know fails
    (`getLoader` throws), so 1. legacy versions and loaders are 2.0 and plugin servers 3.0
    (the user's lean: honest about what going back does), or 2. a 1.x minor first learns to
    tolerate unknown servers, after which new loaders and versions can be minors; the cost
    is an invisible line at the release that brought the tolerance. That tolerance is
    wanted either way and built in 1.2.0 (ARCHITECTURE, "Updating itself": a server with an
    unknown loader or version loads, starts and stops, and says why the rest is refused).
- **Chunk compression on an older Minecraft** (2026-11-03, user: note it for later, not now):
  a chunk keeps the compression it was written with, so after `region-file-compression=lz4`
  a world mixes zlib and LZ4 chunks, as do regions put together by chunk restore (fine:
  Minecraft reads each by its own type byte). Before 1.20.5 type 4 is unknown, so a world
  with LZ4 chunks taken below 1.20.5 (the version change with "new world" unticked, a world
  uploaded or copied in) cannot read them. MineShell could warn there (it reads the type
  bytes already), or rewrite LZ4 chunks as zlib first, which would be its first chunk writer.
- **Versions of files changed outside MineShell** (user, 2026-10-29: maybe later): earlier
  versions of edited files keeps only what MineShell's own saves replace. A mod rewriting its
  config, or an edit over SFTP, leaves no version; noticing those would mean watching or
  re-reading every config file.

- **One Activity page with the log** (user, 2026-10-28: maybe later, as 3 and 4 below): the
  sidebar's Activity (`/tasks`) is operations running and lately finished (installs,
  snapshots, updates) and the services MineShell asked; MineShell settings' tab with the audit
  log (who did what, the last 40 entries) was called Activity too. Ideas, smallest first:
  1. Rename only: the settings tab becomes "Log". Done 2026-10-28 (user's pick for now).
  2. Rename both: the sidebar "Tasks" (what it is, and its address already), the tab "Log".
  3. One Activity page with two tabs, "Running and recent" (tasks, everyone) and "Log" (the
     audit log, admins), and the settings tab goes. The log then gets what 40 rows lack:
     paging and filters by server, account and kind of action.
  4. With 3, each server's own part of the log on its page (who changed its settings, who
     stopped it), which is most of "Change history per server" (step 7).
  Kept for later: 3, with 4 when step 7 comes.
- **The chunk map as a map of its own** (user, 2026-10-17: ideas kept for later, a full
  release addition or a 2.0 feature if at all; 2026-10-27: kept undecided, not rejected):
  Restore chunks' flat map (`chunkmap.ts`) as a built-in map option where BlueMap and Dynmap
  do not reach (pre-1.13 versions other than 1.12.2, or 1.12.2 without adding a mod), with
  "save as image" (one block a pixel, no grid; copying the canvas already gives the view as
  it is). Probably not worth it beside a fully built map; it could grow into its own map
  tool. To look at again (user, 2026-10-27): what it would cover that BlueMap and Dynmap do
  not, what use that brings, the effort, and what it could do that the regular maps cannot.
- **One map tab for the chunk tools** (user, 2026-10-27): pruning, restoring chunks and
  planning a Chunky pre-generation each draw the same chunk map (`chunkmap.ts`) on their own
  screens. One map tab with those as modes (pick chunks to prune, to restore from a
  snapshot, an area to pre-generate) would put them in one place. Its own idea: it can be
  done with or without the chunk map becoming a map of its own. The shape (user,
  2026-10-27): one tab (name open) with a mode switcher that swaps the controls and the
  map's overlay where the mode has one (the prune heatmap, a snapshot's chunks, the
  pre-generation area). If the chunk map becomes a map of its own, the three modes go into
  that map instead of a tab beside it. Together they already work as a sort of map where
  there is none, so how far this goes is left to see.
- **The management server instead of RCON where there is one** (user, 2026-10-26: idea for
  later, if it is worth it): Minecraft 1.21.9+ has a JSON-RPC API over WebSocket
  (`management-server-enabled`/`-host`/`-port`/`-secret`, optional TLS in server.properties).
  What it would give over RCON: structured answers instead of parsing command text (online
  players, allowlist/ops/bans, game rules, server settings), and pushed events (player
  joined/left, server started/stopping/saving) instead of reading the log or polling `list`.
  Against: only 1.21.9+, which few modded packs are on yet, so RCON stays for everything
  older and the feature means two paths for the same things. Check first: the method list on
  a current server (and whether NeoForge/Fabric leave it as vanilla has it), and whether it
  takes arbitrary console commands (RCON would still be needed if not).
- **Chat to Discord** (2026-10-27, user: maybe): players' chat, deaths and advancements sent
  to a channel through the notification setup (webhook), read from the console. One way
  only: two-way needs a bot, which is what mods for it already do.
- **Command completion in the console** (2026-10-27, user: maybe; raised again 2026-11-08,
  vanilla at least, with a PR on a similar project to look at): RCON cannot ask for
  completions. Ways in, to check before deciding:
  - Vanilla, exactly: from 1.13 the data generator writes the whole command tree with argument
    types from the server jar, no running server (`--reports`, `generated/reports/commands.json`;
    1.18+ through the bundler, `-DbundlerMainClass=net.minecraft.data.Main`). Once per Minecraft
    version, kept in the cache.
  - Modded, roughly: `help` over RCON on a running server lists every registered command's usage,
    mods' included: names and argument hints, not types.
  - Argument values MineShell already knows: online players, item ids (itemicons.ts), game rules.
  - 1.12 and older: `help` pages only.
- **Quick switcher** (2026-10-27, user: unsure): Ctrl+K and a few letters jump to a server,
  one of its tabs or a setting (the settings search already knows the settings).
- **Permission presets** (2026-10-27): accounts' per-server permissions are ticked one by
  one; presets ("Moderator": console, players, start/stop; "Builder": start/stop) would make
  giving a friend access one click. Whether a preset stays linked (changing it changes
  everyone on it) or only fills the boxes is open.

---

## Considered and rejected

**Turning RCON off** (a switch in the redesign mockup's Network settings). MineShell sends
console commands, reads who is online, edits player lists live and stops servers cleanly
over RCON; without it most of the server tabs stop working. It stays managed: port and
password are MineShell's, `enable-rcon` is not offered.

**Acting on several servers at once** (user's call, 2026-10-27): stop or restart all,
install the updates on offer everywhere; less needed with a few servers at home than on a
host with many. Rejected for that reason; one server at a time stays.

**Translations** (user's call, 2026-10-27). The interface stays English: the user reads
only English and German, uses MineShell in English, and could not proofread any other
language, so a translation would help only other users of that one language. Proxy
networks (Velocity, BungeeCord) and Bedrock players (Geyser) were set aside in the same
check: they come with plugin servers (2.0).

**A "Restarting" status** (user's call, 2026-10-18). A restart already reads as Stopping
(systemd's `deactivating`), Starting (until `Done (`), Running; one label for the whole thing
would hide which part it is at.

**A versioned REST API.** No second consumer exists — no CLI, no bot, no mobile app. Form
actions and a few endpoints cover it. Revisit only if a second consumer actually appears,
not in anticipation of one.

**Spark as a TPS source.** Not possible over RCON: Spark runs every command on a worker
thread, so RCON has already returned when Spark answers, and `spark tps` replies only to the
sender (the answer is dropped). Ways left, none cheap: a stdin channel into the server (a
FIFO as the unit's StandardInput) or a small companion mod.

**Players on the rendered map** (MineShell writing BlueMap's `live/players.json` from RCON;
user, 2026-10-09): the BlueMap mod shows live players already, and installing it is the
answer for anyone who wants them.

**Dropped in the October 2026 brainstorm**: panel hardening (it is LAN-only; remote access
stays the Tailscale route), idle auto-stop (wake-on-connect needs too much machinery),
adopting an existing server.

**tmux for process management.** This was the original TUI design and it is the right
answer for a terminal application. It is the wrong answer here: systemd already provides
supervision, restart policies, resource accounting and log collection, and a web app has
no terminal to attach to. See `docs/ARCHITECTURE.md` for why the `ExecStart` line is shaped
the way it is.

**Long-term resource history.** 24 hours at 10-second resolution, no rollup. Anything
longer means downsampling, retention tiers and a lot of code to answer questions nobody
running a home server actually asks.

**CurseForge server packs as the install source.** Looked at in October 2026 with a working
key: the official API gives each pack file a `serverPackFileId`, the mirror does not. Of
12 popular packs sampled, the layouts were few (flat, wrapped in one folder, a zip inside
the zip, ServerStarter's `server-setup-config.yaml` with no mods at all), but the contents
are the author's own test server zipped up: logs, config backups (`bettercombatmod.cfg
bruh`), start scripts, installers, `libraries/`. Some versions have none, they can lag the
client pack, the jars carry no project ids, and they run to 1.2 GB (a pack change preview
would download all of it). The client mod list plus `clientonly.ts` stays the one install
path. If the author's curation is ever wanted, the cheap form is reading only the server
pack's file list (HTTP range requests on the zip's central directory, a few KB) and flagging
client-list mods missing from its `mods/` as client-only - not installing from it. (GT New
Horizons is the one exception planned, as its own install option: see Later, step 8.)
