# Status and open threads

Where things stood, what the user has yet to try and the state of their test servers, moved out
of CLAUDE.md (2026-10-20). Open work itself is `docs/ROADMAP.md`.

## Where it stands (2026-10-21, 0.30.2)

Heading for 1.0 (ROADMAP, "Current direction" and "Road to 1.0"). Agreed 2026-10-21:
- World backups to another place (a folder on this machine first, no cloud, extensible) are
  the last feature before 1.0 (built 2026-10-22: backup folders); then a feature freeze and a
  release candidate. Then (2026-10-25) one more: the mod list export (ROADMAP, "Road to 1.0"),
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

**1.1 beta checklist** (2026-11-01; prod runs 1.1.0-beta.3, meant as the last beta). 1.1.0 once a beta has run about
three days with nothing big (ROADMAP, "Betas"). Most important first.

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
   (the user, 2026-11-01). Left: beta.3 -> 1.1.0 (offered with betas on or off), once it is out.
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
   - Mods tab: pictures, "Required by" and the ask before disabling, holding a mod at its
     version, sorting by the headers, the client-only filter.
   - Version pickers you can type into, listing only versions the loader has builds for.
   - Files: editor (line numbers, colours, the broken JSON/TOML/YAML question, earlier
     versions), search in files, unpacking an uploaded zip, a folder as a zip.
   - Pack changes: Cancel during a pack change (the server back as it was) and a pack install
     (nothing left); the data pack loader warning.
   - Moving a server to an older Minecraft: the 26.3 test server, once with a new world (the old
     one under World > Worlds) and once keeping it.
   - Pruning: analysis kept after a MineShell restart, saved areas skipped.
   - Settings > Updates, "Database copies": **done** (the user, 2026-11-01, on a throwaway
     install): put back with and without the session in the copy; the button said nothing
     while MineShell restarted (fixed in c802a1e: it says so and the page comes back).
   - Notifications' quiet hours; TPS per dimension on a Forge/NeoForge server.
   - Pre-generation: Chunky installed from World > Pre-generate; the paused server's header
     following start, pause, continue and cancel at once (from the console within ~45 s).
   - New servers: 8 GB, a daily snapshot, 3 crash restarts in 10 minutes; old logs deleted
     after the chosen days; data packs in the update check.
6. **The Updates tab and Remote access layout** from beta.2: **done** (the user, 2026-11-01),
   apart from the plain-http switch's note (fixed in 66410e8).

Before it, nothing (2026-10-26): Discord notifications, the client export imports and a large
server export and import are done (ROADMAP, "Road to 1.0").

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
