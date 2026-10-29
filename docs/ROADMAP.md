# Roadmap

Open work only: planned, later, undecided and rejected ideas, with the reasoning behind the
decisions. This is not a schedule. Built features, with their notes and decisions, are in
[ROADMAP-ARCHIVE.md](ROADMAP-ARCHIVE.md); when an entry here is built, it moves there and
whatever it leaves out stays here.

## Current direction

Versions (user's call, 2026-10-16): MineShell is in beta (0.x). 1.0 comes when all basic
functionality is there and stable. After it, maybe a few minor additions, then plugin
servers (Paper and Purpur) as the first major update, 2.0; not before. GT New Horizons also
has an agreed install-flow plan. None of this has a delivery date.

Beta order (user's calls, 2026-10-16 and 2026-10-21), for the entries under "Later" (the
"sooner" ones are built: ROADMAP-ARCHIVE):

- **Before 1.0**: the rest of "Road to 1.0" below. Smaller snapshots and backup copies (user's
  call, 2026-10-22) are built (ROADMAP-ARCHIVE). World backups to a folder (built
  2026-10-22), restoring chunks, pausing empty servers, player stats and instance export and
  import are built (ROADMAP-ARCHIVE).
- **After 1.0** (user's calls, 2026-10-21 to 2026-10-27): everything under "Later", in the
  suggested order of steps there (2026-10-27): upkeep and quick wins, files, mod configs,
  world, players, schedules, diagnosis and copies, GT New Horizons, item icons, the status
  page. Then plugin servers as 2.0.

Portability notes: arm64 and musl (Alpine) are not tested and will not be before 1.0
(user's calls, 2026-10-18 and 2026-10-21: no such hardware here, and a home server is
nearly always x64). What depends on them is only what MineShell downloads for a machine:
Java builds (`javadownload.ts` picks x64/aarch64 and glibc/musl) and playit.gg's agent.
A Java added by path works on any of them, and better-sqlite3 in the release archive
carries prebuilt binaries for all four. (Quilt loader switching was tried on a real server
2026-10-15.)

### Road to 1.0

Checks and small additions before 1.0 (suggested 2026-10-21; the user agreed to the
backups, the status page's move, the minor dependency updates and leaving TypeScript 7
until after 1.0, and asked to keep the rest listed here):

- **Feature freeze and a release candidate**: every planned feature is in (built 2026-10-25:
  the mod list, snapshot and disk notifications, the daily database copy, the update marker,
  limits on going back); frozen from 0.33.0 on (user's call, 2026-10-25): only `fix:` commits,
  and 1.0 once it runs stable without big issues;
  cut a release candidate, run it on the real install for a week or two, then 1.0. The
  candidate is a last 0.x (checked 2026-10-25): a `-rc` tag would need four changes (the
  workflow publishes it as a full release, `release.sh` cannot bump from it, the release
  notes for 1.0 would start at it, and the self-updater's `compareVersions` reads
  `1.0.0-rc.1` as equal to `1.0.0`, so the candidate would never be offered 1.0), while a
  0.x needs none, and going back from 1.x then lands on the tested release.
  **The candidate is 0.33.3** (user's call, 2026-10-27), replacing 0.33.2 (on the real install
  from 2026-10-26, which had replaced 0.33.1 with the two fixes the server export test found).
  0.33.3 brings the UI fixes the README screenshots and the page sweep found (spacing, words
  run together, phone layouts, tab bars) and the pack update preview counting renamed mod
  builds as updated; the checks those touch are the pages themselves (swept at 390 and
  1280 px) and the pack change preview (its flow test, and Cobblemon 1.8.1 -> 1.8.4 in the
  screenshot world). A `fix:` release in the meantime becomes the new candidate, and only the
  checks its fix touches are repeated. Since then (2026-10-28): 0.33.4 to 0.33.6 (long names,
  clock changes, server.properties and JVM argument escapes, the phone mods list, settings
  pages), and **0.33.7 is the candidate** (user's call, 2026-10-28): Add a server's layout,
  NeoForge builds for Minecraft 26.x, Fabric and Quilt after picking Cleanroom, Minecraft
  versions down to 1.2.5. Its checks: the loader flow clicked through on a throwaway dev
  server (every loader, 26.3 kept, lists filled) and the new loader list tests.
  **0.33.8 is the candidate** (2026-10-28), with the fixes a test review in a cloud session
  found: background errors and a full disk no longer end MineShell, a bad RCON packet no
  longer freezes it, chat can no longer fake joins, crashes or a crash diagnosis, uploaded
  worlds are refused before they exhaust memory or fill the disk, deleting waits for running
  work, new servers no longer take over a deleted server's kept folder, and outside links
  open only as web pages. Its checks: the tests each fix brought, and the console line
  formats in the real journal (vanilla/Fabric, NeoForge, Forge 1.12) checked against the
  new chat-proof matching; nothing of it was tried live on a server.
  On the real install from the evening of 2026-10-28, it was tried there the next day: shared
  snapshot files (made and deleted through the World tab, checked with
  `tests/tools/snapshot-check.mjs`), Delete during a running snapshot (found the one deletion
  per click below) and a new Fabric 26.3 server (found the format changes below).
  **0.33.10 is the candidate** (2026-10-29), after 0.33.9 the same day. 0.33.9: the leftover
  sweep's four fixes (loader caches kept after a version change, Chunky tasks following a world
  switch, a chunk restore's undo leaving its new files, the low-disk warning reaching only the
  first destination), the World tab's snapshot note no longer saying a running server cannot
  be snapshotted, pre-generation's two settings as choices instead of buttons naming the
  opposite, and Delete clicked again while the server stops no longer deleting once per click.
  0.33.10: Minecraft 26 worlds, whose chunk palettes, overworld folder, seed, players and
  border files moved (the chunk map drew nothing, "Keep it" on a reset lost the seed, the
  player editor listed nobody). Its checks: the tests each fix brought; the Chunky choices
  clicked, reloaded and swept at 390 px on the screenshot world; the 26.x readers on the
  user's own 26.3 world with all three dimensions and a player file (items, enchantments,
  stats), and on a 1.21 world, which reads as before. Not yet seen: the Delete button's
  "Stopping the server" in a browser.
- **Updating to 1.0 from older versions**: tried 2026-10-25 on throwaway installs with HEAD
  built as 1.0.0 (`tests/tools/update-source.mjs`): 0.2.0 -> 1.0.0 through `install.sh` and
  through the button (13 migrations), 0.33.0 -> 1.0.0 both ways, 1.0.0 -> 0.33.0 back
  (0.32.1 refused), each with a server running through it and its world, snapshot and
  backup folder kept. What 1.x keeps and what 2.0 may break is decided (user's call,
  2026-10-25: DEPLOYMENT, "What 1.x keeps"); going back past the last 0.x (and so past
  migration 0019) is neither offered nor supported.
- **A clean-machine install**: done 2026-10-25 (`tests/tools/clean-install.sh`) on Debian 12,
  Ubuntu 24.04 (both refuse their packaged Node 18, then NodeSource 22), Fedora 44 (Node 22)
  and Arch (Node 26), each with the dedicated account, lingering and `machinectl shell`: install,
  setup, a server with Java downloaded, a container restart. Found and fixed: servers did not
  come back after a container restart, the too-old Node message did not say how to get one,
  doctor failed on a Java MineShell had downloaded. Covers 0.33.1 (user's call, 2026-10-26):
  it ran on its code with the fixes in, from a local archive built by the same
  `scripts/package.sh` the Release workflow uses (which smoke-tests the published one).
- **A real-loader checklist**: written and gone through 2026-10-25
  (`tests/tools/real-loader-checklist.md`; found the Quilt export carrying Quilt's cache,
  fixed). Covers 0.33.1: it ran on its code.
- **Left for the user**: all done 2026-10-26: notifications to a Discord channel, the
  `.mrpack` and CurseForge client export imports, and a server export and import of
  MeatballCraft (CurseForge, Cleanroom, a 7.1 GB world; found and fixed: a backup mod's 21 GB
  of backups went into every export, and the import screen showed no icon).
- **A restore drill**: done 2026-10-25 on Forge 1.21.1 (throwaway): a scoreboard marker
  written over RCON, a snapshot copied to a compressed backup folder, the server deleted with
  its files, made again under the same name, the backup folder picked in its settings (copy
  back needs that first), the copy brought back and restored: same seed, marker there.
- **README and screenshots for the release**: done 2026-10-27 (user's call: with 1.0, so the
  project page looks finished; it changes nothing in MineShell itself, so the freeze and the
  candidate's testing are untouched). README: highlights at the top, MineShell's own updates,
  themes and phones in one section, tested systems, reaching it from outside, updating;
  development, layout and theming moved to CONTRIBUTING.md. Screenshots all redrawn
  (`npm run screenshots`): the overview (ending above the throwaway data path), the server
  list, the console, a pack update preview and the phone view at the top, and one per
  feature section: the pack browser, crash diagnosis, the mod browser, the Chunky planner on
  a real generated world, and a player's inventory with item pictures. Left out: settings,
  files and accounts (generic, stale with every UI change) and a BlueMap render. The
  redraw found eight UI bugs, fixed: words run together at block edges, "file(s)",
  bullets in the pack preview's lists, and mod updates counted as removed and added. A sweep
  of every page and sub-tab at 390 and 1280 px followed (`tests/tools/page-sweep.mjs`, on the
  screenshot world) and found nine more, fixed: Files and the All data tree on narrow
  screens, a phone's tab bars not showing the current tab, sub-tabs hidden past the edge on
  desktop, doubled space in two-column fields, the planner's two hints, and spacing and
  overflow in the client export, the version and loader pickers and the player editor.
  Then (2026-10-28) the longest text everywhere: the long world (`npm run screenshots --
  --long`: every field at its limit, names from mods, packs and players as long as they come,
  an owner and a restricted account) swept at 390 and 1280 px with the new check for text out
  of its box. Found and fixed: server names and JVM presets had no length limit, and long
  unbroken names ran out of the server header, cards, crash notes, Activity, the logs list,
  saved commands, Settings' tables and preset list, the mods table (whose box hid its
  version and source columns) and the player page.

Long running is covered: the user's installed MineShell has run a server with scheduled
restarts and snapshots since it was installed.

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
- **Not planned**: hybrids that load Forge/NeoForge mods and plugins together (Mohist,
  Arclight, Youer): fragile with big packs, and every crash becomes "is it the hybrid".

---

## Later

After 1.0 and before 2.0 (plugin servers). A suggested order (2026-10-27; the user asked for
one so there is a place to start after 1.0; any step can move): steps by theme, each a few
entries that share code, the cheapest and most needed first. A step is not a version:
`feat:` commits are released as minors whenever they are ready. Within a step, entries are
in the order to build them where one needs another.

1. **Upkeep and quick wins**: Node's download crash, TypeScript 7, log retention, TPS per
   dimension, the installed mods list, "required by" for mods, packs' own backup mods,
   holding a mod at its version, quiet hours for notifications. Small, mostly reading what
   MineShell already has: a calm first step after the freeze.
2. **Files**: a better file editor first (line numbers and opening at a line are what search
   needs), then search in files, earlier versions of edited files, zips and folders.
3. **Mod configs**: the mod config editor, on step 2's editor, search and file history.
4. **World**: game rules, world spawn and border, with the per-world game settings left from
   "Several worlds" (Leftovers); single files from a snapshot.
5. **Players and how the server shows itself**: game mode and teleport for online players,
   shared player lists, the server list preview, the server resource pack, maintenance mode
   (which changes the description the preview shows).
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

#### Node's download crash

Node's built-in fetch (undici 7 in Node 22 and 24) can end the whole MineShell process during a
download from a host that closes the connection after a full file (docs/notes/packs-and-mods.md
has the details; found 2026-10-25). No host MineShell downloads from does that, so it waits
(user's call, 2026-10-25: not during the freeze, and the fix raises the Node minimum). After
1.0: check whether a newer Node 22/24 or Node 26 ships a fixed undici (the separate undici
package is fixed from 8.12, which needs Node 22.19); if not, download through that package in a
1.x minor, raising the minimum within Node 22 to 22.19.

#### Quoted JVM arguments

The unit's shell splits JVM and launch arguments at spaces only, so a quote reached Java as part
of the value (ARCHITECTURE, "Quoting"); since 2026-10-28 quotes are refused when saved
(`argsProblem`), which also means no value can hold a space (a path with one, mostly). After 1.0
(user's call, 2026-10-28): split the arguments in MineShell, honouring quotes, and write each
one quoted so the shell keeps it whole. Works on every Java (`@argfile` and
`JDK_JAVA_OPTIONS` need 9+), but changes how every server starts, so try it on real loaders.

#### A picker for long lists

The Minecraft and loader version lists are plain `<select>`s. The browser draws their popup and
a page cannot set its height: Firefox makes it as tall as the screen, reaching the top (user,
2026-10-28). A picker of MineShell's own for the long ones: a field to type into that filters
the list (`1.20` shows the 1.20.x), a list of limited height that scrolls, the arrow keys and
Enter, and releases apart from snapshots where the list has both. Short selects stay native.
CSS `appearance: base-select` would style the native popup, but Firefox does not have it yet.

#### TypeScript 7

Waits until after 1.0 (user's call, 2026-10-21, with the minor dependency updates done
before the freeze). Development tooling only: check that svelte-check and Kit work with it
before switching.

#### Log rotation and retention

Nothing deletes old `logs/` or `crash-reports/` on its own; the disk usage page offers to
delete archived logs and crash reports older than 30 days. Moved to after 1.0 from
Undecided (user's call, 2026-10-25).

#### TPS per dimension

Agreed 2026-10-27. `forge tps` and `neoforge tps` list every dimension's tick time and
TPS, but `tps.ts` keeps only "Overall". Keeping the dimension lines (named as Dimension
names does) shows which one lags; nothing more is asked of the server. Vanilla's `tick
query` has no per-dimension figures.

#### Installed mods list

Agreed 2026-10-27. The list filters by name and by enabled/disabled/needs attention and
shows sizes, but has no icons (only search results do), no sorting and no side filter.
Icons from Modrinth/CurseForge for tracked mods (kept, not fetched per view) and from the
jar's own logo (`logoFile` in mods.toml, `icon` in fabric.mod.json) for the rest; sorting by
name, size and date added or updated; a filter for client-only mods.

#### "Required by" for mods

Agreed 2026-10-27. Installing shows a mod's dependencies, but disabling or deleting one
says nothing about the mods that need it, and the server then refuses to start. The jars
declare them (`META-INF/mods.toml`/`neoforge.mods.toml`, `fabric.mod.json`,
`quilt.mod.json`, `mcmod.info` for 1.12 where it lists any), read as the duplicate-mod check
reads mod ids: the Mods tab shows what needs a mod, and disabling or deleting one that
enabled mods require asks first, naming them. Optional dependencies are not a reason to ask.

#### Packs' own backup mods

Agreed 2026-10-27 (was undecided). Found 2026-10-22: MeatballCraft's AromaBackup zips the
world at every start, 2 minutes of lag, and kept 24 GB. Point them out on the World tab or
the disk usage page (AromaBackup, FTB Backups, Simple Backups, Textile Backup), with the
folder they fill, so the owner can turn one off where snapshots and backup copies already do
the job.

#### Holding a mod at its version

Agreed 2026-10-27 (was undecided). "Skip these" on the overview skips the mod updates on
offer, and the next version is offered again. A hold per mod (on the Mods tab) would keep
one left out of update checks for good, for a mod kept at a build on purpose.

#### Quiet hours for notifications

Agreed 2026-10-27 (was undecided). The optional events (joins, leaves, starts) held back
during a time window, while crashes, memory kills and a full disk still go out.

### 2. Files

#### A better file editor

Agreed 2026-10-27. Files edits in a plain textarea: no line numbers, no colours, and a
broken JSON or TOML file saves silently and fails at the next start. Line numbers and syntax
colours (JSON/JSON5, TOML, `.cfg`, `.properties`, YAML, JS for KubeJS), and a check on save
that names the line ("line 14: missing comma") with "save anyway". Opening at a line is what
search in files needs. An editor library (CodeMirror 6) is the likely way; its size is
loaded only on the editor.

#### Search in files

Agreed 2026-10-27. "Which config sets this?" means opening files one by one today. A search
across the server's text files (`config/`, `defaultconfigs/`, `kubejs/`, `serverconfig/` in
worlds, scripts), listing matching lines that open in the editor at that line; binary files,
`mods/`, logs (the Logs tab has its own search) and worlds' region files left out. Belongs
with the mod config editor.

#### Earlier versions of edited files

Agreed 2026-10-27. Snapshots hold only the world: configs, mods' settings and
`server.properties` have no copy unless a pack change made one (pack rollback). Each save
from the file editor (and later the mod config editor and the settings' raw editor) keeps
the version it replaced, listed per file with "go back"; going back is itself a save, so it
can be undone. Kept per file by count and age, in `.mineshell/` (left out of exports). The
user's call: this rather than configs in snapshots, since a file's own history is what
someone who broke one config reaches for. To decide: whether changes from outside the
editor (a mod rewriting its config, SFTP) are noticed and kept too.

#### Zips and folders in Files

Agreed 2026-10-27 (found in a completeness check). Files uploads, edits, renames, deletes
and restores from the trash, but cannot unpack an uploaded zip or download a folder as one.
Unpack: into the zip's folder or a new one named after it, refusing paths that leave the
server folder and asking before overwriting (what would be replaced goes to the trash, as
deletes do). A folder downloads as a zip streamed while it is made (`zip.ts`); a world
folder of a running server carries the same warning as other copies of a live world (World
tab's download pauses saving). Possibly packing chosen files into a zip in place.

### 3. Mod configs

#### Mod config editor

Planned for the old MineShell and forgotten (user, 2026-10-26). Today configs are edited as
raw text in Files. A form view for the common formats: NeoForge/Forge TOML (with the
comments above each key as hints, and their `# Range:`/`# Allowed Values:` lines as limits
or choices), Forge 1.12 `.cfg` (typed `B:`/`I:`/`D:`/`S:` keys and `<...>` lists), and plain
JSON/JSON5; anything else stays in the text editor. Writes keep comments and order (edit
the lines, not reprint the file), and a running server is told which configs it only reads
at start. Where it lives: a Configs view per mod on the Mods tab, and the same editor from
Files.

### 4. World

#### Game rules, world spawn and border

Asked for 2026-10-26 (user: no easy way to edit game rules yet; spawn and border agreed the
same day). A list of a world's game rules with their values, edited in place: a checkbox for
true/false, a number field for numbers. Game rules belong to the world (`level.dat`,
`Data.GameRules`, every rule stored as a string, mod-added ones included), so they go on the
World tab, per world, which is also a first piece of the per-world game settings in
"Several worlds" (Leftovers). Beside them the world spawn (`SpawnX/Y/Z`) and the world
border (`Border*`: centre, size), both already read for the Chunky planner
(`worldSpawn`/`worldBorder` in `world.ts`) but only changeable by console command today;
the spawn could be picked on the chunk map. Running: `setworldspawn` and `worldborder`
over RCON; stopped: written to `level.dat` like the rules.

- Reading: `level.dat` through `nbt.ts`, which gives every rule the world has, mods' too,
  with no running server. Names and descriptions from the lang files where they have them
  (`gamerule.<name>`), the raw name otherwise.
- Changing a running server's active world: `gamerule <name> <value>` over RCON (a write to
  `level.dat` would be overwritten at the next save). A stopped server or an inactive world:
  written to `level.dat`, after a snapshot or with the same care other `level.dat` writes take.
- To check first: 1.21.11 reworked game rules (names and how `level.dat` stores them), and
  whether pre-1.13 worlds store every rule or only changed ones. On 1.21.9+ the management
  server (Undecided) can list and set them with types, which would cover the running case
  without RCON.

#### Single files from a snapshot

Agreed 2026-10-27. A snapshot can be restored whole, by dimension, by chunk, or a player's
data, but not one file: a mod's file in `world/data/`, one region file, `level.dat`. A
snapshot browsed like Files, with "restore this file" (and folder); what it replaces goes
to the trash. Files the running server writes (region files, `level.dat`) only with it
stopped, as other world restores.

### 5. Players and how the server shows itself

#### Game mode and teleport for online players

Asked for 2026-10-26. Online players can be kicked, opped and banned (overview, player
drawer), but the player editor is read-only while they are online and nothing else acts on
them. Buttons in the player drawer and on the overview's "Online now": game mode (the four
modes, `gamemode <mode> <name>`; 1.12 takes the number or the name), and teleport to
another online player, to the world spawn or to coordinates (`tp`, with the dimension where
the version's `execute in` allows it, 1.13+). Over RCON, under the console permission
(`console.command`) or a permission of its own.

#### Shared player lists

Agreed 2026-10-27. Whitelist, ops and bans are per server, so someone running several
servers for the same group adds each player everywhere. A shared list (named, in MineShell's
settings) that servers follow: adding or removing there applies to each following server,
over RCON while it runs and to its JSON file while stopped, as the Players tab already does
for one. To decide: whether a following server can still have its own extra entries, and
what joining a list does with the entries a server already has.

#### Server list preview

Agreed 2026-10-27. The description (`motd`) is a plain text field, so `§` formatting is
typed blind. Beside it: the server as the multiplayer list draws it (icon, description in
its colours and styles, players online/max), with buttons that insert colour and format
codes. To check: how each version escapes `§` and `§` in `server.properties`, and
that the two-line limit and width match the client.

#### Server resource pack

Nothing yet (user, 2026-10-26: long meant to, never mentioned): the pack is only reachable as
extra `server.properties` keys (`resource-pack`, `resource-pack-sha1`,
`require-resource-pack`, `resource-pack-prompt`, `resource-pack-id` on newer versions).
Typed fields in the server's settings, with MineShell downloading the pack once to work out
the SHA-1 (and again when the URL changes), and the prompt as text. To check: which keys
each Minecraft version reads (the prompt and `require-resource-pack` came in 1.17), and
whether MineShell should also host an uploaded pack itself, which needs an address players
can reach (playit.gg does not carry HTTP).

#### Maintenance mode

Agreed 2026-10-27 (was undecided). One switch that turns the whitelist on, kicks whoever is
not on it with a message, and changes the description to say so; off puts all three back.
For pack updates and other work players should stay out of.

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
step when convenient; this slot is where they are done at the latest.

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

What the built entries in the archive left out, in one place:

- **Limits on going back**: the last 0.x, once gone back to from 1.x, offers the older betas
  again; it could refuse going below itself once its database has seen 1.x (optional). The
  release candidate can be that last 0.x, so going back lands on a tested release.
- **MineShell's database copies**: restoring one from the page (DEPLOYMENT has the steps), and
  copying them to a backup folder along with the snapshots.
- **Pack change preview**: a warning when the new version drops the mod that loads a folder
  of the user's data packs (Paxi, OpenLoader): the files come back but nothing loads them,
  and a world-generation one going away can stop the world loading.
- **playit.gg**: dedicated IPs and custom domains (set up on playit.gg); adopting tunnels
  made on playit's dashboard (listed, left alone).
- **Data packs**: CurseForge data packs (a separate class, "Data Packs", the mod browser
  does not search; the mirror's coverage of it is unchecked). Data pack updates are checked
  by hand in the Data packs sub-tab (built 2026-10-16), not in the periodic check.
- **Item icons and names**: 1.12 mod damage variants whose model names only the mod's code
  maps (AE2 material/part, IE metal, Botania manaresource; user's call: decide later), names
  a mod links to its id only in code (advancedrocketry:advrocketmotor is tile.advRocket),
  variants that exist only in code (Actually Additions crystals, Mekanism basic blocks),
  lang templates' filled-in text, banner patterns on banners and shields, player heads' own
  skins.
- **World map**: a map for pre-1.13 versions other than 1.12.2 (GTNH's: Later, step 8).
- **Installer and updates**: installing Node for the user (the installer says how to get
  it), installing updates automatically; restoring a database backup from the page (by hand
  in DEPLOYMENT, "Upgrading": servers made since would be missing from it).
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
  open; built is drag to pan, click to toggle, Shift/Ctrl-drag); a snapshot row's link to
  the page with that snapshot picked. Map colours: blocks a mod tints in code
  (Forestry/ExtraTrees leaves, Tinkers' slime grass and molten metals) are grey or untinted, and so are ones
  whose model only the mod's code names (Chisel's variants); the overview is chunk
  presence only, not shaded by InhabitedTime as first planned.
- **Cancelling tasks**: only the ones listed in ARCHITECTURE ("Cancelling") can be; an install
  or pack change cancelled stops downloading but still finishes, with the rest listed as
  missing (no rollback to before it).
- **Dimension names**: Forge's answer is only asked while the server runs (no boot to ask);
  1.12 task labels ("Pruning DIM-11325") still use the folder name.
- **Roofs on the map**: decided per region, so a region at a roofed dimension's edge with too
  few columns under the roof shows its surface; a free height slider (caves anywhere) was
  talked about, 2026-10-18, not built.
- **Pruning chunks**: protection is per prune (named areas every prune skips were talked
  about, 2026-10-17, not built); the analysis lives in memory, so a MineShell restart means
  analysing again; decompression is now most of an analysis (~20 s for 500 regions) and
  runs on the main thread; zlib's thread pool could take it (async inflate, several chunks at
  once). The terrain view is a second read (the user's call, 2026-10-18: a fast heatmap-only
  analysis, terrain only for the regions looked at).
- **Several worlds**: difficulty, gamemode, hardcore and other game settings per world
  (user's call: server settings for now, maybe later); the BlueMap mod's live map was not checked
  after a switch (Dynmap names its worlds by folder).
- **Pausing empty servers**: nothing for versions before 1.21.2 (a mod per loader, not
  researched). Whether pre-generation (Chunky) keeps running while paused is unchecked.
- **Player stats**: read only (no editing or resetting), no history over time; 1.12 mob
  names come from lang files (no pictures for mobs); pre-1.8 numeric ids and achievements are
  shown raw or left out (not checked on a real world). Stats on the status page, once that is
  decided.
- **Old and optional world formats** (found 2026-10-29, after 1.0): servers before 1.7.6 keep
  their lists as `ops.txt`, `white-list.txt`, `banned-players.txt` (names, one per line) and
  players as `world/players/<name>.dat`, so the Players tab's lists and the player editor are
  empty there (checked on vanilla 1.6.4 with `mc-probe.mjs`); their log is `server.log` beside
  the server, with "<name>[/ip] logged in" for joins (the Logs tab and join detection are
  unchecked on it). Chunks stored with `region-file-compression=lz4` (1.20.5+, off by default)
  are unreadable to the chunk map and kept by pruning.
- **Update availability**: pack versions, loader builds and (servers without a pack) mods
  are checked periodically (`updatecheck.ts`); a newer Java update is not shown. Pack
  servers are not offered loader builds or single mod updates (the pack picks them; user's
  calls).

---

## Undecided

Suggested, not yet confirmed or rejected:

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
- **Command completion in the console** (2026-10-27, user: maybe): RCON cannot ask for
  completions, so suggestions would come from a command list read from the server (`help`
  over RCON), which modded commands make less complete.
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
