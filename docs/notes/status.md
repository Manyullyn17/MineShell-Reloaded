# Status and open threads

Where things stood, what the user has yet to try and the state of their test servers, moved out
of CLAUDE.md (2026-10-20). Open work itself is `docs/ROADMAP.md`.

## Where it stands (2026-10-21, 0.30.2)

Heading for 1.0 (ROADMAP-ARCHIVE, "Road to 1.0"). Agreed 2026-10-21:
- World backups to another place (a folder on this machine first, no cloud, extensible) are
  the last feature before 1.0 (built 2026-10-22: backup folders); then a feature freeze and a
  release candidate. Then (2026-10-25) one more: the mod list export (ROADMAP-ARCHIVE, "Road to 1.0"),
  and the rest of the small builds on that list were done the same day. Feature freeze from
  0.33.0 (user's call, 2026-10-25): only fixes, then 1.0 once it is stable without big issues.
  Log retention moved to after 1.0. 0.33.16 is the release candidate (2026-10-30: the console's flicker during a start and its error counts; difficulty and game mode as numbers before 1.14, the four settings 1.21.9 made game rules; 2026-10-29: 0.33.11 to 0.33.14 the same evening, from the user's clicking around: Cleanroom suggestions and fixes, the copied server's sidebar, disk usage leftovers, "Last changed", the mod update list (Fugue matched to Cleanroom, disabled reasons, progress, a table), the Mods tab bar, Fugue picked by binary search and from CurseForge on CurseForge servers; before it 0.33.10: Minecraft 26 worlds' moved formats; 0.33.9 the same day: the leftover sweep's fixes, the snapshot note, the Chunky choices, Delete clicked twice; ROADMAP, "Feature freeze"; 0.33.8 on 2026-10-28: the fixes of a test review: crash safety, RCON, chat-proof console events, world upload limits, delete and server ids, outside links; before it 0.33.7: Add a server's layout, NeoForge builds for 26.x, Fabric and Quilt after Cleanroom, Minecraft versions down to 1.2.5; 0.33.6 the same day: settings pages, one save bar for MineShell settings; 0.33.5 and 0.33.4 too: the phone mods list, long names, clock changes, server.properties and JVM argument escapes), running on
  the real install for a week or two; what is left besides that is "Left for the user" below.
- The status page moves to after 1.0, with the item icon leftovers and per-world game
  settings. Plugin servers stay 2.0; GT New Horizons got its slot 2026-10-27 (below).
- Minor dependency updates before the freeze; TypeScript 7 waits until after 1.0.
- After 1.0 (2026-10-27): the work up to 2.0 is in ROADMAP, "Later", in a suggested order of
  steps (upkeep and quick wins first); GT New Horizons is step 8, after the general features
  and before the item icon leftovers and the status page.
- Long running is covered: the installed MineShell has run a server with scheduled restarts
  and snapshots since it was installed.
- arm64 and musl stay untested (no such hardware; home servers are nearly always x64). Only
  Java downloads and playit.gg's agent depend on them; a Java added by path works anywhere.

Route tests (2026-10-21): about 30 of ~230 form actions and 3 of 36 endpoints had one; most
actions are thin over `lib/server` code the flow tests cover. Done: `call()` for endpoints
in the route helper, sign-in and setup (`routes/login`, `routes/setup`), each Settings
section keeping what its form does not carry, with a server-rendered round trip of the
shared field components (`tests/helpers/forms.ts`; it found the restarts switch bug).
Then the raw uploads (world `PUT`, imports) and the input checks (`power`, `limits`,
`addCommand`, `settings/defaults.save`, `instances/new.loader`, `portChange`, `sftp`); these
found loader names like `toString` passing the loader checks (fixed). Not worth it:
read-only `/api` GETs, item icons, the Chunky, map and profiler buttons. A new test for
working code is checked by removing what it covers. Seen then and fixed 2026-10-25: a power
delay outside 1-3600 s acted at once instead of being refused, and Add a server answered a
bad game port with status 500.

Security and permissions pass (2026-10-21): no route without its check; fixed what reached past
its permission (management-server keys and level-name under "Change settings"), full-trust
tags on a server's admin, "May add servers" and MineShell admin, framing headers, the live
map's cookies, the raw editor's game port. Then the map on an origin of its own (sandboxed under
a token path; ARCHITECTURE, "The map's pages are not MineShell's"), checked in headless Chrome
on a real render and a running BlueMap mod.

Found while testing that, on real loaders, and fixed the same day: a new plain Cleanroom server
failed to install (the newest installer's options changed; loaders.md), Dynmap crashed plain
Forge 1.12.2, and the BlueMap mod on a Fabric server without a pack lacked Fabric API
(worlds.md). A new plain Cleanroom server now gets Fugue and Scalar Legacy at once (Cleanroom
0.7 asked about them at the first start).

## Left for the user

**1.2 beta checklist** (1.2.0-beta.1 released and installed on prod 2026-11-04). 1.2.0 once a
beta has run about three days with nothing big. Before beta.1: a quick pass on throwaway data
(2026-11-04, vanilla 1.21.11 moved to 26.3 and a Fabric 1.21.1 server; found and fixed the live
game rule/border read-back and the border centre). Release notes by hand, without fixes of
1.2's own features (7c4140d, cff1938, 99b4e76 and the Tailscale row's f7562a0 at least).

The user, on prod (a click or two each; what a real server, player or account brings):
1. **Updating itself**: beta.1 -> beta.2 with the button; then "Check for updates" and the
   release history shows beta.2 and beta.1 tagged Beta, with notes (bfda974).
2. **Players**: game mode and teleport (to a player, the spawn, coordinates) with a real player
   online, from the player drawer and the overview's Online now menu; on Irithyll (1.21.11)
   and a 1.12 server (teleports stay in the player's dimension there).
3. **Mods** (2026-11-04: a jar downloaded from CurseForge was found through Modrinth, since
   it is on both; the key is set and works. **Done** 2026-11-04: Unloader (CurseForge only)
   identified through CurseForge. The look-up of "Other" mods on saving a key is not tried
   again: nothing is "Other" any more): on MeatballCraft (CurseForge mods), with the CurseForge key: mods recorded as
   "Other" looked up when the key is saved; a CurseForge-only jar uploaded; an unknown jar
   showing the name and version it declares.
4. **Data packs**: the Data packs tab on a server with Open Loader or Paxi (the loader's folders
   listed, an upload into one, a drop onto the tab); a pack change where the loader changes,
   with "copy my packs" ticked (`tests/tools/datapack-loader-packs.mjs`); a version move of a
   server with a data pack from the browser (moved to its build for the new version).
5. **Files**: a drop onto a folder row in the tree. **Done** (2026-11-04): it went in, but a
   closed folder stayed closed (b51c5f6 opens it; checked by the user on dev 2026-11-04: the
   folder opened with the file listed, other open folders stayed open).
6. **World > Game rules** on Irithyll, running and stopped: a rule, the spawn, the border
   (stays where put), the world size limit (after a restart); Settings' Rules switches off and
   on again; a 1.12 server's rules (strings, mods' too).
7. **Settings**: the new fields on Irithyll (1.21.11) and a 26.x server (spam kicks); Other
   keys on a modded server (Minecraft's keys with notes, a mod's tagged).
8. **LZ4** (**done** 2026-11-04 on prod's `test`: the map draws LZ4 and zlib chunks alike.
   Found: Pre-generate's Start gave no sign (0a1f623), saved areas showed only over existing
   chunks (0a25719); both for beta.2): on a test server, chunk compression switched to LZ4, played or pre-generated, then
   the chunk map and a prune analysis.
9. **Tailscale and IPv6**: from a tailnet device, joining with the Connect box's ts.net address
   (and whether ufw lets tailscale0 in without the hint's rule); a wrong password from the
   phone over Tailscale not locking out the PC; Remote access's IPv6 note and
   `sudo ufw status` for RCON 26565 (**done** 2026-11-04: ufw lets 26565 in on neither IPv4
   nor IPv6, and the note says ufw turns it away).
   Found on the way: the header's banner (Start, Stop) followed to the next tab, between its
   tabs and sub-tabs (f7d43a7). Not ours: joining a test server once got Mojang's
   "authentication servers are down".

Claude, on throwaway data:
10. **The built app**: **done** (2026-11-04): a production build of beta.1 on throwaway data
    (a 1.21.11 server with a real world, Fabric with Open Loader's folder and jars, 26.3), every
    page at 1280 and 390 px with `--errors --overflow --spill`: nothing refused by the script
    policy, nothing past the edge or out of its box (168 views each).
11. **Long names**: **done** (2026-11-04): the long world, now with a mod's long keys in Other keys
    and long mod game rules (and the Settings tabs swept again after page-sweep's fix: it had
    never reached Advanced), at 390 px: nothing found. The release history's Beta tags need a
    real check against GitHub (item 1).
12. Not needed this time: the real-loader checklist (1.2 changed nothing in how a server
    starts or installs).

**1.1 beta checklist: done, 1.1.0 released 2026-11-03** (CI and Release green; the user updated prod
from beta.5 with the button, no problems seen). Kept as the record. (2026-11-01; 1.1.0-beta.5 released 2026-11-02 afternoon; since then,
going straight into 1.1.0 (small, like beta.4's): d845c6a, a confirmation scrolled into view
clears the save bar, and ed2f33a, CurseForge mods named "project-<id>" show their jar's name
and 1722177, Check now's answer beside its button and Mods > Updates checking when updates are
known (all found by the user on beta.5; ed2f33a checked on dev's Irithyll copy, 2026-11-03)).
On beta.5 (the user, 2026-11-03): the Connect box shows the LAN and playit.gg addresses (no
VPN or Docker interface on this machine to skip), and the update to beta.5 asked no running
server to restart (830a14f). 1.1.0 once a beta has run about
three days with nothing big (ROADMAP, "Betas"); beta.4's small fixes (`.jsonc`, a gap, the 24h
chart's peaks) did not restart the clock (the user, 2026-11-02). 830a14f (no needless "restart
to apply" after an update), 5eec358 (a changed number of log days applied at the next tick,
not up to an hour later), f3c0bd2 (the overview's shorter "Restart on crash") and 2aca031
(no update notification for a version the user just installed past; migration 0032) and
13b4a56 (quiet hours hold updates until they end) and e5b0d52 (the per-dimension table
starts with the busy ones), 382d478 (the LAN address skips VPN and container interfaces) and
d80ded1 (the Connect box's playit.gg row), 4635d65 (the data packs' check button's gap) and
3f89223 (the overview's data pack notice opening Data packs) and b27b356 (the new world's
option saying the data packs stay), 1d33f98 (section tabs in view on every server tab),
cc00559 (World > Worlds' panels over the whole row), e1fa5ff (Upload a world's button gap),
5aea6e2 (a task's Cancel says "Cancelling…"), 9bccb0b (the pack preview note's gap) and
e589eff (confirmations near the window's bottom scroll into view) and cd70d06 (the drop
outline going after a cancelled drag) go out as beta.5 once prod's own log cleanup has been seen to work
(the user, 2026-11-02), or in 1.1.0 if nothing else comes up. Most important first.

1. **Every server start (the sandbox and quoted arguments change how each one starts).**
   - Start, stop (RCON), restart and a crash restart of each real server; the console, heap
     readings and player list while it runs. Done for Irithyll on 2026-10-31 (its own
     namespace, joins, heap readings); Spark works inside it (the user, on the dev install).
   - `tests/tools/sandbox-check.sh mineshell@<id>`: **done for both** (the user, 2026-11-01:
     seccomp 2, own mount namespace, `~` only `.local` (Irithyll also its own `.cache/JNA`),
     `units/` only `once`). Irithyll before its restart still ran with 1.0's settings, started
     at 04:00: the reason for the "restart to apply" note (6204c7b).
   - Forge 1.12's startup question and the crash diagnoses: **done** (2026-11-01,
     `scenarios.sh` on the throwaway dev server): the answer reached Java as
     `-Dfml.queryResult=confirm` from `units/once/<id>/` after a snapshot, and was gone at the
     next start; the watchdog diagnosed, restarted 3 times (by design: after "Done (") and up
     after "Allow 3 minutes"; the missing dependency not restarted, Install added Fabric API
     and it booted. Found: `wait-start.sh` reporting an earlier boot (fixed).
   - JVM arguments holding a quoted space: none on prod (its unit env files, 2026-11-01); the
     2026-10-31 real-loader pass covered it.
2. **Updating itself**: beta.1 -> beta.2 -> beta.3 with the Update button, betas on: **done**
   (the user, 2026-11-01; beta.4 the same evening). beta.5 -> 1.1.0 on prod: **done** (the user, 2026-11-03).
3. **The script policy (CSP) on the built app**: **done** (2026-11-01): a production build on
   throwaway data swept with `page-sweep --errors` (123 views, nothing refused), and the user
   found nothing on prod, the Map tab with BlueMap and with Dynmap included.
4. **Security pass and Remote access**:
   - Settings > System, "Remote access": **done** (the user, 2026-11-01): the operator command,
     then Stop serving and Serve over Tailscale both work on prod.
   - The sign-in page: **done** (the user, 2026-11-01): warns over the LAN address, not over
     the ts.net one. The switch's note sat beside its label, making it wrap (fixed: the
     settings rows' layout).
   - Files: **done** (2026-11-01, throwaway): links to a file and a folder outside the server
     folder are refused by the editor, listing and download, can be deleted, and emptying the
     trash removes only the links.
   - The setup code on a fresh install: **done** (2026-11-01): the installer's last lines, the
     log and `setup-code`, on a throwaway local install and in `clean-install.sh` (whose own
     setup step sent no code; fixed). `scripts/caddy.sh` only against fakes (`caddy-check.sh`);
     a real Caddy needs a VM or a spare domain.
5. **Features from `next`**, a click each (all have tests; none had a real-install pass):
   - Mods tab, version pickers, Files: **done** (the user, 2026-11-01, first pass). Found: `.jsonc`
     files did not open in the editor (fixed in 33d2703), the snapshot box in a mod's version
     switcher sat on its buttons (fixed in 9113828). Both checked on beta.4, and the 24h
     chart's peaks (f32cd10), by the user (2026-11-02).
   - Pack changes: Cancel during a pack install (nothing left) and a pack change (the server
     back as it was): **done** (the user, 2026-11-02, ATM10 on prod; the install cancelled
     during NeoForge's installer, which a cancel waits for: 39 s in all). Found: Cancel could be
     pressed again, each press another message (5aea6e2: "Cancelling…"), and the preview's
     configs archive note against its button (9bccb0b). The data pack loader warning: **done**
     (the user, 2026-11-02, with `tests/tools/datapack-loader-packs.mjs`: Open Loader's data pack
     named in the preview when 2.0.0 dropped it).
   - Moving a server to an older Minecraft: with a new world **done** (the user, 2026-11-02:
     NeoForge 26.3 -> 1.21.11; its data pack stayed in the old world, which the option did not
     say: fixed in b27b356, carrying them over is for 1.2) and keeping the world **done** (the
     user, 2026-11-02).
   - Pruning: **done** (the user, 2026-11-02, a test server on prod): Chunky's area analysed, the
     analysis still there after `systemctl --user restart mineshell`, and a prune left the
     saved areas standing (they spelled HELLO).
   - Settings > Updates, "Database copies": **done** (the user, 2026-11-01, on a throwaway
     install): put back with and without the session in the copy; the button said nothing
     while MineShell restarted (fixed in c802a1e: it says so and the page comes back).
   - Notifications' quiet hours: the user, 2026-11-02, saw an update notice go through them,
     as built then; since 13b4a56 updates are held until the window ends **done** (the user,
     2026-11-03, prod's `test` server: JEI and Lithium put back to older versions, held in a
     17:00-17:10 window and sent at its end with "held back by quiet hours" and the time
     found; a pack or loader downgrade is never notified (2aca031), so mods were the way). TPS per dimension: **done** on NeoForge 26.3 (the user, 2026-11-02, the three
     vanilla dimensions) and on MeatballCraft (Cleanroom 0.5.17): four loaded, the table matching
     `forge tps` line for line - the overworld and three a mod keeps loaded (Extra Utilities
     2's quarry dimension, Random Things' Spectre, Storage Cell, likely AE2's spatial storage).
   - Pre-generation: **done** (the user, 2026-11-02).
   - New servers' defaults (8 GB, a daily snapshot, 3 crash restarts in 10 minutes): **done**
     (the user, 2026-11-02). Data packs in the update check: **done** (the user, 2026-11-02:
     More Breeze Rods, two versions both named "26.3", updated and then up to date); found the
     check button against the table (4635d65) and the overview's "Review data pack updates"
     opening Installed (3f89223).
   - Old logs deleted after the chosen days: **done** on prod (2026-11-02 12:23:51, 15 days:
     Irithyll's 21 archived logs of 9 to 18 October, 86 KB, and the journal line; the oldest
     left is from 19 October). The hourly read held back the changed number for up to an
     hour (fixed in 5eec358).
6. **The Updates tab and Remote access layout** from beta.2: **done** (the user, 2026-11-01),
   apart from the plain-http switch's note (fixed in 66410e8).
7. **Release notes for 1.1.0** (the user, 2026-11-01: by hand, without fixes of what 1.1 itself
   added): `scripts/release-notes.sh --draft > notes.md`, which leaves out six on its own. Also
   take out (fixes of 1.1's own features that touched older lines too): the template for quoted
   arguments (bf1646f), the crash banner's Install (dependency installs are new), the restart
   after putting a database copy back (c802a1e), "restart to apply" after an update (830a14f),
   a link out of a server folder still deletable (97f99c1) and the start naming a link the
   sandbox hides (ccaabc9), old logs' changed days applied at once (5eec358) and the overview's "Restart on crash"
   note (f3c0bd2: the startup crash exception is new); 13b4a56 (updates held by quiet hours)
   belongs in the quiet hours line, not a line of its own, and e5b0d52 (busy dimensions
   first) in TPS per dimension's; 3f89223 (the data pack notice's link) is new with 1.1's data
   pack update check, and b27b356 (data packs and a new world) with moving down. The rest of Fixed were 1.0's. Worth an intro line: Node.js 22.19 or
   newer is needed (the download fix).

Before it, nothing (2026-10-26): Discord notifications, the client export imports and a large
server export and import are done (ROADMAP-ARCHIVE, "Road to 1.0").

## Real-loader passes

2026-10-15 (throwaway setup, `tests/tools/`): migration Fabric 1.20.1 -> 1.21.1, Quilt
0.26.4 -> 0.30.1, pack update Cobblemon 1.8.1 -> 1.8.2 via the update notice, Forge 1.12.2
missing-entries question answered, Forge 2859 -> 2864: all booted. Found: Quilt's unordered
loader list, Forge's question read from one millisecond (both fixed). Installed on a phone
by the user (2026-10-16): works. A repeatable checklist for the next pass is on the road to
1.0.

## The user's test servers

MeatballCraft (user's main test pack): runs on Cleanroom 0.5.x only (0.5.17 starts fine after
"Reinstall pack files" on `meatballcraft-cleanroom`). `meatballcraft-dimensional-ascension`
still predates the overrides fix and needs the same (then delete the stray
`mods/overrides.zip`); the Cell Terminal crash was the missing pack configs.
