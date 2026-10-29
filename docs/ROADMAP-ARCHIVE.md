# Roadmap archive

Finished work: built features with the notes and decisions behind them, historical planning
lists, and fixed bug reports. Open work is in [ROADMAP.md](ROADMAP.md), including what a
built entry here leaves out ("Not built: ..."). Some historical lists below mention ideas
that were undecided or deferred at the time; ROADMAP.md says where each stands now.

When something on the roadmap is built, its entry moves here with its notes.

## Built

### Restoring MineShell's database from a copy

Built 2026-10-29 (Settings > Updates, "Database copies"; ARCHITECTURE, "Updating itself"), on
the `next` branch, from the leftovers (user's pick). Each copy (daily, before an update,
before a restore) is listed with its servers and accounts; putting one back shows which
servers it lacks or brings back, keeps the database as it is first, and goes in at the next
start, which an installed MineShell does at once. Tried on a throwaway dev server: a copy
from before a second server was made put back (the server left the list, its folder stayed),
then the copy made before that restore put back (both servers again). Found on the way:
copies were left in WAL mode, so opening one grew -wal/-shm files beside it. Not built:
copying the database copies to a backup folder (a leftover still).

### Zips and folders in Files

Built 2026-10-29 (Files; ARCHITECTURE, "Zips in Files"), on the `next` branch. Every folder's
Download is a zip streamed while it is made; one holding the active world, or inside it,
pauses a running server's saving as the World tab's download does. A zip's row menu unpacks
it where it lies or into a folder named after it; a zip with an entry leaving that folder is
refused whole, and what it would replace is listed first and goes to the trash once agreed.
Tried on a throwaway dev server: a KubeJS scripts zip unpacked over an existing script (asked,
replaced, the old one in the trash), and a folder downloaded as a zip. Not built: packing
chosen files into a zip in place (the entry's "possibly"), unpacking other archive kinds
(`.tar.gz`, `.7z`).

### Earlier versions of edited files

Built 2026-10-29 (Files; ARCHITECTURE, "Earlier versions of edited files"), on the `next`
branch. Each save in the file editor keeps the text it replaced (20 per file, up to 90 days,
the newest 3 always), listed under the editor as "Earlier versions" with "Load into the
editor": the version goes in unsaved, and saving it goes back, keeping what it replaced, so
going back can be undone. Only MineShell's own saves keep versions (user's call, 2026-10-29;
changes from outside, a mod or SFTP, moved to Undecided). Left out of exports and copies.
Tried on a throwaway dev server: two saves, the first version loaded and saved back, three
versions kept. Not built: the mod config editor and the settings' raw editor keeping
versions (they come later and will call `keepVersion`), a diff between versions, versions
following a renamed file.

### Search in files

Built 2026-10-29 (Files; ARCHITECTURE, "Search in files"), on the `next` branch. A search box in
Files' toolbar looks through the folder shown (the whole server at the top): configs and
scripts by their lines, every line opening in the editor at that line with the match selected,
and file and folder names (asked for by the user while it was being built), `mods/` and logs
included. CraftTweaker's `.zs` scripts open in the editor now too. Tried on a throwaway dev
server with MeatballCraft's real `config/` and `scripts/`: "Darklands" in 11 files of 10,319,
"abyssal" stopping at 500 lines with 33 names, at 1280 and 390 px. Not built: regular
expressions, case-sensitive matching, replacing across files.

### A better file editor

Built 2026-10-28 (Files; ARCHITECTURE, "The file editor"), on the `next` branch, the first of
step 2. CodeMirror 6 in place of the textarea, loaded only with the editor: line numbers, the
theme's colours for JSON/JSON5, TOML, YAML, properties, Forge `.cfg` (a mode of its own), JS
for KubeJS and shell, search (Ctrl+F), and `?line=` to open at a line for search in files. A
JSON, JSON5, TOML or YAML file that parsed when it was opened is marked as you type and checked
before saving: "Line 3: Expected ',' or '}' after property value", with "Go to line" and
"Save anyway" (user's question: the check never stops a save for good). Tried on a throwaway
dev server: Simple Backups' real TOML opened at line 44, AbyssalCraft's `.cfg`, a JSON with a
comma removed (stopped, then saved anyway), a commented `.json` saved without a question, and
390 px. Not built: checks for `.cfg` and `.properties` (nothing to break that a parser would
see), the settings' raw `server.properties` editor on the same component.

### Packs' own backup mods

Built 2026-10-28 (World tab, Snapshots; disk usage page; ARCHITECTURE, "Backup mods"), on the
`next` branch. AromaBackup, Simple Backups, FTB Backups and Textile Backup, when enabled and not
switched off in their own config, are named with the folder they fill and its size, as the
same job MineShell's snapshots and backup copies do; the Mods tab's switch turns one off and
Files deletes its copies. Folder and on/off are read from AromaBackup's and Simple Backups'
configs (docs/notes/worlds.md), defaults for the other two. Tried on a throwaway dev server
with MeatballCraft's real AromaBackup jar and config. Not built: reading FTB Backups' and
Textile Backup's configs (not checked against real jars), FTB Utilities' built-in backups
(1.12; part of a larger mod), turning a mod's backups off in its config from MineShell.

### Installed mods list

Built 2026-10-28 (Mods tab; ARCHITECTURE, "Mod pictures"), on the `next` branch. Each mod
shows its picture: the project icon for Modrinth and CurseForge mods, downloaded once and
kept in MineShell's cache, the jar's own `icon`/`logoFile` for the rest, an empty square
where there is neither. Sorting by name, size, or added or updated (newest first), and a
"Client-only" filter chip, shown when there are any. Tried on the screenshot world: Cobblemon's
33 Modrinth mods all with icons, MeatballCraft's CurseForge ones from the modpacks.ch mirror's
records, size sort on its 374 mods, and the phone width (24 px pictures there). Not built: a
filter by side beyond the client-only flag MineShell already keeps per mod, and pictures for
jars MineShell has no record of that name none themselves.

### Quiet hours for notifications

Built 2026-10-28 (Notifications in MineShell settings and a server's Settings; ARCHITECTURE,
notifications), on the `next` branch. Each destination can have a window (22:00 to 08:00
when first switched on, the machine's clock) in which scheduled restarts, starts, stops,
joins and leaves are not sent; crashes, memory kills, stuck starts, snapshot and backup
failures, low disk and updates still are. Held back means dropped: news of a join hours late
is noise. Per destination, since a server's own channel and the owner's phone may want
different nights (migration 0029 for a server's own). Tried on a throwaway dev server: saved
and read back on both pages, and the MineShell page at 390 px. Not built: days of the week, a
summary of what was held back when the window ends.

### Holding a mod at its version

Built 2026-10-28 (Mods tab; ARCHITECTURE, "Mods and packs"), on the `next` branch. "Hold" on a
Modrinth or CurseForge mod keeps it out of update checks for good, where the overview's "Skip
these" hides only the versions on offer; it shows as "held", and "Release" puts it back. The
flag was already there (`locked`: kept through updates, pack and loader changes, exports, and
left out of checks) with no way to set it; holding also takes the mod out of the overview's
current notice. Versions still switches a held mod. Tried on the screenshot world (Cobblemon's
mods) at 1280 and 390 px. Not built: holding a pack's mods against the pack's own version
change (they move with the pack, as before).

### Watchdog crashes in crash diagnosis

Built 2026-10-28 (ARCHITECTURE, "Watchdog stops"), on the `next` branch, after the defaults
review (user's call). A server the watchdog ended is named as such, with the mod from the crash
report's stack, and a button raises `max-tick-time` one step: 3 minutes from vanilla's 1, then
10; past that the diagnosis says the server hung and offers nothing, never -1. Tried end to end
on a throwaway vanilla 1.21.1 server at 1 ms: diagnosed on the overview, raised to 3 minutes by
the button, then started and stayed up. Not built: telling a slow tick from a deadlock by the
stack (both look the same to the watchdog).

### Log rotation and retention

Built 2026-10-28 (MineShell settings, Old logs; `logretention.ts`; ARCHITECTURE, "Old logs"),
on the `next` branch. One number of days for every server, off (0) by default so an update
deletes nothing: archived logs (`logs/*.log.gz`) and crash reports older than that are deleted
by the scheduler, which reads each server's folders at most once an hour. latest.log, debug.log
and other files in `logs/` stay. The disk usage page's "Delete them" (30 days) says whether it
is on. Tried on a throwaway dev server: four files from June and July went within a minute of
saving 30 days. Not built: a number per server (one for all, as the trash has), and Forge 1.12's
rotated `fml-server-N.log`, which Forge itself keeps to three.

### Node's download crash

Fixed 2026-10-28, on the `next` branch (for 1.1). Node's built-in fetch could end the whole
MineShell process during a download from a host that closes the connection after a full file
(docs/notes/packs-and-mods.md, found 2026-10-25). Checked then: still in the newest Node 22
(22.23.4) and 24 (24.22.1), fixed in Node 26 and the undici 8.12 package. Every request now
goes through that package's fetch (`undicifetch.ts`), which raises the Node minimum to 22.19
(user's call, 2026-10-28; DEPLOYMENT's "What 1.x keeps" now allows a newer release within a
line for a fix). `tests/tools/fetch-close.mjs` reproduces it. Not built: going back to Node's
own fetch once the oldest supported line ships a fixed one (Node 26 is the first).

### A picker for long lists

Built 2026-10-28 (`VersionPicker.svelte`; ARCHITECTURE, Frontend), on the `next` branch, after
the user found Firefox drawing the Minecraft version select's popup as tall as the screen. The
Minecraft and loader version fields on Add a server, a server's loader version and the
version move panel in Settings, a pack's version (Settings) and a mod's (Mods tab) are a field to type into that filters the list (`1.20` shows
the 1.20.x first, `2864` finds 14.23.5.2864), a list of limited height that scrolls, the arrow
keys, Page Up/Down, Enter and Escape, and releases apart from betas and snapshots where a list
has both (Quilt; Cleanroom's builds are all alphas, so no headings). Whole lists now, where the
selects stopped at 40 or 60 builds. Short selects stay native. Not built: CSS
`appearance: base-select`, which would style the native popup, once Firefox has it.

### TPS per dimension

Built 2026-10-28 (overview, Tick rate; `tps.ts`), on the `next` branch. `forge tps` and
`neoforge tps` already listed every loaded dimension; their lines are now kept, and a server
with more than one shows "per dimension" under its tick rate, opening a table slowest first
(amber below 18 TPS, as is the link when the slowest is). Named as the World tab names them:
vanilla's by name, 1.12's numbered ones by their dimension type (`Twilight Forest (DIM7)`),
1.13+ Forge ones by id; NeoForge names them itself. Tried on throwaway NeoForge 21.1.265 and
Forge 1.12.2 servers (both answers are tests). Not built: vanilla's `tick query`, so Fabric and
Quilt, has no per-dimension figures; no history per dimension (only the current answer).

### "Required by" for mods

Built 2026-10-28 (Mods tab; ARCHITECTURE, "What needs a mod"), the first post-1.0 entry, on
the `next` branch during the 0.33.5 candidate's run. Each mod some enabled mod needs shows
"Needed by ..." (a disabled one "Off, but needed by ...", under "Needs attention"), and
disabling or deleting it asks first, naming them. From the jars' own declarations, which the
crash diagnosis already read; optional ones and Forge's `side="CLIENT"` do not count, nor a
mod whose ids another enabled jar also has (a second copy, or one nested inside a jar). Tried
on the dev copies of the user's packs (ATM10: Curios needed by 13, Create by 12; MeatballCraft:
24 libraries from mcmod.info). Not built: 1.12 mods that declare dependencies only in their
`@Mod` annotation (most of them) are not seen; a server-side check on the toggle and remove
actions (the question is the page's).

### Limits on going back

Built 2026-10-25 (ARCHITECTURE, "Updating itself"; DEPLOYMENT), before 1.0, as agreed in
outline 2026-10-21: from 1.0 on, Settings > Updates goes back only within the running major,
plus to the newest release of the previous one (the escape hatch if 1.0 has a problem). A
rule, so 2.0 works the same; while on 0.x nothing changes. Older releases stay in the list for
their notes, without the button (the outline said not listed; the notes are worth keeping), and
the page says why. The installer's `MINESHELL_VERSION` stays the unsupported manual way. A test
holds every migration after 0019 downgrade-safe, which the hatch needs. What the older version
lacks was already named (`LEFT_BEHIND`, built with the backup folders).

### Daily copy of MineShell's database

Built 2026-10-25 (ARCHITECTURE, "Updating itself"; DEPLOYMENT, restoring by hand), before 1.0.
Before, the database was only copied before an update. Now also once a day from the scheduler
tick, `db-backups/daily-<date>.db`, seven kept, with SQLite's online backup (WAL mode: a file
copy can miss the `-wal`). Not built: restoring one from the page (the steps are in
DEPLOYMENT), and copying them to a backup folder with the snapshots.

### Notifications for snapshots and disk space

Built 2026-10-25 (ARCHITECTURE, "Scheduled snapshots" and "Low disk space"), before 1.0
(suggested 2026-10-22, the user agreed 2026-10-25). A scheduled snapshot that fails, waits
30 minutes in vain or is skipped for disk space sends the `backup` kind (now "Snapshot or
backup copy failed or skipped") once per run of them, and Settings shows how the last one went
when it did not work. The disk skip now comes before the stop mode stops the server; before,
the copy failed after the stop. Disks running low get a kind of their own (`disk`, on by
default, also for destinations saved before it): one message per disk, the line being the
servers' "keep free on the disk". Not built: a server with only its own destination that is
not the one a shared disk's message goes under does not get it.

### Mod list export

Built 2026-10-25 (the server's Export page, "Mod list"; also in the server's ⋯ menu and on the
Mods tab; the ⋯ menu has one Export entry for all three tabs; ARCHITECTURE, "Mod list export"): the last feature before 1.0 (user's call), like
Prism Launcher's "Export mod list". Markdown, plain text, HTML, CSV or JSON; version,
authors, link and file name as choices (all but the file name ticked); disabled mods left out
unless asked for. Copy or download. Anyone who may view the server may export it. Versions
and authors come from the jar first: Modrinth's project endpoint has no author (only search
results do), and CurseForge's recorded version is the file's display name. Not built: Prism's
custom template.

### Snapshots sharing unchanged files

Built 2026-10-22 (ARCHITECTURE, "Worlds"; notes/worlds.md), before 1.0 (user's call). Talked over
with the user: compression for backup folders (built the same day, "World backups to another
place"), hard links for local snapshots, unchanged files found by hash (user's call, over size
and time alone); deleting a snapshot any way must never touch the others (user's requirement),
which hard links give by themselves and a test holds for MineShell's Delete, retention and `rm`
by hand. Done first: the Files tab replaces files instead of writing into them, since it can
browse snapshots and an edit in place would change every snapshot sharing the file. Tests also
hold that the live world never shares a file after a snapshot, a restore or a world made of a
snapshot, and that a file changed in place since its record is not linked to. Sizes on disk count
each file once (retention, Settings, World tab, disk usage, whose "delete unpinned snapshots"
offer is what that really frees). Measured on MeatballCraft's 7.1 GB world: three snapshots in
7.2 GB instead of 21, the next snapshot of an unchanged world 9 s instead of 12. Leftovers:
ROADMAP, "Leftovers of built features".

### World backups to another place

Built 2026-10-22 (MineShell settings > Snapshots, "Backup folders"; a server's Settings >
Snapshots, "Backup copies"; World > Snapshots, "In the backup folder"; ARCHITECTURE, "Backup
copies"). Before 1.0 (user's call, 2026-10-21): simple, no cloud, extensible. As proposed: a
destination is its own kind of thing, a folder on this machine the only kind so far, with a few
operations other kinds would implement; finished snapshots are copied after the snapshot, so a
running world needs no second save pause; written under a partial name; per server: off, every
full snapshot, or scheduled ones (and ones taken by hand); its own count kept there, pinned ones
kept too; a failure is a notification and a mark (the World tab and the server's settings), never
a failed snapshot; a missing folder is never created. Decided while building: partial snapshots
stay local (one dimension before a change); adding and removing folders is the owner's (a path
MineShell writes into, as the path import is); a folder on the servers' own disk is allowed with
a warning; another server's copies can be copied back by a global admin, for a server deleted
and made again. The notification kind ("Snapshot or backup copy failed", on by default) is also
on for destinations saved before it. Tried on a throwaway dev server: copies on saving the
setting and 15 s after a new snapshot, copy back by the button, the folder removed (failed,
nothing created, shown on the World tab), desktop and phone widths. Measured on a throwaway copy
of MeatballCraft (7.1 GB): a live snapshot and its copy in under a minute, TPS 20 throughout
(notes/worlds.md). Compressed copies added the same day (user's call: compression for the backup
folder, hard links for local snapshots): one zip per snapshot with its manifest beside it, a
switch per folder, on by default; plain copies are still read, so the switch can change.
Leftovers: ROADMAP, "Leftovers of built features".

### Instance export and import

Built 2026-10-19 (the server's Export page, "Move to another MineShell"; Add a server, "Import
from another MineShell"; ARCHITECTURE, "Moving a server to another MineShell"). The original
`.jcpack` idea, decided with the user: like a modpack, mods MineShell can download again
(Modrinth by hash, CurseForge by project and file id) are listed and fetched on import, the rest
carried as files (user's call); the loader is installed again. Worlds in by default, snapshots,
logs and map tiles on request; works while the server runs (saving paused). Notification
destinations stay out (user's call: they hold webhook URLs), as do ports, RCON password, Java,
access and playit tunnels. An export file already on the machine can be imported by its path
(the owner only), for large ones copied over by hand (user's call). Permissions: exporting needs
the server's files permission (like the client pack export), importing "may create servers".
Tried for real on a throwaway dev server: a Fabric 1.21.1 server with Fabric API, Lithium (locked)
and a hand-made mod, booted, exported while running (saving paused and back on; 467 KB once the
Fabric cache and versions/ stayed out, 69.7 MB before), uploaded, imported, booted with all three
mods, lock and world kept. The path import and phone widths checked too. Not tried: a CurseForge
pack for real (CurseForge resolution only in tests), a world of gigabytes.

### Player stats

Built 2026-10-18 (Players; ARCHITECTURE, "Player stats"). A Stats tab on each player's page:
headline numbers (time played, deaths, mob and player kills, distance travelled without
falling, blocks mined, items crafted, damage dealt and taken), then every category as a
searchable list, biggest first, with item pictures. A leaderboard on the Players page ranks by
a headline or any general stat. Units per the user (2026-10-18): time to the second under an
hour, to the minute under a day, then days and hours; distance in cm, m and km; damage in
hearts. Tried on the throwaway dev server with copies of irithyll's (1.21.11) and
MeatballCraft's (1.12.2) stats and player files, desktop and phone. Leftovers: ROADMAP,
"Leftovers of built features".

### Pausing empty servers

Built 2026-10-18 (ARCHITECTURE, "Starting vs running"). As planned: Minecraft 1.21.2+'s own
`pause-when-empty-seconds` in a server's Settings (Performance > Ticking and disk, shown only
from 1.21.2) and in the new-server defaults (60, the game's own), and "Paused (empty)" in the
status from the game's log line until a player joins. Tried on the throwaway dev server with
vanilla 1.21.11: paused 60 s after Done, shown on the overview and in the server list within
the history read. Nothing for older versions (a mod per loader; stopping instead was
rejected). Leftovers: ROADMAP, "Leftovers of built features".

### Release history and downgrades

Built 2026-10-18 (Settings > Updates; ARCHITECTURE, "Updating itself"), the user's idea of the
same day: every release with its notes, and going back to an older one, mainly to step back
from a release that brought a problem. Decisions (user's calls): the database stays as it is
(a backup is taken before every install, restored only by hand); a migration an older version
cannot work with refuses going back past it, with no override; every downgrade warns that it
can cause problems, and one before 0.24.0 that the list and picking a version are gone from
there. Releases have no pre-releases, so none are listed. Tried on the throwaway dev server
against GitHub's real releases (with faked install variables): the list, 0.23.0 offered with
its warnings, 0.12.0 refused for 0019_users, phone width. A real downgrade only in tests.

### Previewing a prune on the map

Built 2026-10-18 (World > Prune chunks; ARCHITECTURE, "Worlds"), the user's flow: analyse the
dimension first, which draws a heatmap of the time players spent in each chunk; picking a
threshold (or the radius kept around spawn) marks the chunks that would go at once; chunks
are protected on the map (clicks and drags as on Restore chunks); then Prune. It replaced
"Count", which gave only a number. The prune removes only chunks the analysis marked and
the user did not protect, and only if they are still under the threshold on disk: anything
generated or visited since stays. The map shows the heatmap alone (no terrain to read) or the
terrain with the marked chunks over it. Tried on the throwaway dev server with 138 regions of
irithyll (Fabric 1.21.11): 114,835 chunks analysed in seconds, both views, protecting an
area, Daylight and phone width. Leftovers: ROADMAP, "Leftovers of built features".

### Restoring chunks from a snapshot

Built 2026-10-17 (World > Restore chunks; ARCHITECTURE, "Worlds"). As planned below, with
these differences: the page needs `backups.restore` (it restores, like the snapshot list's
Restore), not `world`; the replaced region files are always kept as a snapshot with no
question (a rename of a few MB; the world-size question made no sense for it); the overview
shows which chunks exist, without InhabitedTime shading (the header alone is what makes a
whole world cheap). Desktop and touch see only their own control hints (user, 2026-10-17).
Tried on the throwaway dev server with a copy of irithyll (Fabric 1.21.11, 760 regions):
the map drew in about a second a region, a pruned area was restored through the page's
action and came back, the snapshot held only the three changed files. Reading checked on
copies of MeatballCraft (Cleanroom 1.12.2, RoughlyEnoughIDs: 488 block kinds in one region,
104 without a colour, mostly Forestry/ExtraTrees leaves and Chisel) and ATM10. The user
tried it on a phone over Tailscale (2026-10-17): selecting and restoring work. The mouse
tooltip works (the user, on a PC). Zoomed out, regions first showed only their chunks until
zoomed in ("hard to find a location", the user): now every region in view gets a small
picture, a whole world filling in from the middle (irithyll cold: ~6 minutes, then seconds). The plan:


Wanted (user, 2026-10-17): put back part of a dimension from a snapshot (griefing, a broken
build, a corrupted chunk) without rolling back the rest. Restoring a whole dimension is built
(`restoreDimension`); chunk-level rewriting of region files is too (`chunkprune.ts`), so
the restore itself is the smaller half: copy the picked chunks from the snapshot's region/,
entities/ and poi/ files into the live ones, as a world change into a partial snapshot.

The area is picked on a map (user's preference over typing region numbers), which means
MineShell draws one. Not BlueMap: a flat top-down map, one pixel per block column, like a
map item or uNmINeD. Layers, each usable on its own:
1. **Chunk grid** from the region files' headers, shaded by InhabitedTime (what pruning
   reads already). Works on every version and every mod, and is already enough to pick on.
2. **Colours**: the top block of each column, coloured by the average of its top texture,
   shaded by height. Textures come from the item icon index (`itemicons.ts`, mod jars +
   client jar); a block it cannot find stays grey. Grass, leaves and water need a tint.
   Needs block decoding per format: 1.13+ section palettes (bit-packed; the packing changed
   in 1.16), 1.12 numeric ids + metadata through the world's FML block registry, heightmaps
   where present. LZ4-compressed chunks (as for pruning) stay grid-only.
Drawn per region (512x512) on demand and cached; the snapshot's own files can be drawn too,
so the picker can show what comes back beside what is there now.

Picker (user's sketch, 2026-10-17): one scrollable, zoomable map rather than separate
pages. Zoomed out, every region at once as a cheap tile from its header (chunk grid,
InhabitedTime), with a coordinate grid; zoomed in, a region's coloured tile loads as it
comes into view (lazy, one by one). Chunks are selected by click or drag, across regions;
regions holding selected chunks stay marked when zoomed out. A coordinate field jumps to a
block position. Selected chunks look like Xaero's minimap claims (user's call): a
translucent fill in the accent colour, bordered on the selection's outer edge only, so
neighbouring chunks read as one area. A chunk grid over the map once zoomed in far enough
for it to be readable; region lines (and the coordinate grid) when zoomed out.

Pointer position (user, 2026-10-17): a tooltip with block x/z, chunk x/z (block >> 4), the
region file (`r.<cx >> 5>.<cz >> 5>.mca`) and, on the coloured view, the top block. Only
where `(hover: hover) and (pointer: fine)` matches; touch shows the last tapped spot in a
fixed readout instead. Input (suggested, not settled): drag pans, a click without moving
toggles a chunk, shift-drag selects a rectangle (with a deselect modifier); right click is
out (context menu, trackpads, phones). On touch: one finger pans, a tap toggles, pinch
zooms, and a Select toggle turns one-finger drags into rectangles.

Place: a "Restore chunks" sub-tab on the World tab (`world` permission, like Prune), its
map as its own route so the World page does not load it. Above the map: the dimension and
the snapshot to restore from (only snapshots of the active world that hold that
dimension; partial ones only for their folders). A snapshot's row could link there with
itself picked. Fallback if the seamless map turns out costly: an overview of region tiles,
a region view opened from it with steps to the four neighbours.

### Duplicate detection across platforms

Built 2026-10-16 (`duplicateMods`; ARCHITECTURE, "The same mod twice"), on crash diagnosis's
jar index, which already read the real ids. Placeholder ids are left out (1.12 mods that kept
`examplemod`), and only enabled jars count. Seen on the throwaway dev server with two copies of
a jar under Modrinth's and CurseForge's file names; Disable cleared it. The original note:

The same mod installed from both Modrinth and CurseForge appears twice with different
filenames and no shared identifier. Detecting this needs jar inspection — reading
`fabric.mod.json` or `META-INF/mods.toml` for the real mod id — rather than trusting
platform metadata. Worth doing after mod updates, since both want the same jar-inspection
code.

### Hash-based mod caching

Built 2026-10-16 (`filecache.ts`; ARCHITECTURE, after the pack rollback). Not from
`instance_mods.hash` as once planned: that column holds whichever hash was at hand (sha512
computed from the jar for pack mods, sha1 from CurseForge), while a CurseForge download comes
with a sha1, so most lookups would have missed. Every verified download records its path and
hash instead, and a match is re-hashed before and after copying. Tried on the throwaway dev
server: the same Fabric API version installed on a second server was copied (215 ms). The
original note:

Check a content hash before downloading and copy from an existing instance if it matches.
Deferred at first (an optimisation, not a correctness fix, and it partially reverses the
deliberate decision to always download fresh); moved up with duplicate detection (user's
call, 2026-10-16), since both read the same jar hashes. It must key on
*content* hash, never on version label — the whole reason for downloading fresh is that
packs ship patched jars under upstream version numbers.

### Remote access

Written up 2026-10-16 (DEPLOYMENT, "Remote access"): Tailscale first (steps, `HOST=127.0.0.1`
for Tailscale-only, friends through tailnet sharing plus MineShell accounts), then a public
reverse proxy with a checklist (bound to localhost, firewall, `ADDRESS_HEADER`/`XFF_DEPTH`
so the login throttle sees clients instead of 127.0.0.1, auth and updates) and Caddy and
nginx examples. Found while writing it: the nginx example lacked `client_max_body_size 0`
(nginx refuses bodies over 1 MB, so every upload failed) and `proxy_request_buffering off`.
No code change. The original note:

The auth question the notes left open is now settled: password plus session cookie, on by
default. That was the blocker for designing remote access, so it can proceed whenever it
is wanted. The recommendation in `docs/DEPLOYMENT.md` — Tailscale rather than a public
reverse proxy — is where this should land unless there is a specific reason otherwise.

### Pack change preview: your own files in the folders that move

Built 2026-10-16 (`ownFiles`/`keepOwn` in packchange.ts; ARCHITECTURE, "Config edits across
a pack change"). By then the config merge already carried users' own files back, binary
ones too, so a data pack added to `config/paxi/datapacks` survived; what was missing was
seeing it, the case where the new version ships its own file there (the pack's won), and
servers with no base (nothing merged, everything left in old-configs). User's calls: all
files added by hand, not only data packs, with a choice to keep them. Mods' own generated
configs count as the user's too (nothing tells them apart), hence counts per folder. Seen on
the throwaway dev server with Cobblemon 1.8.1 -> 1.8.2 (installed version read from
Modrinth). Not built: a warning when the new version drops the mod that loads such a
folder. The original note:

Folders like `config/paxi/datapacks`, `config/openloader`, `global_packs/` or `kubejs/`
are pack config folders, so a pack change moves them whole to `old-configs/` - including a
data pack the user added there. Correct by the configs policy, but easy to miss for a data
pack; the preview could point out non-pack files in those folders.

### Multi-instance port management

Built 2026-10-16 (`portmap.ts`, MineShell settings > Ports; ARCHITECTURE, Simple Voice
Chat). User's calls: a settings tab, global admins only, other programs' ports shown, and
clashes changeable by hand or moved to a free port automatically. Found on the way: new
ports avoided only game and RCON ports, not voice chat or map ports (fixed in the same
change). Tried on the throwaway dev server: the installed MineShell's irithyll was named by
its unit on all four of its ports, two servers given its voice port showed the clash and
"held by", and "Free port" moved them to 24455/24456. The original note:

Ports are allocated automatically and conflicts are detected (start refuses a port taken by
something else), but there is no view showing what is bound where across all instances.
Cosmetic until you are running enough servers to lose track.

### Resource cap for all servers together

Built 2026-10-16 (`servercap.ts`, MineShell settings > System; ARCHITECTURE, "Drop-ins"),
as decided below: `MemoryHigh=` and `CPUQuota=` on the servers' slice, and the start check
warns when the new server's ceiling plus the running ones' is past the cap. The slice is
`app-<prefix>.slice`, the one systemd 255 already put every template instance in, so no
restart was needed here. Tried on a throwaway dev server: the cap reached the cgroup
(`memory.high`, `cpu.max`) at once, the start warned, the server ran inside the slice, and
removing the cap removed the file. The original notes:

Per-server memory and CPU limits exist (server Settings, `limits.conf` drop-in with
`MemoryMax`/`CPUQuota`, heap + 512 MB checked). Wanted (October 2026): one cap on all
servers combined, mainly RAM and CPU, so a few big packs cannot take the whole machine.
systemd does this with a slice: the template unit gets `Slice=<prefix>.slice`, and a
`<prefix>.slice` unit carries the limits, which then bound the sum of every server under
it. Same controller delegation as the per-server limits (user units, memory and cpu
delegated by default). A running server picks up a new `Slice=` only after a restart.

Decided (2026-10-05): the all-server memory cap is a **soft** cap, `MemoryHigh=` on the
slice, not `MemoryMax=`. Past it the kernel throttles and reclaims inside the slice instead
of killing a server. What that means for Java, so the UI says it honestly: the kernel first
drops page cache (cheap), then swaps or stalls the JVMs' own memory, which shows as lag on
every server in the slice. The JVM does not hand heap back under pressure (G1 only uncommits
after a periodic GC, and never below `-Xms`, the server's min memory), so the cap
cannot shrink what the servers already hold. CPU: `CPUQuota=` on the slice, which is a
throttle anyway. Warn when the running servers' heaps plus headroom add up past the cap.

Headroom over the heap: the per-server limit's floor is heap + 10% + 1 GB
(`minMemoryLimitMb`); the cap's warning should use the same. Measured outside the heap:
`irithyll` (Fabric, 65 mods, 10 GB heap) 890 MB; MeatballCraft (Cleanroom, 16 GB heap, ZGC,
2026-10-15) 1.5 GB after starting, 3.3 GB three minutes in, then growing ~400 MB a minute
while Dynmap 3.7-beta-6 did a full render (stopped when the render was paused, never handed
back: 6.2 GB after 15 minutes). No headroom covers a native leak like that; a hard limit is
what stops it. ZGC's heap is shared memory (memfd) in the cgroup's accounting, so it counts
in full.

The per-server limits are in the new-server defaults (built 2026-10-15; ROADMAP-ARCHIVE).

### Several worlds per server

Built 2026-10-15 (World tab, Worlds). Every world is a folder in the server folder - the
active one is what `level-name` names - so switching rewrites `level-name` (and the world's
seed, level type and generator settings) while the server is stopped and moves no world.
The user's calls: worlds stay where they are; one snapshot budget for all of a server's
worlds, with a warning that an inactive world's snapshots can be pushed out (pin to keep);
an option on each switch to keep the leaving world's map (on by default); game settings stay
the server's for now; a world last run on a newer Minecraft is a warning with a bypass, not
a refusal. What MineShell keeps per world (name, settings, `pack_datapacks`, last run, kept
map's size) is `.mineshell/worlds.json`, so a server's copy has it too. Rename changes the
name only (snapshots and kept maps know a world by its folder). Added beyond the plan: a new
world copies the active world's data packs (with the pack's among them) unless unticked;
any full snapshot can become a world of its own ("New world"), which is also the way back to
a deleted world; deleting a world puts its folders in the trash. Uploading a zip as a new
world (asked for while it was built): it arrives inactive, so it works on a running server;
on a stopped one "Make it the active world" is offered (user's call: not shown while it
runs), and an upload from a newer Minecraft stays inactive for the switch's warning. A world
made and left before its first start has no folder, only its record (seed), and stays listed. An inactive world's size is
measured when it is left (or arrives, or is first listed) and kept (user's idea): nothing
writes to it, and walking every world on each page load is slow.
The restore guard came first as a fix: a snapshot taken under another `level-name` was put
back beside the world the server loads. Tried on a throwaway dev server (pages, phone
width, the actions); a real server was not booted on a switched world.

### Notifications (Discord, ntfy, webhooks)

Built 2026-10-15. The user's calls: one destination for MineShell, a server can have its own
instead or as well ("also send to MineShell's"); crash, memory kill, stuck starting and update
found on by default, scheduled restart, finished starting, stopped and player join/leave as
options; generic, not Discord only (ntfy for phone pushes). The old note said the event bus
already emitted everything: it did not (console lines, stats, unit state only). The sources
are the run history (starts, stops, joins, leaves; crashes and memory kills once diagnosed,
with the cause), the scheduler (stuck starting, once per run; scheduled restarts) and the
update check. Only events from the last 5 minutes are sent, so the history catching up after
downtime posts nothing; repeats of a problem within 10 minutes are counted into the next
message. Addresses are stored encrypted and shown only as a hint; Discord messages allow no
pings (player names and log text could hold @everyone); local addresses are refused unless
allowed (the download allow-list), since a server's admin picks its address. Tried against
ntfy.sh end to end (test message and a real "update available"); Discord's format is the
documented one, untried against a real channel. Left: pings for problem events (a role or
@here), a start-limit "gave up restarting" message, muting one server without an own
destination, links back to MineShell (it does not know its public address).

### Memory check before a start, and limits and update checks as new-server defaults

Built 2026-10-15 (both were open items: "RAM guard on start" undecided, the limits a line
under the resource cap). A start asked for by hand (overview, dashboard) warns when the
server's heap plus what Java needs beyond it (heap + 10% + 1 GB, or its memory limit if
smaller), plus what the running servers can still grow into (the same ceiling minus their
resident memory), is more than `/proc/meminfo`'s MemAvailable. Warn, not refuse: the page asks
"Start anyway?" and posts again with `force`. Scheduled restarts, crash restarts and starts
after a reboot are never held up by it. Servers outside MineShell count only through what
they use now. The defaults page has the memory limit as none or automatic (heap + 25% +
1 GB, fixed at creation, since every heap differs), a CPU limit, and the update check
settings.

### Trash in the Files tab

The user's idea (2026-10-13): Delete in Files moves to a per-server trash instead of deleting,
with Undo right after, restore and "delete for good" per item, an Empty button, and automatic
emptying after a number of days (MineShell settings, default 7; 0 = no trash). Kept inside the
server folder (`.mineshell/trash/`) so a delete is a rename, never a copy of a world. Only the
Files tab uses it; MineShell's own operations keep their own aside/rollback folders.

### Accounts and permissions

Several trusted people using one MineShell, each with access to chosen servers and features.
Agreed with the user on 2026-10-13 after an audit of every route; built in phases.

- **Roles.** The owner (one account, `admin`, protected by the database: never deleted,
  demoted or disabled) and global admins may do everything; only the owner manages the
  integrations (CurseForge key, playit.gg link and routing, the links to those accounts),
  updates MineShell, and makes or unmakes global admins. An instance admin may do everything
  on one server but not hand out access. Everyone else has permissions per server.
- **Permissions** (`lib/shared/access.ts`): feature-level, not per button. Console output and
  Logs are one permission, outside plain read access (same journal, player IPs and chat).
  Player data has view and edit, each for all players (later ones too) or chosen UUIDs; edit
  counts as view. `files`, `mods` and `software` can run programs as MineShell's user, so they
  mean full trust (accepted). The Map is viewable with read access; rendering is `map.render`,
  installing a map mod is `mods`; Mojang's EULA tick can be accepted with `map.render` or
  player data view. Going public through playit.gg is for instance admins. Pins and tags stay
  shared. A Java download an operation asks for is allowed with that operation's permission.
- **Creating and copying.** Whoever creates or copies a server becomes its admin; a copy never
  takes the source's access list, and copying needs `duplicate` and `files` on the source.
- **Owner name.** `admin` for now; renaming may come later (only the username column changes).

Phases: (1) fixes worth having alone - RCON password only on request, JVM presets in MineShell
settings, memory apart from the launch settings, the server list's buttons under each
server - **built**; (2) accounts, owner, username sign-in, `npm run reset-password` - **built**;
(3) the permission model and a default-deny route policy in the guard - **built**; (4) filter
lists and secrets in page data per account - **built**; (5) managing accounts and access (one-time
passwords with a forced change, disable, sign-out everywhere) - **built**; (6) creator becomes admin - **built**;
(7) show only what an account may use - **built**; (8) close open console/task streams when access
changes - **built**; (9) record who did what in the audit log - **built**. All
phases are built (2026-10-13).

### playit.gg tunnels

**Built (2026-10-09)** (`playit.ts`; ARCHITECTURE, "playit.gg tunnels"). The user's calls: a
per-server public switch (Settings, Network) with the address in the header; the agent runs
while linked; Premium-only regions shown greyed out on free (the API refuses them:
`RequiresPlayitPremium`; the website's free location choice is the agent's routing); linking
from MineShell's own button. Tried live on the user's free account through the throwaway
dev server: linked, Flicker made public, started, and a server-list ping through
`fried-saturn.tun.ply.gg` answered from the server. Found doing so: a second agent on a free
account is refused (`AgentDisabledOverLimit`), shown from the agent's log; a new tunnel is in
the account's list before the agent's run data (the first version forgot it on start); a new
hostname can take minutes to resolve. Later the same day (the user's ask): the agent's routing
("Connects through": automatic or one of playit's locations from `/info/pops`; free, set with
the agent key by `/agents/routing/set`, the running agent moves by itself) and links to the
agent's page and the agent list on playit.gg (managing or removing agents). Not built:
dedicated IPs and custom domains (set up on playit.gg), adopting dashboard-made tunnels
(listed, left alone).

Connect MineShell to a playit.gg account and let it manage tunnels for servers, so a
server can be reached from outside without port forwarding. Different job from "Remote
access" above: that is reaching MineShell, this is players reaching the game. Requested
October 2026; researched 2026-10-05 from the agent's source
(`github.com/playit-cloud/playit-agent`, 1.0.12) and two panels that did it.

How playit works: one agent process per machine holds an outbound connection to playit;
each tunnel (made on the account) names an agent and a local `ip:port`, and the agent
forwards to it. So one agent serves every MineShell server; tunnels just point at ports.

- **Linking** (no password or API key handled by MineShell): the agent's claim flow.
  Generate a random code, `POST /claim/setup {code, agent_type: "self-managed", version}`
  until the user has opened `https://playit.gg/claim/<code>` and approved (answers
  `WaitingForUserVisit` / `WaitingForUser` / `UserAccepted` / `UserRejected`), then
  `POST /claim/exchange {code}` returns the agent's secret key. Works on a free account.
- **API**: `https://api.playit.gg`, every call a POST with JSON, header
  `Authorization: Agent-Key <secret>`, answers wrapped in `{status, data}`.
  `/v1/agents/rundata` lists the agent's tunnels (name, `display_address` = what players
  type, `agent_config` with `local_ip`/`local_port`, `disabled_reason`), pending ones, and
  `permissions {is_self_managed, has_premium, account_status}`.
- **Running the agent**: 1.0 splits it into `playitd` (the daemon) and `playit` (CLI/TUI).
  Headless: `playitd --secret <key>` or `--secret-path <file>` (their Docker image runs
  `playitd --secret "$SECRET_KEY"`). MineShell would run it as one more user unit next to
  the server units, the secret in a file under `$DATA`, the binary downloaded from the
  GitHub releases like Java.
- **The open question: can MineShell create tunnels?** The client library has
  `/v1/tunnels/create` (type `minecraft-java` or a custom TCP port, origin = this agent +
  local port), `/v1/tunnels/config` and `/tunnels/delete`, but nothing in the agent calls
  them. playit staff said in August 2026 that agent keys are read-only for tunnel creation
  and account API keys are "not available for that purpose" (discuss.playit.gg, "Account
  level API key"). One panel (CloudGate, Oct 2026) says it creates tunnels with the agent
  key; another (hearth-panel) could not confirm it and has the user make them on the
  dashboard. The `self-managed` agent type and `is_self_managed` hint that such an agent
  may manage its own tunnels. Only a real account can settle it: claim a self-managed
  agent and try `/v1/tunnels/create`.

**Settled 2026-10-09 on the user's free account** (agent claimed as `self-managed`; the
claim page itself says the agent can create tunnels):
- `/claim/setup` + `/claim/exchange` work as above; rundata then says `is_self_managed:
  true`, `has_premium: false`, `account_status: "verified"`.
- **The agent key creates and deletes tunnels.** `/tunnels/create {name, tunnel_type:
  "minecraft-java", port_type: "tcp", port_count: 1, origin: {type: "agent", data: {agent_id,
  local_ip, local_port}}, enabled, alloc: null, firewall_id: null, proxy_protocol: null}` ->
  `{id}`; `/tunnels/delete {tunnel_id}`. It answers `AgentVersionTooOld` until the agent
  program has connected once (the claim's version string is not enough). `/v1/tunnels/create`
  and `/v1/schemas/get` reject every body as "failed to parse body": the server does not
  match the published client there, so the old endpoint is the one.
- `/tunnels/list {tunnel_id, agent_id}` has the allocation (shared IP, port, region
  "global", `assigned_domain`) and `tcp_alloc {allowed: 4, claimed, desired}` /
  `udp_alloc` - the free plan's ports (4; 16 with premium, the user's reading of the site,
  2026-10-09; whether TCP and UDP count separately is still to see). rundata's `display_address` is a hostname
  (`fried-ministries.tun.ply.gg`) that works on the default port: a Minecraft handshake to it
  reached a local listener through the running agent and the reply came back. No SRV record.
- Running the agent: `playit-linux-amd64 --secret-path <file> --socket-path <path>
  --log-path <file>` (the secret file holds the bare key). The IPC socket path must fit
  sun_path (108 bytes): `$XDG_RUNTIME_DIR`, not under `$DATA`.

Plan that works either way: link by claim; if creating works, a per-server "Make public"
toggle creates a `minecraft-java` tunnel to its port, updates it (`/v1/tunnels/config`)
when the port changes and deletes it with the server. If not, the user makes tunnels on
playit's dashboard pointing at this agent, and MineShell matches them to servers by
`local_port` = `server-port` (what hearth-panel does). Either way the server page shows
`display_address`, and a tunnel whose port matches no server is listed as unassigned.
Free plan limits (tunnel count, regions) were not checked.

### Data packs from the mod browser

Built (`mods/datapacks.ts`). The versions list asks Modrinth for the server's loader or
"datapack"; a version without the server's loader but tagged datapack installs into
`<level-name>/datapacks/` (created before the world exists, so world-generation packs apply
from the first start), tracked in `instance_datapacks`. The Mods tab lists that folder (from
the browser, from the modpack, or added by hand) with Remove; vanilla servers get the browser
for data pack releases.

Saved for later (October 2026):
- CurseForge data packs: a separate class ("Data Packs") the mod browser does not search; the
  mirror's coverage of it is unchecked.
- Updates for data packs: `instance_datapacks` has project and version ids, so the mod update
  check could cover them. A world-generation pack the world has loaded needs care on update
  (removed or renamed biomes break loading, the same way removing the pack does).

### Item icons in the player editor

**Built (2026-10-09)** (`itemicons.ts`, `lib/shared/itemicon.svelte.ts`). Textures and
models are read from the server's mod jars and from the Minecraft client jar (downloaded once
per version into `$DATA/cache/minecraft-client/`, only after the per-server EULA answer shared
with the Map tab; mods' own items get pictures without it). Items resolve as the game does:
1.21.4's `items/` definitions (with tints), else item models up their parent chain; flat
items as layers, blocks as their boxes, drawn in the browser turned by the model's own GUI
rotation (blocks 225, stairs 135). Vanilla chests are drawn from their entity texture; other
things the game draws in code (shulker boxes, heads, Tinkers' tools, Chisel's connected
textures) keep their name as text. 1.12 damage variants:
vanilla from a table; mods by their usual model names and Forge blockstate variants - a
variant picked for a damage value is flagged as a guess (user's call), a plain item model with
damage is taken as wear. On a copy of the user's MeatballCraft inventory: 408 of 508 items
pictured, 84 flagged. The item picker is built too: every item the server knows (1.12: Forge's
registry in level.dat; newer: 1.21.4 item definitions, else item models), named from the
language files, searchable by name or id (every word anywhere, ranked), with icons. Desktop:
a game-style tooltip on hover (name or custom name, enchantments, lore, unbreakable,
durability - vanilla's maximum from a table, 1.20.5's max_damage component; 1.12's damage
called a variant or damage - energy by the usual NBT keys, the id) and item lists (Baubles,
Curios, backpacks) as inventory-sized slots; phones keep wide cells with icon and name (the
user's call, 2026-10-09).

Names and icons pass of 2026-10-09 (the user's reports on MeatballCraft and ATM10): a pack's
own `resources/` and `kubejs/assets/`; case-insensitive and escaped-colon lang keys; mod keys
before vanilla's bare ones; 1.12 variants named (mods by the picked variant, vanilla by a key
table); models in subfolders; textures numbered by damage; lang templates ("%1$s Dust") with
their gaps marked; icons fill the slot on a desktop; requests batched (500) and closed
sections loaded on opening. MeatballCraft (20494 items): named from the id 16089 -> ~13350,
without a picture at damage 0 4792 -> 3518. Paused there (user's call, "most of the low
hanging fruit"). Left for another pass: names a mod links to its id only in code
(advancedrocketry:advrocketmotor is tile.advRocket), variants that exist only in code
(Actually Additions crystals, Mekanism basic blocks), shulker boxes, heads, banners' patterns,
templates' filled-in text.

Shulker boxes built 2026-10-09 (all versions; the trident's flat inventory picture on 1.21.4+
and 26.x's `{ sprite }` textures with them). A survey of every vanilla item (1.12.2, 1.21.1,
1.21.11, 26.3) left only what the game draws in code: beds (before 26.x, which made them
models), banners (16; patterns come from the item's data), heads and skulls (7; a player head
would want the skin from its profile), the shield, the conduit, the decorated pot (1.20+), and
the copper golem statues (1.21.9+). The shield built the same day (plain; a shield's banner
pattern is not drawn), then all the rest (`entityicons.ts`): every vanilla item of the four
versions now has a picture. Banners are plain, in their colour (patterns: the user's call, not
for now); a player head shows Steve, not the skin its profile names. Not built: banner patterns
on banners and shields, player heads' own skins.

### A map of the world

Wanted (2026-10-08): seeing the world from the browser, modded worlds included, preferably
without adding a mod to each server; a mod is acceptable where nothing else works, and
offered as an extra where it adds something. Not built; checked 2026-10-08:

- **BlueMap's CLI** (no mod; 3D web map, three.js). Renders from the world files and reads mod
  jars and data packs found in the server files for modded blocks; some modded blocks need a
  config the CLI cannot work out without the running game
  ([Configuring mods](https://bluemap.bluecolored.de/wiki/customization/Mods.html)). Worlds
  **1.13 and newer only** (1.12.2 support was dropped long ago). Java 21 for 5.4+. Vanilla
  textures need the client jar (EULA question).
- **BlueMap as a mod** (1.13+): what it adds over the CLI is the running game - the map
  updates as chunks change, live player markers, and the game's own registries for modded
  blocks. Worth offering as an option for modern servers.
- **uNmINeD's CLI** (no mod; flat 2D web map). Java Edition **1.0 to current**, so 1.7.10 and
  1.12.2 too. Since 0.19.58-dev (March 2026) it reads block metadata from mods and colours
  modded blocks from their averaged textures (needs the client jar). Incremental: re-running
  renders only changed regions. Builds for Linux glibc/musl x64 and arm64. Caveats: closed
  source, free for personal use, "do not distribute" - MineShell can only fetch it from
  unmined.net when asked (the licence says nothing about other programs running it); only
  dev-channel builds are listed; untested whether its mod support covers pre-1.13 worlds,
  whose block ids are numbers mapped in level.dat (Forge's FML registries).
- **Map mods for old versions**, if nothing standalone works: Dynmap for Forge 1.12.2, and
  for 1.7.10 the GTNH Web Map (GT New Horizons' Dynmap fork, tuned for 1.7.10 mods) - which
  fits the GT New Horizons install option.
- **MineShell's own top-down renderer** (region and NBT reading exist): every version, flat
  only, a lot to build well. Kept as the fallback idea.

**Built (2026-10-09):** BlueMap's CLI for 1.13+ (`worldmap.ts`, the Map tab), its update
schedule, and the mod maps (Dynmap + DynmapBlockScan on 1.12.2, the BlueMap mod offered on
1.13+), passed through MineShell (user's calls: behind its login, the EULA asked per server,
updates by button plus an optional schedule). Not built: GT New Horizons' map (with its install
option), a map for other pre-1.13 versions. Rejected (user, 2026-10-09): players on the
rendered map (MineShell writing BlueMap's `live/players.json` from RCON) - the BlueMap mod
shows live players already, and installing it is the answer for anyone who wants them.

**Decided (user, 2026-10-08):**
- 1.13 and newer: BlueMap's CLI is the default (no mod); the Map page offers installing the
  BlueMap mod for what it adds (live updates, player markers, modded blocks from the game).
- GT New Horizons: its own GTNH Web Map, when the GTNH install option is built.
- 1.12.2: Dynmap (mod) or uNmINeD's CLI (no mod), to be decided by testing both on a
  copy of MeatballCraft's world.

Tested 2026-10-08: uNmINeD 0.20.11-dev on a copy of MeatballCraft's overworld (1.12.2,
Cleanroom) failed on every chunk ("Cannot use BeginChildren() on tag type IntArray").
MeatballCraft runs RoughlyEnoughIDs, whose chunks store `Biomes` as an int array and give
each section a `Palette` (int array) of extended block ids next to `Blocks`/`Data`; JEID did
the same before it. uNmINeD reads only the vanilla 1.12 layout, so it cannot map big 1.12.2
packs that raise the id limit. Dynmap runs inside the game, after RoughlyEnoughIDs has
patched it, so it is the option for 1.12.2. A renderer of MineShell's own would have to
decode the RoughlyEnoughIDs palette too.

Tested 2026-10-08 on meatballcraft-cleanroom (Cleanroom 0.5.17, Java 25): Dynmap
3.7-beta-6 for Forge 1.12.2 loads, finds the overworld and every modded dimension, and
renders with textures (`dynmap radiusrender world x z r` over RCON: 300 blocks around spawn,
then 200 around the base in 3.6 min). Web server on 8123. But on its own it only knows vanilla
and a few built-in mods: most modded blocks rendered black (the user checked against the real
base). **DynmapBlockScan** (dynmap.us/builds/DynmapBlockScan, 3.4-beta-1 for 1.12.2) fixes
that: it reads the mods' block states and JSON models at startup and generates Dynmap's render
data; after it, builds, modded trees and machines showed. It skips 3D `.obj` models (Blood
Magic's routing nodes logged so). So 1.12.2 = two mods, Dynmap + DynmapBlockScan.

Found on the way: a world from an older pack version stops at Forge's "missing registry
entries ... /fml confirm" prompt before RCON is up, so MineShell's console cannot answer and
the server sits "starting" (the 10-minute stuck warning fires). Worth recognising that line
in the journal and offering "Confirm and start" (a one-off start with
`-Dfml.queryResult=confirm`) or cancel. Shared with item icons: the client jar download and reading
textures out of mod jars.

### Item and enchantment names in the player editor

Enchantments: built (2026-10-07, `enchantnames.ts`). On 1.12-or-older worlds the editor's
picker lists the world's table from `level.dat` by name (vanilla's names built in, mod ones
from their lang files with likely keys, otherwise made from the id) and writes the number.
On MeatballCraft: 132 enchantments, every number to an exact id. Item names came later with
the item icons (above, `itemName`).
The original note:

The editor shows item ids (`thermalfoundation:material`) and, on 1.12 and older, mod
enchantments as bare numbers (only vanilla's numbers are mapped, `LEGACY_ENCHANTMENTS`).
Both can come from the server's own files. Checked 2026-10-06 on `meatballcraft-cleanroom`:

- **Enchantment ids, exact (do first)**: Forge (and Cleanroom) keep each world's number -> id
  table in `level.dat`, `FML.Registries` -> `minecraft:enchantments` (`ids`: `{K: "<mod>:<name>",
  V: <number>}`). MeatballCraft's lists every mod's enchantments (`cofhcore:soulbound`,
  `abyssalcraft:coralium`, ...). Numbers are per world, so the table must be read from the
  world the player file belongs to, never shared. Writing an enchantment by id maps back
  through the same table. `minecraft:items` is there too (needed only for numeric item ids,
  which 1.12 player files do not use).
- **Display names, heuristic on 1.12**: the English text is on disk - the 1.12.2 server jar
  carries vanilla's `assets/minecraft/lang/en_us.lang`, and 269 of MeatballCraft's 342 mod
  jars ship an `en_us.lang` (some `en_US.lang`). The lang key comes from the mod's code, not
  from the id, and often depends on the damage value (wool colours, ores), so the lookup tries
  likely keys (`item.<mod>.<name>.name`, `tile.<mod>.<name>.name`, the same without the mod
  prefix) and falls back to the id. Enchantment keys (`enchantment.<name>`) are more regular.
- **1.13+, nearly exact**: the key follows the id (`item.<mod>.<name>` / `block.<mod>.<name>`),
  JSON lang files in the jars; vanilla's are in the client jar (as for item icons above), so
  vanilla names on modern versions need that download or stay ids.

Shares the jar-reading with item icons above: one index of `mods/` (lang files, textures)
cached by the jars' sizes and dates.

### Installing without building

Built (October 2026): GitHub releases carry a ready-to-run archive (built, with runtime
`node_modules`) and `install.sh`, which installs it as the `mineshell` user service and
updates it when run again (`curl .../releases/latest/download/install.sh | bash`). Chosen
over an npm package (publishing to npm, still needs a global install) and Docker or
distribution packages (systemd user units and the journal do not fit a container; packages
are upkeep). Not built: installing Node for the user (the installer says how to get it).

Updating from inside MineShell: built the same month (Settings > Updates; ARCHITECTURE,
"Data"). A check every 12 hours, shown in the top bar; installing waits for the Update
button. Not built: installing updates automatically, and going back to an older release from
the page (the installer does it with `MINESHELL_VERSION`).

### Start servers at boot

Built (October 2026; `bootstart.ts`, ARCHITECTURE "Servers after a reboot"). Decided: MineShell
starts them after a new boot (kernel boot id), after recovery, one at a time; per server
"if it was running before" (default, also in New server defaults) / always / never; the
database holds it (clones get the setting, never "was running"). The original note:

Servers did not come back after the host reboots: only MineShell itself is started at boot
(`docs/DEPLOYMENT.md`), and nothing ever runs `systemctl enable` on an instance unit.
`enableUnit` and `isUnitEnabled` in `systemd.ts` exist but nothing calls them, and the
template already has `WantedBy=default.target`, so enabling `<prefix>@<id>` would work.
Open questions before wiring a per-server toggle: whether enabled state lives in systemd
only or also in the database (clones, recreated servers with the same id), how it interacts
with a crash loop at boot, and whether MineShell should start them itself after boot
instead. Noticed in the October 2026 sanity pass; parked for a later look.

### mclo.gs as a second opinion on crashes

Built 2026-10-08 (`mclogs.ts`, the Logs tab). Since this was written mclo.gs gained
`POST /1/analyse`, which analyses without keeping the log, so the second opinion publishes
nothing; sharing is a separate button (public 90 days, IPs and home folders masked by
mclo.gs, deletable with the kept token). Deleting a server forgets its shares; the logs
expire on mclo.gs by themselves. The original notes: mclo.gs (Aternos) pastes Minecraft logs and analyses them:
`POST https://api.mclo.gs/1/log` (JSON `{content, source, metadata}`; up to 10 MiB and 25,000
lines, truncating client-side recommended) returns `id`, `url`, `raw`, an error count, an
expiry (~90 days) and a delete `token`; `GET /1/log/<id>?insights` returns
`insights.problems` (each with solutions) and `insights.information`; `DELETE /1/log/<id>`
with `Authorization: Bearer <token>` removes it. There is no analyse-without-uploading
endpoint in the current docs, so every analysis publishes the log at a public URL - logs hold
player names and can hold IP addresses.

Shape: user-triggered only, never automatic. An "Analyse on mclo.gs" button on a crashed run
(Logs, Recent crashes), saying the log becomes public; the run's log (trimmed to the limits,
the end kept) is uploaded with `source` MineShell; mclo.gs's problems and solutions shown beside
MineShell's own diagnosis, with the link to share; id, url and token kept on the run
(`server_runs`), and "Delete from mclo.gs" using the token. To check first: whether mclo.gs
already strips IPv4/IPv6 addresses (it may), else MineShell masks them before sending.
Useful mostly where `crashdiag.ts` recognises nothing ("Cause not recognised").

### UI redesign (October 2026)

The October 2026 redesign (Claude Design, "MineShell Redesign") is built: shell, instance
header with actions, overview, console, logs, mods, world, players, files, one Settings tab
per server, the three-step Add a server flow, MineShell settings in tabs, the player editor.
Built after it: "gave up after N tries" in the rail, the world's size on the overview,
segmented buttons for difficulty and game mode, the likely cause of a crash on its server
card, the item editor beside the inventory grid, the updated date and licence in the mod
detail pane (licence from Modrinth only; CurseForge has none) and a note per available
update (from Modrinth changelogs; the CurseForge mirror's version lists carry none), a game
port field and an EULA checkbox when adding a server, folders expanding in place in Files. The
snapshot list on two lines a snapshot (2026-10-22, the user's pick of the options): what it is
with its tags first, then date, size, pack and "ran on" (only when it differs, in amber) under
it, so the label no longer wraps in a column squeezed by the buttons. The main actions stay in
the row (Pin, Edit, Restore, Delete; under 60rem only Pin and Restore, under the summary), the
rarer ones go in a ⋯ menu (`RowMenu.svelte`: Download, New world, and in narrow windows Edit and
Delete too; user's call). The backup folder's list has the same rows. These parts of the mockup need data or
behaviour MineShell did not have, so they were left out rather than faked:

- **Peak players today** (overview strip) and **how long each player has been online**
  (Online now): built (2026-10-07, `history.ts`) from the console's join/leave lines, kept
  in the database; the Players tab also shows each player's playtime and last seen.

### Mod updating

Built: "Update mods" (check, review, update; world snapshot per the policy) and switching
one mod to any compatible version, older ones included (world snapshot opt-in), journalled
as `mod-update`. On a modpack server both are greyed out until a toggle is turned on.
Not built from the original design:

- Downgrade/disabled-mod options: built (2026-10-08): disabled mods start unticked in the
  update review; ticked, they are updated and stay disabled.
- Built (2026-10-08): a new version's (or a dependency's) `incompatible` declarations are
  warned about in the review and the task's status (Modrinth only: the mirror's dependency
  lists have no such type). A dependency only the old version required, which no other
  enabled jar requires (its own metadata), is offered to be disabled, ticked, in the same
  journalled change. Pack mods and locked ones are never offered.

---

## Near term

Agreed order: the rest of this list roughly as written. (World snapshots, world tools,
server copies, Java downloads, mod updating, the smaller operational features -
countdown stops, TPS, scheduled commands, resource limits, stuck-start warning, log
history, server icon - the modpack install refinements (mod list with client-only
choices before installing, "Install & start") and the player data editor are built.)

Not covered by the install form's mod list: uploaded packs (installed straight from the
upload; the client-only check still runs afterwards), and client-only mods only the jar
declares (known once downloaded; the same check catches them).


---

## Brainstorm, October 2026

A list of ideas from a brainstorm, checked against the code on 2026-10-04. Where an idea was
already built, or already has an entry elsewhere in this file, that is noted, so it is not
re-proposed or built twice. Pointers in it ("under Later", "above") are to
the roadmap of the time: those entries are now in ROADMAP.md or under Built above.

### Already built (listed in the brainstorm, nothing to do)

- **Scheduler upgrades**: scheduled restarts wait while players are online, for up to an
  hour per cycle (`scheduler.ts`), and warn in-game at 15/10/5/1 minutes
  (`restartWarnMinutes`). Countdown stops/restarts: `countdown.ts`.
- **Mod diff before an update**: the pack change preview (`PackChangePanel`) lists every
  pack mod and data pack as `+`/`~`/`−`. The "Update mods" review shows `current → target`
  for each mod.
- **Mod list view**: the installed list on the Mods tab links each mod to its project page
  and flags client-only ones. Loader is per server. The crash analyzer reads the jars itself
  (`crashdiag.ts`) and does not need this list.
- **Start-time Java resolution**: `start()` runs `syncUnit()`, which resolves Java again and
  rewrites the unit's env file, so the unit cannot go stale (see "Default Java per major
  version" below for what is still missing).
- Also built: crash analyzer, auto-restart, CPU/RAM graphs, the whitelist/ops/bans lists,
  the `server.properties` editor, snapshot pinning, and a basic audit log (the `audit_log`
  table; Settings shows the newest 40 entries).

### Next up

- **Spark profiler flow**: built (`spark.ts`, the Spark profiler panel on the overview).
- **Spark as a TPS source**: not possible over RCON. Spark runs every command on a worker
  thread, so RCON has already returned when Spark answers, and `spark tps` replies only to
  the sender: the answer is dropped (vanilla clears the RCON buffer at the next command).
  Only broadcasts reach the console. The servers this would help are Fabric/Quilt/vanilla
  before 1.20.3 (no `tick query`). Ways left, none cheap: a stdin channel into the server
  (a FIFO as the unit's StandardInput, so commands run as the console), or a small
  companion mod. Not planned.

### Agreed

- **Chunky integration**: built (`chunky.ts`, World tab). Start a square or circle around a
  center in any dimension, live progress (ETA, rate), pause, continue, cancel, continue
  unfinished tasks, and pausing while players are online (MineShell's scheduler, English
  Chunky only). Time windows: scheduled commands `chunky continue` / `chunky pause`.
  Chunky has no 1.12 build.
- **Console enhancements**: built. Level filters, "only players joining and leaving",
  search with highlighted matches, stack traces folded under their error, ANSI colour codes
  stripped (modern Forge), the server's lines about RCON connections hidden by default
  (MineShell's own polling floods them), command history kept per server in the browser,
  and saved commands per server (`macros.ts`, copied with a server copy). Autocomplete was
  left out: RCON cannot ask Brigadier for completions, and a fixed list would not know mod
  commands. The Logs tab's search is "Log search" under Agreed for later (built).
- **Ban UI, the rest**: built. Ban reasons, IP bans (`banned-ips.json`; by address while
  stopped, by online player while running), Ban / Ban IP next to Kick, operator levels and
  player-limit bypass (picked and changed only while stopped: vanilla has no command for
  them and keeps ops.json in memory).
- **Disk usage breakdown**: built (`diskusage.ts`, Files tab > Disk usage, or the overview's
  "Disk used"). The world per dimension (vanilla, 1.12 `DIM<n>` and named mod folders,
  1.16+ `dimensions/<ns>/<name>`, Bukkit siblings), snapshots and MineShell backups,
  `old-configs/` per version, logs, mods, loader, the rest; suggestions point to where to
  act, and archived logs/crash reports older than 30 days can be deleted from there.
- **Default Java per major version**: built. A pinned path wins, then the runtime set as
  default for the major (Settings, "Servers use" column), then the newest build of it, with
  the path between equal builds. The overview and the server's Java picker say which applied.
  Resolution at start time already existed (`start()` rewrites the env file).

### Later

- **Three-way config diffs on pack update**: built (2026-10-08, `configmerge.ts`). Decided:
  clean merges apply on their own; overlapping changes take the pack's lines and are listed
  for review (Settings > Modpack: compare, use mine / the pack's); the user's own files in
  pack folders are carried over; a server without saved originals reads its installed
  version once.
- **World tools**: dimension reset is built (World tab; `dimensions.ts`, `resetDimension`).
  The overworld means its terrain (region, entities, poi); level.dat, player data and the
  world's data stay. Chunk pruning is built too (`chunkprune.ts`, World tab): chunks whose
  InhabitedTime is under a threshold go from region/, entities/ and poi/, files rewritten
  compactly; optionally keeping a radius around spawn; counted first, run as a world change
  into a partial snapshot. LZ4-compressed chunks (1.20.5+ option) cannot be read and stay.
- **Granular snapshot restore**: built for one dimension (`restoreDimension`); a region of
  one is not. A dimension reset keeps a partial snapshot (`partial: true`), whose restore
  puts back only those folders.
- **Scheduler hook**: run a script after a snapshot.

### Maybe someday

- **Notifications (Discord/webhook)**: see "Notifications" under Later.
- **Client pack export**: built (October 2026; `packexport.ts`, the server's Export page):
  Modrinth, CurseForge and Prism Launcher formats. Different from "Instance export and
  import" below, which moves a server between machines. Not done: a pack icon (none of the
  formats has a place both launchers read), CurseForge fingerprint lookups to link
  manually added jars in a CurseForge pack (needs the official API key), packwiz.
- **Player stats** from `<world>/stats/<uuid>.json`.
- Multi-user roles: out of scope at the time; built later ("Accounts and permissions", above).

### Undecided

- **Read-only status page**, mainly worth it together with a **join page** (address,
  version, pack download).

### Suggested, not yet confirmed or rejected

- **RAM guard on start**: refuse or warn when the heap plus other running servers exceeds
  free memory. Nothing reads `/proc/meminfo` today.
- **Port management**: same as "Multi-instance port management" under Later. Start already
  refuses when a port is taken by something else.
- **Sleep when empty**: `pause-when-empty-seconds` on vanilla 1.21.2+. For older and modded
  versions, it is unknown which loaders honour it.
- **Mod bisect assistant**: built (2026-10-07, `bisect.ts`, Mods tab): see ARCHITECTURE,
  "The mod bisect assistant". The note: disable half, start, narrow down. It could build on the crash
  analyzer and the journalled mod toggles.
- **Update availability checks**: mods have one (`modupdates.ts`). Missing: a newer pack
  version, loader build, or Java update shown on the overview.
- **Log rotation and retention**: nothing deletes old `logs/` or `crash-reports/` on its
  own; the disk usage page offers to delete archived logs and crash reports older than 30
  days.
- **Server bundle export/import**: the same as "Instance export and import" under Later.

### Agreed for later (2026-10-07)

Suggested after the client pack export and reboot handling; all wanted.

- **Start-time history**: built (2026-10-07, `history.ts`): the overview's Uptime shows the
  last start against the usual, the Logs run list each run's. The note: how long each start took to reach `Done (`, per run, with the
  trend on the overview ("4 m 10 s, usually 2 m 30 s"), so a pack update or a new mod that
  slows startup shows. The journal has both timestamps (the unit's start, the `Done (`
  line); reading them per invocation like `runFinishedStarting` avoids walking old runs.
  Pairs well with player history, which also wants console lines kept over time.
- **Crash history**: built (2026-10-07, `history.ts`): crashed runs marked by the overview's
  rule, each put through the crash analyzer once; Recent crashes on the overview (with the
  cause that repeats), causes in the Logs run list. The note: the overview shows only the last crash (`lastcrash.ts`). Keep each
  crash with its diagnosis (culprit, cause line) and date, and list them, so a pattern
  shows ("every few days, always the same mod"). A small table, filled when the monitor
  sees a crash, rather than re-diagnosing old runs from the journal each time.
- **Memory advice**: built (2026-10-08, `heap.ts`, `memoryadvice.ts`): the heap read over the
  JVM's attach socket, since the cgroup's memory cannot tell. An `OutOfMemoryError` in a run, or memory sitting near the heap limit
  (the overview's samples), suggests more heap; a heap never half used suggests less, judged
  only from hours with players online (2026-10-10, the user: an idle server's 2 GB says
  nothing when players take it to 8). Since 2026-10-15 that means 5 hours of actual play
  on 3 days: three short sessions on irithyll passed for 3 "played hours" (any clock hour
  with 20 minutes of play counted whole) and suggested 3 GB of 8.
  Shown on the overview and next to Java & memory in Settings. Advice only, never changes
  the setting by itself. Related: the RAM guard and the resource cap above.
- **Scheduled snapshots**: built (2026-10-08, `snapshotschedule.ts`), both modes, with the
  file-quiet wait below for old Forge. A world snapshot on a schedule ("nightly at 4:00"), kept by the
  existing retention policy. The narrow case of "World backups" above, still local only.
  Snapshots today are only taken with the server stopped. Two modes, per schedule:
  - *While running* (default): the consistency dance that section describes (`save-off`,
    `save-all flush`, copy, `save-on` in a finally), as the running-world download already
    does. Players keep playing; the world just is not autosaved during the copy. Things to
    check: mods that write their own files outside the world's save cycle, and whether
    `save-all flush` is honoured on old Forge (1.12 has no `flush` argument and saves
    asynchronously, so it would need waiting for the "Saved the game" line).
  - *Stop, snapshot, start*: for when a live copy is not trusted (or the checks above fail
    for a pack). One scheduled action does it all: countdown warnings like a scheduled
    restart, stop, take the snapshot, start again as soon as it finishes - only if the
    server was running when the schedule fired. No separate scheduled start with a guessed
    gap, which either cuts the copy short or keeps the server down longer than needed.
  A stopped server is snapshotted as it is either way. Shown as a task in the notification
  center; a failed copy still restarts the server (and says the snapshot failed).
- **Chat in the console**: built (2026-10-08): a Chat chip and a chat send mode. A filter showing only player chat (`<name> message` lines and
  `[Server]` messages), and sending as the server with `say`. The console already sorts
  lines by kind (`consolelines.ts`), so it is a new kind plus a send mode.
- **Log search**: built (2026-10-08, `logsearch.ts`): one search over every run in the
  journal (`journalctl -g`, escaped, any case) and every log file, archives included; the
  open log lists its matching lines from all of it, not only the end shown. The Logs tab (past runs and log files) cannot search; only the live
  console can. Searching a run reads it from the journal by invocation; log files and
  gzipped archives are read from disk.

### Dropped

- Panel hardening (it is LAN-only; remote access stays the Tailscale route below), idle
  auto-stop (wake-on-connect needs too much machinery), a fuller audit log beyond the
  existing one, adopting an existing server.
- Full world backups: since built as backup folders ("World backups to another place", above).

---

## Reported bugs, October 2026 (fixed)

Reported 2026-10-07 and 08; all fixed 2026-10-08.

- **Built: console page froze on a starting ATM10 server.** Every line re-filtered and
  re-rendered the whole buffer; lines now go in every 50 ms as one batch.
- **Built: the "RCON connections" console filter did nothing** on NeoForge, whose lines carry
  a `[minecraft/GenericThread]` logger tag; the chip now also shows them with the level
  chips off.
- **Built: uploading in Files jumped back to the server's root folder.** SvelteKit 3 forms
  posting `?/x` dropped the page's query; every page now uses `#lib/shared/forms.ts`.
- **Built: ATM10's Curios lists in the player editor** (one Stacks and one Cosmetics list per
  slot type, 42 in all, all labelled alike): one closed Curios section, rows named by slot
  type, empty ones behind a checkbox.
- **Built: drag and drop in Files**, files and whole folders, into the folder being shown.
  Since 2026-10-08 on every upload (world zip, pack file, new-server pack, mod jars, icon),
  each onto its own section rather than the whole window (`lib/shared/dropzone.ts`).
- **Built 2026-10-10: Forge 1.12 waiting on "/fml confirm" at startup.** MeatballCraft
  (Cleanroom) stopped after a pack update over 17 missing blocks/items/sounds and nothing
  could answer: a unit has no console input and RCON is not up yet. Two ways were weighed:
  a notice that answers by starting once with `-Dfml.queryResult=confirm`, or giving units a
  stdin (FIFO socket unit). The user picked the notice; the snapshot before it is on by
  default and can be unticked, and it covers all three questions Forge 1.12 asks (missing
  registry entries, missing registries, backup level.dat). Stdin stays an option if console
  input before RCON is wanted for its own sake.

