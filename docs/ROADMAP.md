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

Beta order (user's call, 2026-10-16), for the entries under "Later" (the "sooner" ones are
built: ROADMAP-ARCHIVE):

- **Next** (user's call, 2026-10-17): the status page, parked on its open questions
  (2026-10-18). Restoring chunks, pausing empty servers and player stats are built
  (ROADMAP-ARCHIVE).
- **End of beta**: world backups (external). Instance export and import is built (ROADMAP-ARCHIVE).
- **Late beta or after 1.0** (polish): the item icon and name leftovers, per-world game
  settings.

External world-backup integration is a future plan, but the provider and design are not
settled. Current snapshots remain local to the server disk. This is an accepted limitation
for now, rather than a current blocker.

Portability notes: Java downloads on ARM64 and musl/Alpine are not tested and will not be
before 1.0 (user's call, 2026-10-18): development hardware is x64 with glibc. (Quilt loader switching was tried on a real server 2026-10-15.)

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

None of these depends on another.

### Status page

Optional, off by default, for players without an account (accounts already cover users):
the owner turns it on per server and ticks what it shows. Parked (user's call, 2026-10-18)
with the open questions below; the user is thinking them over.

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

### More README screenshots

Saved for later (user's call, 2026-10-19). The top gallery (`npm run screenshots`,
tests/tools/screenshots) is the general overview; feature sections could get one picture
each where it shows what text cannot, cropped to the part that matters (a shot's `element`),
full width at the top of its section. Not settings, files or accounts (generic, and stale
with every UI change). Proposed, cheapest first:
1. **Crash diagnosis** (Console, logs & crash diagnostics): a server whose last start
   crashed, with MineShell's verdict. The fake server prints a real crash log and exits 1.
2. **Player editor with item pictures** (Player management): a scene writing a player file
   with a filled inventory, and the client jar (~30 MB from Mojang, kept between runs).
3. **Pack update preview** (Modpack & instance management): mods updated, added, removed,
   configs kept; the page asks Modrinth live.
4. **Chunk map with the prune heatmap** (World management): synthetic region files; the
   heatmap needs only InhabitedTime, terrain colours need block palettes.

Also open: Jade's title has an emoji ("Jade 🔍") that the headless Chrome draws as a box.

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
  it), installing updates automatically; restoring a database backup from the page (by hand
  in DEPLOYMENT, "Upgrading": servers made since would be missing from it).
- **Server export and import**: data packs, resource packs and other files from Modrinth are
  carried, not linked (only mods/ jars are); `isLoaderInstallEntry` does not count
  `.fabric-cache/` or `versions/` either, so loader switches and pack changes leave them (the
  export leaves them out by itself); not tried for real with a CurseForge pack or a world of
  gigabytes.
- **Client pack export**: a pack icon (none of the formats has a place both launchers read),
  CurseForge fingerprint lookups to link manually added jars in a CurseForge pack (needs the
  official API key), packwiz.
- **Snapshots**: a scheduler hook running a script after a snapshot.
- **Restoring chunks**: a setting for other map controls (user's call, 2026-10-17: kept
  open; built is drag to pan, click to toggle, Shift/Ctrl-drag); a snapshot row's link to
  the page with that snapshot picked; undoing a restore leaves a region file the restore
  created (the live world had none there). Map colours: blocks a mod tints in code
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
  (user's call: server settings for now, maybe later); Chunky's saved tasks
  (`config/chunky/tasks/`, by dimension) are not swapped with the world, so an unfinished
  pre-generation shows for the next world too; the BlueMap mod's live map was not checked
  after a switch (Dynmap names its worlds by folder).
- **Pausing empty servers**: nothing for versions before 1.21.2 (a mod per loader, not
  researched). Whether pre-generation (Chunky) keeps running while paused is unchecked.
- **Player stats**: read only (no editing or resetting), no history over time; 1.12 mob
  names come from lang files (no pictures for mobs); pre-1.8 numeric ids and achievements are
  shown raw or left out (not checked on a real world). Stats on the status page, once that is
  decided.
- **Update availability**: pack versions, loader builds and (servers without a pack) mods
  are checked periodically (`updatecheck.ts`); a newer Java update is not shown. Pack
  servers are not offered loader builds or single mod updates (the pack picks them; user's
  calls). The server list shows no update marker.

---

## Undecided

Suggested, not yet confirmed or rejected:

- **The chunk map as a map of its own** (user, 2026-10-17: ideas kept for later, a full
  release addition or a 2.0 feature if at all): Restore chunks' flat map (`chunkmap.ts`)
  as a built-in map option where BlueMap and Dynmap do not reach (pre-1.13 versions other
  than 1.12.2, or 1.12.2 without adding a mod), with "save as image" (one block a pixel, no
  grid; copying the canvas already gives the view as it is). Probably not worth it beside
  a fully built map; it could grow into its own map tool.
- **Log rotation and retention**: nothing deletes old `logs/` or `crash-reports/` on its
  own; the disk usage page offers to delete archived logs and crash reports older than 30
  days.

---

## Considered and rejected

**Turning RCON off** (a switch in the redesign mockup's Network settings). MineShell sends
console commands, reads who is online, edits player lists live and stops servers cleanly
over RCON; without it most of the server tabs stop working. It stays managed: port and
password are MineShell's, `enable-rcon` is not offered.

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
Horizons is the one exception planned, as its own install option: see Planned.)
