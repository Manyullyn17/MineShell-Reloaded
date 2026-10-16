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

Beta order (user's call, 2026-10-16), for the entries under "Later":

- **Sooner**: duplicate detection across platforms and hash-based mod caching.
- **End of beta**: world backups (external), instance export and import.
- **Late beta or after 1.0** (polish): the item icon and name leftovers, per-world game
  settings.

External world-backup integration is a future plan, but the provider and design are not
settled. Current snapshots remain local to the server disk. This is an accepted limitation
for now, rather than a current blocker.

Portability notes: Java downloads on ARM64 and musl/Alpine are not tested because development
hardware is x64 with glibc. (Quilt loader switching was tried on a real server 2026-10-15.)

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

### GT New Horizons as its own install option

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

---

## Later

Some of these unlock others: duplicate detection and the hash-based mod cache both build on
mod updates (built), notifications need no new infrastructure (the event bus exists), and
remote access needed the auth model (settled, accounts built). The rest is independent.

### World backups

Not implemented yet. External backup integration is planned for the future; its provider
and exact design are still undecided. The existing snapshots (before MineShell's own risky
operations, on request and on a schedule; ARCHITECTURE, "Worlds") are useful for
local recovery, but remain on the same disk as the server. A running-world backup must
preserve consistency: flush and pause saving, copy, then always restore saving even if the
copy fails (as the World tab's download and live scheduled snapshots already do).

Note there is already a *different* backup mechanism in the codebase: an update moves the
replaced mod jars aside (the `mod-update` journal) so a failed update can be rolled back. That operates on the
mods directory only and has nothing to do with world saves. The two were conflated in the
original notes; they should stay separate.

### Duplicate detection across platforms

The same mod installed from both Modrinth and CurseForge appears twice with different
filenames and no shared identifier. Detecting this needs jar inspection — reading
`fabric.mod.json` or `META-INF/mods.toml` for the real mod id — rather than trusting
platform metadata. Worth doing after mod updates, since both want the same jar-inspection
code.

### Hash-based mod caching

Check a content hash before downloading and copy from an existing instance if it matches.
Deferred at first (an optimisation, not a correctness fix, and it partially reverses the
deliberate decision to always download fresh); moved up with duplicate detection (user's
call, 2026-10-16), since both read the same jar hashes. It must key on
*content* hash, never on version label — the whole reason for downloading fresh is that
packs ship patched jars under upstream version numbers.

### Instance export and import

The original design specified a `.jcpack` bundle containing mod metadata, overrides,
configs and instance settings, for moving an instance between machines. Still a good idea,
still not built. Its natural moment was after mod updating, since both depend on the mod
metadata being trustworthy; that is built now.

### Leftovers of built features

What the built entries in the archive left out, in one place:

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
- **World map**: a map for pre-1.13 versions other than 1.12.2 (GTNH's under Planned).
- **Installer and updates**: installing Node for the user (the installer says how to get
  it), installing updates automatically, going back to an older release from the page (the
  installer does it with `MINESHELL_VERSION`).
- **Client pack export**: a pack icon (none of the formats has a place both launchers read),
  CurseForge fingerprint lookups to link manually added jars in a CurseForge pack (needs the
  official API key), packwiz.
- **Snapshots**: restoring a region of a dimension (one dimension is built); a scheduler
  hook running a script after a snapshot.
- **Several worlds**: difficulty, gamemode, hardcore and other game settings per world
  (user's call: server settings for now, maybe later); Chunky's saved tasks
  (`config/chunky/tasks/`, by dimension) are not swapped with the world, so an unfinished
  pre-generation shows for the next world too; the BlueMap mod's live map was not checked
  after a switch (Dynmap names its worlds by folder).
- **Update availability**: pack versions, loader builds and (servers without a pack) mods
  are checked periodically (`updatecheck.ts`); a newer Java update is not shown. Pack
  servers are not offered loader builds or single mod updates (the pack picks them; user's
  calls). The server list shows no update marker.

---

## Undecided

Suggested, not yet confirmed or rejected:

- **Read-only status page**, mainly worth it together with a **join page** (address,
  version, pack download).
- **Player stats** from `<world>/stats/<uuid>.json`.
- **Sleep when empty**: `pause-when-empty-seconds` on vanilla 1.21.2+. For older and modded
  versions, it is unknown which loaders honour it.
- **Log rotation and retention**: nothing deletes old `logs/` or `crash-reports/` on its
  own; the disk usage page offers to delete archived logs and crash reports older than 30
  days.

---

## Considered and rejected

**Turning RCON off** (a switch in the redesign mockup's Network settings). MineShell sends
console commands, reads who is online, edits player lists live and stops servers cleanly
over RCON; without it most of the server tabs stop working. It stays managed: port and
password are MineShell's, `enable-rcon` is not offered.

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
Horizons is the one exception planned, as its own install option: see Planned.)
