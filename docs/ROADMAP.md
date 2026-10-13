# Roadmap

Current and deferred work, with the reasoning behind decisions. This is not a schedule.
Historical brainstorms and fixed bug reports are kept in [ROADMAP-ARCHIVE.md](ROADMAP-ARCHIVE.md).

## Current direction

The next major update is planned around plugin servers (Paper and Purpur), after the
modded-server and general feature work is considered finished. GT New Horizons also has an
agreed install-flow plan. Other ideas below remain later or undecided; none has a delivery
date.

External world-backup integration is a future plan, but the provider and design are not
settled. Current snapshots remain local to the server disk. This is an accepted limitation
for now, rather than a current blocker.

Portability notes: Java downloads on ARM64 and musl/Alpine are not tested because development
hardware is x64 with glibc. Quilt loader version switching should get testing, but it is
deferred and is not a current priority.

---

## Not built yet

### Accounts and permissions (in progress)

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
passwords with a forced change, disable, sign-out everywhere); (6) creator becomes admin;
(7) show only what an account may use; (8) close open console/task streams when access
changes; (9) record who did what in the audit log.

### World backups

Not implemented yet. External backup integration is planned for the future; its provider
and exact design are still undecided. The existing snapshots are useful for local recovery,
but remain on the same disk as the server. A running-world backup must preserve consistency:
flush and pause saving, copy, then always restore saving even if the copy fails.

Note there is already a *different* backup mechanism in the codebase: an update moves the
replaced mod jars aside (the `mod-update` journal) so a failed update can be rolled back. That operates on the
mods directory only and has nothing to do with world saves. The two were conflated in the
original notes; they should stay separate.

The narrower case is built: a world snapshot before MineShell's own risky operations, and
snapshots on request or schedule from the World tab (`snapshots.ts`, `world.ts`), kept by
count and storage per server.
There the server is always stopped, so the consistency problem above does not arise. The
World tab's download of a running server's world does the save-off / save-all flush /
save-on dance, with save-on in a finally.

---

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
