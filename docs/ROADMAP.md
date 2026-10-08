# Roadmap

What is not built, why, and roughly what order it makes sense to build it in - and, where an
idea turned into something built, a line saying so, so it is not proposed again.

This is not a schedule. It is a record of decisions so that future-you does not have to
re-derive the reasoning, and does not accidentally build something in an order that makes
it harder.

---

## Deliberately not built

### World backups

Decided against in the design notes and still not implemented. The reasoning: most
modpacks already ship a backup mod, and a half-built backup system is worse than none
because it invites trust it has not earned.

The known gap: a pack without a backup mod has no safety net at all.

If this ever gets built, the thing to get right first is not the copying — it is the
question that copying raises. A world save is only consistent if the server has flushed
it, so a real implementation needs `save-off`, `save-all flush`, copy, `save-on`, with a
guarantee that `save-on` runs even if the copy fails. Everything else is scheduling and
retention policy.

Note there is already a *different* backup mechanism in the codebase: an update moves the
replaced mod jars aside (the `mod-update` journal) so a failed update can be rolled back. That operates on the
mods directory only and has nothing to do with world saves. The two were conflated in the
original notes; they should stay separate.

Status: still a maybe. The narrower case is built: a world snapshot before MineShell's own
risky operations, and snapshots on request from the World tab (`snapshots.ts`, `world.ts`),
kept by count and by storage per server.
There the server is always stopped, so the consistency problem above does not arise. The
World tab's download of a running server's world does the save-off / save-all flush /
save-on dance, with save-on in a finally.

---

## Dependency order

Some of these unlock others. Rough ordering:

```
mod updates ──────────► duplicate detection across platforms
     │
     └────────────────► hash-based mod cache

notifications ────────► needs no new infrastructure, the event bus already exists

remote access ────────► depends on the auth model, which is now settled
```

Mod updates were the biggest unlock and are built, so both arrows on the left are open now.
Everything else is largely independent and can be done in any order.

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

### Mod updating: what is left

Built: "Update mods" (check, review, update; world snapshot per the policy) and switching
one mod to any compatible version, older ones included (world snapshot opt-in), journalled
as `mod-update`. On a modpack server both are greyed out until a toggle is turned on.
Not built from the original design:

- Downgrade/disabled-mod options: disabled mods are updated and stay disabled; nothing asks.
- Required dependencies are installed, but nothing checks `incompatible` ones or removes a
  dependency the new version no longer needs.

---

## Brainstorm, October 2026

A list of ideas from a brainstorm, checked against the code on 2026-10-04. Where an idea was
already built, or already has an entry elsewhere in this file, that is noted, so it is not
re-proposed or built twice.

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

- **Three-way config diffs on pack update**: the old pack config, the user's edited copy
  (now moved to `old-configs/`) and the new pack config.
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
- Multi-user roles: out of scope.

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
  (the overview's samples), suggests more heap; a heap never half used suggests less.
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
- Full world backups: see "Deliberately not built" above.

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

## Later

### Notifications

A Discord webhook on crash loops and scheduled restarts. The event bus in `events.ts`
already emits everything needed, so this is a settings form, a fetch, and a subscriber.
Deliberately kept out of v1 to avoid designing a notification framework for one webhook.

Moved from near term to later in October 2026.

### Duplicate detection across platforms

The same mod installed from both Modrinth and CurseForge appears twice with different
filenames and no shared identifier. Detecting this needs jar inspection — reading
`fabric.mod.json` or `META-INF/mods.toml` for the real mod id — rather than trusting
platform metadata. Worth doing after mod updates, since both want the same jar-inspection
code.

### Hash-based mod caching

Check a content hash before downloading and copy from an existing instance if it matches.
Explicitly deferred: it is an optimisation, not a correctness fix, and it partially
reverses the deliberate decision to always download fresh. If it happens, it must key on
*content* hash, never on version label — the whole reason for downloading fresh is that
packs ship patched jars under upstream version numbers.

### Instance export and import

The original design specified a `.jcpack` bundle containing mod metadata, overrides,
configs and instance settings, for moving an instance between machines. Still a good idea,
still not built. Its natural moment was after mod updating, since both depend on the mod
metadata being trustworthy; that is built now.

### Remote access

The auth question the notes left open is now settled: password plus session cookie, on by
default. That was the blocker for designing remote access, so it can proceed whenever it
is wanted. The recommendation in `docs/DEPLOYMENT.md` — Tailscale rather than a public
reverse proxy — is where this should land unless there is a specific reason otherwise.

### playit.gg tunnels

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

Plan that works either way: link by claim; if creating works, a per-server "Make public"
toggle creates a `minecraft-java` tunnel to its port, updates it (`/v1/tunnels/config`)
when the port changes and deletes it with the server. If not, the user makes tunnels on
playit's dashboard pointing at this agent, and MineShell matches them to servers by
`local_port` = `server-port` (what hearth-panel does). Either way the server page shows
`display_address`, and a tunnel whose port matches no server is listed as unassigned.
Free plan limits (tunnel count, regions) were not checked.

### Resource cap for all servers together

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

Headroom over the heap: `-Xmx` is the heap only; metaspace (grows with mod count), code
cache, thread stacks, GC bookkeeping (a few % of heap) and direct buffers come on top.
Measured 2026-10-05 on `irithyll` (Fabric, 65 mods, 10 GB heap): 890 MB resident outside
the heap. Big Forge packs load several times the classes, so more. The current per-server
check (`LIMIT_HEADROOM_MB = 512` in the instance settings route) is too little for that
server: a hard `MemoryMax` at heap + 512 MB would kill it. Proposal for both the per-server
check and the cap warning: heap + 1 GB + 10% of heap (4 GB -> 5.4 GB, 10 GB -> 12 GB),
to be checked against a big Forge/Cleanroom pack (MeatballCraft) before settling.

Also: add the per-server limits to the new-server defaults (`instance-defaults.ts`), which
they are not.

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

### Pack change preview: content in data-pack-loader folders

Folders like `config/paxi/datapacks`, `config/openloader`, `global_packs/` or `kubejs/`
are pack config folders, so a pack change moves them whole to `old-configs/` - including a
data pack the user added there. Correct by the configs policy, but easy to miss for a data
pack; the preview could point out non-pack files in those folders.

### Item icons in the player editor

Slots show item names, not pictures. Minecraft's textures are Mojang's, so MineShell cannot
ship them; they can come from the user's own machine instead. Mod jars in `mods/` carry their
textures (`assets/<mod>/textures/item/...`); vanilla ones are in the *client* jar, which
MineShell would download from Mojang for the server's version and keep locally (map renderers
like BlueMap do the same and ask the user to accept the EULA first). The work is mapping an item
id to a picture: flat items are one texture via their item model (`models/item/<id>.json`, or
`items/<id>.json` from 1.21.4), block items are 3D models needing a small isometric render,
and leather, potions or grass need tinting. Something decent for most items is reachable;
perfect for every model is not.

### Item and enchantment names in the player editor

Enchantments: built (2026-10-07, `enchantnames.ts`). On 1.12-or-older worlds the editor's
picker lists the world's table from `level.dat` by name (vanilla's names built in, mod ones
from their lang files with likely keys, otherwise made from the id) and writes the number.
On MeatballCraft: 132 enchantments, every number to an exact id. Item names are not done.
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

### Multi-instance port management

Ports are allocated automatically and conflicts are detected, but there is no view showing
what is bound where across all instances. Cosmetic until you are running enough servers to
lose track.

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

### UI redesign: what the mockup shows that is not built

The October 2026 redesign (Claude Design, "MineShell Redesign") is built: shell, instance
header with actions, overview, console, logs, mods, world, players, files, one Settings tab
per server, the three-step Add a server flow, MineShell settings in tabs, the player editor.
Built after it: "gave up after N tries" in the rail, the world's size on the overview,
segmented buttons for difficulty and game mode, the likely cause of a crash on its server
card, the item editor beside the inventory grid, the updated date and licence in the mod
detail pane (licence from Modrinth only; CurseForge has none) and a note per available
update (from Modrinth changelogs; the CurseForge mirror's version lists carry none), a game
port field and an EULA checkbox when adding a server, folders expanding in place in Files. These parts of the mockup need data or
behaviour MineShell did not have, so they were left out rather than faked:

- **Peak players today** (overview strip) and **how long each player has been online**
  (Online now): built (2026-10-07, `history.ts`) from the console's join/leave lines, kept
  in the database; the Players tab also shows each player's playtime and last seen.

---

## Considered and rejected

**Turning RCON off** (a switch in the redesign mockup's Network settings). MineShell sends
console commands, reads who is online, edits player lists live and stops servers cleanly
over RCON; without it most of the server tabs stop working. It stays managed: port and
password are MineShell's, `enable-rcon` is not offered.

**A versioned REST API.** No second consumer exists — no CLI, no bot, no mobile app. Form
actions and a few endpoints cover it. Revisit only if a second consumer actually appears,
not in anticipation of one.

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
client-list mods missing from its `mods/` as client-only - not installing from it. (GT New Horizons is the one exception planned, as its own install option: see "GT New
Horizons as its own install option" under Later.)
