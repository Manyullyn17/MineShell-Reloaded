# Roadmap archive

Finished work: built features with the notes and decisions behind them, historical planning
lists, and fixed bug reports. Open work is in [ROADMAP.md](ROADMAP.md), including what a
built entry here leaves out ("Not built: ..."). Some historical lists below mention ideas
that were undecided or deferred at the time; ROADMAP.md says where each stands now.

When something on the roadmap is built, its entry moves here with its notes.

## Built

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
port field and an EULA checkbox when adding a server, folders expanding in place in Files. These parts of the mockup need data or
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
- Full world backups: since planned as external backups (ROADMAP.md, "World backups").

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

