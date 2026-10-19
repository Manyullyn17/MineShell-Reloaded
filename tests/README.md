# Tests

```sh
npm test                  # whole suite (Vitest), about 30 seconds, fully offline
npm run test:watch        # re-runs affected tests on save
npx vitest run java       # only test files whose path contains "java"
```

## Where tests go

Next to the code they test, as `<module>.test.ts`:

```
src/lib/server/java.ts        src/lib/server/java.test.ts
src/lib/shared/links.ts       src/lib/shared/links.test.ts
```

`#lib` imports work as in the app. Bigger fixture-driven suites get their own folder here
(see [crashdiag/](crashdiag/README.md)). [itemicons/](itemicons/README.md) is a manual check
outside the suite: every item's name and picture for vanilla versions and real servers
(`npm run check:icons`), run after changes to item icons or names.

## Real data is never touched

Importing anything that reaches the database opens and migrates the SQLite file under
`MINESHELL_DATA`, and a developer's `.env` usually points that at real servers. So under
Vitest:

- `vite.config.ts` creates a throwaway data directory in the system temp folder and points
  `MINESHELL_DATA` at it, with unit prefix `mineshell-test` instead of `minecraft`.
  `XDG_CONFIG_HOME` points inside it too, so systemd unit files are never written to
  `~/.config/systemd/user`.
- Vite and SvelteKit read env files from `tests/env/`, which has none, so `.env` never loads
  (`envDir` and the `sveltekit()` `env.dir` option, both in `vite.config.ts`).
- `tests/setup.ts` checks the data and unit directories MineShell actually resolved before any
  test file runs and aborts the whole run if they are not inside that temporary directory.
- SvelteKit's output goes to `.svelte-kit-test`, not `.svelte-kit`: SvelteKit writes the env
  it started with into that folder, and a running `npm run dev` reloads it, which used to
  switch the dev server onto the test run's data.
- `tests/global-setup.ts` deletes the temporary directory afterwards.

Test files run one after another (`fileParallelism: false`) because they share that one
database (and `maxWorkers: 1`, so the two projects below do not overlap either). What one file writes is still there
for the files after it, in an order that can change: give mods, projects and servers ids no
other test uses (`upsertMod` reuses a row with the same source and slug, name included), and
do not assert an order that comes from such shared rows.

Two Vitest projects (`vite.config.ts`): files containing `vi.mock(` run **isolated** (a fresh
module registry per file, because a mock cannot reach modules another file already loaded, and
a module loaded under one file's mock stays mocked); all others run with `isolate: false` and
share the app's modules, which cut the suite from ~44s to ~21s (evaluating ~300 modules again
for every file was half of it). The split is read from the files, so nothing needs listing.
Sharing means module state outlives a file: a cache or registry a test fills (an operation
left registered, a setting cached) can trip a later file. Clean up in the test, or reach for
`vi.mock` and the file moves to the isolated project by itself. `vitest run --no-isolate`
on everything fails 38 tests for that reason.

## No real processes

`tests/setup.ts` replaces `node:child_process` for every test: `spawn` throws unless the test
says what the process should print, and every other way of starting a process always throws.
Nothing can run `systemctl`, `journalctl` or `java` by accident.

```ts
import { fakeProcesses, spawnCalls } from '../../../tests/helpers/process';

fakeProcesses((cmd, args) => (args.includes('show') ? { stdout: 'ActiveState=active\n' } : {}));
await unitState('alpha');
expect(spawnCalls[0].args).toContain('show');
```

The fake is reset after every test.

## No network: recorded API responses

`fetch` throws in tests too, and `node:dns/promises` answers every name with a public
documentation address (`downloadFile` checks where a host resolves before fetching). Code that
talks to Modrinth, CurseForge, the modpacks.ch mirror or loader metadata servers is tested
against **real responses recorded once** and replayed offline:

```ts
import { useRecordedHttp, fetchCalls } from '../../../../tests/helpers/http';

useRecordedHttp('modrinth');   // replays tests/fixtures/http/modrinth.json
```

A request that was not recorded fails with a message saying so. To record a new test, or to
re-record after an API changed shape, run that file against the live APIs:

```sh
RECORD_HTTP=1 npx vitest run src/lib/server/mods/modrinth.test.ts
```

Re-recording replaces the whole fixture with what the current tests request; review the diff
before committing, since live data moves (new versions appear). When only a new request is
needed, keeping the rest as recorded makes a smaller diff: copy just the new entries into the
old fixture, written as the recorder writes it (keys sorted, `JSON.stringify(…, null, 1)`). Write assertions that survive
that: "contains 0.4.4-alpha", not "exactly these 37 versions". Large downloads (a `.mrpack`,
a mod jar) are not recorded; pass a small stand-in through the `extra` option instead.

Code with side effects beyond that is tested through its pure parts (planning, parsing,
matching), which is why some modules export small helpers such as `targetModNames` in
`packchange.ts` and `pickVersionForJava` in `cleanroom.ts`.

## Flow tests

`tests/flows/` runs whole operations - pack install, pack version change, loader version
change, Cleanroom migration and revert, world snapshots, retention and tools (dimensions,
chunk pruning), server copies, mod updates and data packs, player lists and player data,
Spark profiles and Chunky over a faked RCON, disk usage, the Files trash, Java defaults, client pack
export, starting servers after a reboot, server history from the journal, the mod bisect assistant - on throwaway
instances. The orchestration is real
(what gets moved aside, installed, restored, recorded in the database); only the outside world
is faked: each loader's `install` (spied to write files or fail on cue), downloads (served by
`useRecordedHttp`'s `extra`), systemd (`systemdStopped()`) and Java (`addJava()`).

The pattern for anything that can fail part-way:

```ts
const before = await tree(instance.path);
vi.spyOn(LOADERS.forge, 'install').mockRejectedValue(new Error('installer crashed'));
await waitForTask(await changeLoaderVersion(instance, '1.2.3'));
expect(await tree(instance.path)).toEqual(before);   // nothing lost, nothing left over
```

## Manual tools

Scripts in `tests/tools/` for trying changes by hand on a throwaway dev server (the command
is in CLAUDE.md, "Trying things against real loaders"); outside the suite, plain node.

| Tool | Use |
|---|---|
| `devserver.sh start\|stop\|status [port] [data dir]` | The throwaway dev server (port 5199, `/tmp/ms-test`, prefix `mstest`, no login), started in its own session and stopped by the port it listens on. Not `pkill -f`: the pattern is in the calling shell's own command line, so it killed that shell too |
| `seed-instance.mjs <data dir> <id> [--loader, --loader-version, --mc, --pack source:project:versionId[:name[:pack]], --port, --memory]` | A server row without installing anything: a pack server on an old version, a Fabric server on an old loader. Start the dev server once first (migrations) |
| `pageshot.mjs <url> <out.png> [--width 390] [--height px] [--wait-for text] [--timeout ms] [--overflow] [--click selector] [--eval js] [--dialog accept\|dismiss] [--element selector]` | A whole-page screenshot once the page has loaded in the browser (Chrome's `--screenshot` fires before fetches answer). `--overflow` lists elements past the right edge, ignoring ones inside sideways-scrolling boxes: the phone-width check. `--click` presses a button first (repeatable, in order: a sub-tab, then a button in it), answering any confirm() it opens (printed). `--eval` runs a script in the page in the same order and prints its JSON result: typing into a field, reading what a step left behind. `--element` captures just one element's box at full size |
| `act.mjs <page url>?/<action> [field=value ...]` | Posts to a form action as the page does and prints the decoded answer: drives a throwaway MineShell (MINESHELL_AUTH=off) from a script |
| `wait-start.sh <unit> [seconds]` | Waits until a server's run reaches "Done (" or stops, with its last lines on failure |
| `rcon.mjs <server folder> <command...>` (or `--port N --password P`) | One RCON command to a running server, its answer printed |
| `screenshots/run.mjs` (`npm run screenshots [-- names] [--keep\|--cleanup]`) | Redraws the README's pictures (`docs/screenshots/`) from invented data, with servers "running" on a fake Java under real units; scenes and shots are lists to add to (`screenshots/README.md`) |

When something needed for a check would be written a second time, it goes here instead.

## Helpers

`tests/helpers/fs.ts`:

| Helper | Use |
|---|---|
| `tempDir()` | A fresh folder inside the run's throwaway directory (cleaned up automatically) |
| `writeJar(dir, name, files)` | A mod jar from `{ 'path/in/jar': content }` |
| `zipBuffer(files)` | The same as an in-memory zip, e.g. a `.mrpack` for `parsePack` |
| `mcmodInfo(modid, name)` | A Forge 1.12-style `mcmod.info` |
| `ls(dir)` | Sorted directory listing |

`zipBuffer(files, { store: true })` writes the entries uncompressed.

`tests/helpers/process.ts`: `fakeProcesses(handler)` and `spawnCalls`, see above.

`tests/helpers/http.ts`: `useRecordedHttp(name, { extra })` and `fetchCalls`, see above.

`tests/helpers/ports.ts`: `testPorts()`, a game and RCON port pair for a server a test
starts (`start()` binds them to check they are free). Each Vitest worker gets its own block
below the ephemeral range; never pick ports by pid or at random.

`tests/helpers/auth.ts`: `owner()`, the owner account with `OWNER_PASSWORD` (made once: the
database will not delete an owner, so it is reused and its password put back), and
`otherUser({ username, disabledAt })` for a second account. A test that needs "no account yet"
mocks `ownerExists` (`guard.test.ts`). `grant(userId, instanceId, { admin, permissions,
playerView, playerEdit })` gives an account access to a server (a UUID list is a "selected"
scope), `setAccountFlags(userId, { globalAdmin, canCreate })` sets its MineShell-wide flags.
Handlers that check access read `locals.access`: pass an `Access` object
(`lib/shared/access.ts`) in the event, as `routes/instances/access-handlers.test.ts` does.

`tests/helpers/instances.ts`:

| Helper | Use |
|---|---|
| `createInstance(fields, files)` | An instance row plus its folder with the given files |
| `reload(id)` | The instance row as the database has it now |
| `tree(dir)` | Every file and its content, for before/after comparisons |
| `waitForTask(id)` | Wait for a background task and return it |
| `waitForStatusSettled(id)` | Wait until an instance is no longer `provisioning` |
| `systemdStopped()` | systemctl reports the server stopped and accepts everything else |
| `addJava(major)` / `clearJava()` | Register fake Java runtimes; clear them first, the database is shared |

`tests/helpers/crash.ts`, for operations that must survive MineShell dying halfway:

| Helper | Use |
|---|---|
| `runAndDieAtMove(root, n, start)` | Run an operation that freezes at its n-th file move into `root`, as if the process died there |
| `restartMineShell()` | Lift the freeze, hand the journal to a "previous process" and run recovery |
| `hangForever()` | A promise that never settles, for freezing an operation at a chosen step |

The usual loop tries every n until the operation finishes, checking after each restart that
`tree(instance.path)` is what it was before.

## When fixing a bug

Add a test that fails without the fix first. Each of these fails if its bug comes back:

| Bug | Test |
|---|---|
| `npm test` switched a running dev server onto the test's data | `config.test.ts` |
| On the dev server, a reload of server code left open pages' task streams deaf (a second task list and event bus): no progress, no page reload when a snapshot finished, its button greyed | `server/tasks.test.ts` |
| A task that started and finished before the task stream's first payload (a small world's snapshot) got no toast and no page reload: the list stayed without the new snapshot | `shared/taskwatch.test.ts` |
| Overlapping RCON commands got each other's output (player list held the tick report) | `rcon.test.ts` |
| A new RCON connection per command: two log lines each, several a minute | `rcon.test.ts` |
| Forge 1.12 waited forever on "/fml confirm" at startup (missing blocks/items after a pack update) | `flows/forge-question.test.ts`, `src/lib/server/forgequery.test.ts` |
| RCON answers over 4096 characters cut off after the first packet | `rcon.test.ts` |
| Rollback deleted originals not yet moved aside | `instances.test.ts` |
| CurseForge install on Forge 1.12 instead of 1.12.2 | `mods/curseforge.test.ts` |
| Fugue for Java 25 picked for a Java 21 Cleanroom | `mods/modrinth.test.ts` |
| Fugue 0.24 (needs Cleanroom 0.6.10) added to 0.5.x servers; a pack's Fugue 0.21 kept on Cleanroom 0.5.17, where it crashes | `cleanroom.test.ts`, `flows/cleanroom-fugue.test.ts` |
| Player count 0 on Minecraft 1.12 | `rcon.test.ts` |
| Pack update kept old jars that changed under the same name | `flows/pack-change.test.ts` |
| Failure while moving a loader aside lost files | `flows/loader-version.test.ts` |
| Cleanup after a failed recovery deleted the originals | `flows/recovery.test.ts` |
| Overview re-read 20000 journal lines every poll | `journal.test.ts` |
| Bans written while stopped had a date vanilla reads as "now" | `flows/players.test.ts` |
| An RCON refusal ("Invalid IP address…") reported as success | `flows/players.test.ts` |
| Removing a loaded world-generation data pack broke the world | `flows/datapacks.test.ts` |
| Restoring a one-dimension snapshot would replace the whole world | `flows/dimensions.test.ts` |
| Restoring a snapshot taken before World folder was changed moved the current world aside and put the snapshot under its old name, so the next start made an empty world | `flows/snapshots.test.ts` |
| Same-major Java runtimes picked in database order | `flows/java-defaults.test.ts` |
| With a CurseForge key, a pack listed only its newest 50 files | `src/lib/server/mods/curseforge-official.test.ts` |
| Page 2 of the mirror's browse skipped packs 21-50 | `src/lib/server/mods/modpacksch-paging.test.ts` |
| Cleanroom offered for every uploaded pack, not only Forge 1.12.2 | `src/lib/shared/packpeek.test.ts` |
| Mods disabled for Cleanroom showed no reason in the Mods list | `src/lib/server/cleanroom.test.ts` |
| NeoForge's RCON connection lines slipped past the console filter | `src/lib/shared/consolelines.test.ts` |
| A form on a page with a query (Files `?path=`) went to the page without it | `src/lib/shared/forms.test.ts` |
| ATM10's 42 Curios lists showed as identically named open lists | `src/lib/server/playeritems.test.ts` |
| Coloured journal lines (byte-array MESSAGE) were skipped by history | `src/lib/server/journal.test.ts` |
| Saving only the Game port set the RCON port to 0 (missing field read as 0) | `src/lib/server/formvalues.test.ts` |
| The Logs tab re-read the run list and the open run (1-3 s each) on every visit | `src/lib/server/journal.test.ts` |
| A server installed from an uploaded pack could not move to the pack's next version | `flows/pack-change.test.ts` |
| Changing the Minecraft version only relabelled the server | `flows/migrate.test.ts` |
| CurseForge's client-only file tags were ignored (uploaded zips, tags only on the newest file) | `flows/client-only.test.ts` |
| A dependency only the old mod version needed stayed; declared incompatibilities went unmentioned | `flows/mod-updates.test.ts` |
| A pack update replaced the user's config edits (kept only in old-configs) | `flows/pack-change.test.ts`, `src/lib/server/configmerge.test.ts` |
| Runs that exited cleanly never ended in the history on systemd 255 (only "Consumed" logged), so exit-0 startup crashes went uncounted | `flows/history.test.ts` |
| A server that crashed but whose process hung on showed as running; stopping it hid the crash | `flows/history.test.ts`, `src/lib/server/lastcrash.test.ts` |
| The leaderboard ranked a player whose player file had been deleted (their stats file stays), so someone dropped from the player list still showed | `flows/playerstats.test.ts` |
| A stat counter that wrapped past 2.1 billion (erzark's damage taken on MeatballCraft, one enormous mod hit) showed as -107 million hearts and dropped the player from the leaderboard | `server/playerstats.test.ts` |
| A server still loading showed "Running" and counted uptime before "Done ("; the overview said "started in" about an earlier run | `flows/start-phase.test.ts` |
| A server saving after an RCON stop (button or console) showed "Running" until its process exited | `flows/start-phase.test.ts` |
| (feature) The world map: BlueMap config per dimension, the EULA gate, serving rules and confinement | `flows/worldmap.test.ts` |
| (feature) Item icons: 1.21.4 definitions, 1.12 parent chains, variant table, Forge blockstates, guesses flagged, EULA gate, confinement | `flows/itemicons.test.ts` |
| Inventory blocks turned the wrong way (furnace front, stairs): the model's GUI rotation was ignored and turned backwards | `flows/itemicons.test.ts` |
| Item names from the id: camel-case keys, escaped colons, ids starting with item., a pack's resources/ and kubejs/assets/, lang files merged key by key, 1.12 variants by their own name | `flows/itemicons.test.ts` |
| Icons slow on a big pack (20 s per 500), out of memory once side by side: the lang files were read again for every variant's name | `flows/itemicons.test.ts` |
| Vanilla chests without an icon (drawn in code); AE2's ME Chest named "Chest" (bare key before the mod's) | `flows/itemicons.test.ts` |
| No icon for mod items whose models are picked in code (Klein Star, Handy Bag, AoA's bows in a subfolder) | `flows/itemicons.test.ts` |
| 1.12 vanilla variants named as their base (Granite as "Stone", every wool "Wool") | `flows/itemicons.test.ts` |
| Item named "%1$s%2$s%3$s" (crafting_on_a_stick): lang templates shown raw | `flows/itemicons.test.ts` |
| playit.gg: link by claim, unit, tunnels per server (AgentVersionTooOld retried, Premium refused, port followed, deleted with the server), a just-made tunnel kept on start, agent turned away over the limit, unlink | `flows/playit.test.ts` |
| No icons past the 500th item (a player's Baubles after 450 ProjectE knowledge entries): the page asked for all in one request | `src/lib/shared/itemicon.test.ts` |
| (feature) Tooltip facts: vanilla max durability, 1.20.5 max_damage, stored energy | `src/lib/server/playeritems.test.ts` |
| The EULA ticked on the new-server form was written only at the end, so the server's page asked for it while it installed | `flows/instance-defaults.test.ts` |
| (feature) Self-update: check, verified download, installer as its own unit, refusals, result after the restart | `src/lib/server/selfupdate.test.ts` |
| Player data from an imported world had no names: names from the server's lists, then Mojang (cached, misses too; offline-mode UUIDs never asked; a refused request asked again) | `src/lib/server/profiles.test.ts` |
| The recorded-HTTP helper could not replay a 204 (a Response with that status cannot have a body) | `src/lib/server/profiles.test.ts` |
| (feature) Skins: texture id from the profile, re-asked for entries from before skins, downloaded once, non-PNG and odd ids refused | `src/lib/server/profiles.test.ts` |
| (feature) Locator bar colour: the game's own ARGB output for UUIDs (online and offline mode) and names | `src/lib/shared/locatorcolor.test.ts` |
| (feature) Server initials and colour | `src/lib/shared/servertile.test.ts` |
| 26.x item models with `{ sprite }` textures (all glass) crashed the icon resolver | `flows/itemicons.test.ts` |
| (feature) Shulker boxes, and the trident's inventory model on 1.21.4+ | `flows/itemicons.test.ts` |
| (feature) The shield (plain), from both texture places | `flows/itemicons.test.ts` |
| Chest latch under the lid's seam (faces drawn by their own middle); chests now from the game's chest models | `flows/itemicons.test.ts` |
| (feature) Heads, plain banners, beds, conduit, decorated pot, copper golem statues, by definition, id and 1.12 damage | `flows/itemicons.test.ts` |
| (feature) Model parts to faces: Cube's texture corners, mirroring, nested parts | `src/lib/server/entityicons.test.ts` |
| (feature) Item pictures off and on | `flows/itemicons.test.ts` |
| Mod doors, saplings, pies drawn as the placed block, signs without a picture: the blockstate was read before the item's own model | `flows/itemicons.test.ts` |
| 1.12 models and textures named in another case (libvulpes' `tintedCube`, Blood Magic) not found: 1.12 lower-cases resource locations | `flows/itemicons.test.ts` |
| Heavy core (and Cyclic's blocks) without a picture: a face's texture written without `#` was read as a texture name | `flows/itemicons.test.ts` |
| Thermal Foundation's tools and armour, Tech Reborn's dusts without a picture: dotted ids' model folders and blockstates in subfolders not looked at | `flows/itemicons.test.ts` |
| 1.12 mod items named from the id ("Tool.bow Steel", "Armor.boots Aluminum") though the mod's lang file names them under other words; colour codes (`§6`) shown in names | `flows/itemicons.test.ts` |
| 1.12 items at damage 0 lost their variant's name ("Carved Mud Bricks") once their own model gave the picture | `flows/itemicons.test.ts` |
| 78 of 447 vanilla 1.12 items misnamed ("Gold Block", "Beef", "Record 13"); dead bush, potions, totem, red sandstone slab without a picture | `flows/itemicons.test.ts` |
| Before 1.21.4 every spawn egg the same grey egg, leather white, potions clear; cherry leaves green, short grass grey | `flows/itemicons.test.ts` |
| Item picker offered hundreds of pictures that are not items (clock frames, armour trims) and left out smithing templates; on vanilla 1.12 it listed model names (black_wool) instead of ids | `flows/itemicons.test.ts` |
| Empty item slots for mod blocks with invisible placeholder models (Bewitchment, Astral Sorcery): drawn as a blank picture instead of the name | `src/lib/shared/itemicon.test.ts` |
| Mod items whose models build on NeoForge's own (neoforge:block/default, the buckets) without a picture: the loader's jar was not read | `flows/itemicons.test.ts` |
| (feature) Composite models (NeoForge/Forge `composite` loader): children's elements, each with its own textures | `flows/itemicons.test.ts` |
| (feature) NeoForge fluid buckets: the bucket, the fluid cut to its shape when its texture is found by name, else flagged | `flows/itemicons.test.ts` |
| Rechiseled's blocks drawn as thin strokes: a connected texture's pieces side by side were read as one stretched frame | `src/lib/shared/itemicon.test.ts` |
| Fence gates small and multiblock models (Mekanism's nucleosynthesizer) overflowing their slot: the model's inventory scale was ignored | `flows/itemicons.test.ts` |
| 1.19.4-1.20.x smithing templates named from their ids ("Coast Armor Trim Smithing Template"): they share one key | `flows/itemicons.test.ts` |
| 1.7 player items shown by number, and items added in the editor written with a string id the game loads as nothing | `src/lib/server/playerdata.test.ts`, `flows/playerdata.test.ts` |
| 1.7 servers: empty item picker (registry in FML > ItemData not read), no picture or name for mod ids with capitals or '\|' | `flows/itemicons.test.ts` |
| Vanilla 1.7.10 without item pictures (no item models before 1.8); 1.8's clock and compass without one | `flows/itemicons.test.ts` |
| 1.7 mod items without pictures or names (no models; textures and lang keys named in code, IC2's names in a properties file); 1.12 mod items whose texture is named after them | `flows/itemicons.test.ts` |
| A restore's backup replaced the save's when both fell in the same millisecond (the flaky "restores a backup" test) | `flows/playerdata.test.ts` |
| A scheduled restart during a live snapshot copy caught the world mid-write; a snapshot due during a restart failed; a failed save-on after a restart was reported as saving still off | `flows/snapshot-schedule.test.ts` |
| (feature) Snapshot and map schedules on the clock; slots skipped when nobody played | `flows/snapshot-schedule.test.ts`, `flows/worldmap.test.ts` |
| Two servers with Simple Voice Chat on the default UDP port: the second stopped itself at start | `flows/voicechat.test.ts` |
| (feature) playit.gg: voice chat's UDP tunnel, voice_host written, both taken away when private | `flows/playit.test.ts` |
| The Map tab walked every tile for the map's size on each look; MineShell's render was missing from the disk usage | `flows/disk-usage.test.ts` |
| Memory advice suggested less from an idle server (2 GB of 10 empty says nothing when players take it to 8) | `memoryadvice.test.ts`, `flows/memory-advice.test.ts` |
| Memory advice suggested less after three short sessions on two days (clock hours with 20 minutes of play counted as played hours) | `memoryadvice.test.ts` |
| The overview's heap size and the memory limit's check used the saved heap while the server still ran with the old one | `heap.test.ts` |
| Spark's upload timed out (its server answered 502): the saved profile was only a path in the list | `spark.test.ts`, `flows/spark-profile.test.ts` |
| (feature) Snapshot names and tags: only the manifest changes, clearing removes them, tidied and limited | `flows/snapshots.test.ts` |
| (feature) Several worlds per server: new world, switching with per-world settings, data packs and maps, snapshots only of the active world, the newer-version warning, a crash mid-switch, deleting, a world from a snapshot or an upload | `flows/worlds.test.ts` |
| (feature) Files over SFTP: the link, sshd_config's port, what the settings accept | `sftp.test.ts` (shared and server) |
| A jar put into mods/ by hand became a "pack mod" at the next pack change's sync, and the change after removed it | `flows/pack-change.test.ts` |
| (feature) Pack change rollback: exact configs, user mods kept, failure restores all, world from the snapshot, Minecraft moves need it | `flows/pack-rollback.test.ts` |
| A file-list entry without a URL was dropped (install "succeeded" without it); failed downloads were only in the task log; CurseForge files had one source | `packs/index.test.ts`, `flows/pack-install.test.ts` |
| Two MineShells on one machine (production and dev) shared one session cookie and signed each other out | `auth.test.ts` |
| Settings sent the RCON password with every page load (masked only on screen), also inside the raw server.properties | `routes/instances/[id]/settings/rcon.test.ts` |
| A server's Settings saved and deleted the JVM flag presets every server shares | `routes/settings/presets.test.ts` |
| Saving memory went through the same action as the Java path, JVM flags and launch arguments | `routes/instances/[id]/settings/runtime.test.ts` |
| The server list's start/stop, pin and tag buttons named their server only in the form body, not in the address | `routes/instances/[id]/tags.test.ts` |
| (feature) Accounts: the owner `admin`, sign-in by name, sessions per account, a disabled account or deleted session stops at once, the owner cannot be deleted/demoted/disabled, throttle per address and per name | `auth.test.ts`, `guard.test.ts` |
| (feature) Migration 0019 turns the old admin password into the owner and keeps its sessions | `db/users-migration.test.ts` |
| "Sign out every other device" on a password change also signed out the device asking | `auth.test.ts` |
| Sign out did nothing: the guard sent every signed-in request for /login home, the sign-out post included | `guard.test.ts` |
| (feature) Access: `can()`, loading grants (admin removal keeps the listed permissions, grants go with the server or account), the guard applying the policy, a refused page never running its load | `shared/access.test.ts`, `server/access.test.ts`, `guard.test.ts` |
| (feature) The access policy names every route, action and method, and handler-checked entries call `requireAccess` | `access/policy.test.ts` |
| (feature) Checks that depend on the posted form: the ops list, unpinning, mod or data pack, cancelling a task | `routes/instances/access-handlers.test.ts` |
| (feature) Page data per account: rail, server list and Activity filtered; crash log lines, IP bans, scheduled commands and the playit.gg account links left out; another server's port neither named nor moved without access | `routes/access-filtering.test.ts` |
| (feature) Accounts: one-time passwords, names unique in any case, reset and disable sign out, delete takes access along, who may manage whom, access saved as loaded (admin keeps the chosen permissions) | `accounts.test.ts` |
| (feature) Accounts pages and your account page: only the owner makes or changes global admins, nobody changes the owner, delete wants the name, a password change needs the current one; a forced change allows only `/account` and signing out | `routes/settings/users/accounts-routes.test.ts`, `guard.test.ts` |
| (feature) Whoever adds or copies a server becomes its admin; a copy takes nobody's access from the source | `flows/instance-defaults.test.ts`, `flows/clone.test.ts`, `server/access.test.ts` |
| (feature) Copying a server with "the same access": everyone's access and chosen players carried over, only for global admins | `flows/clone.test.ts`, `routes/instances/access-handlers.test.ts` |
| (feature) Open event streams close when the session is signed out or the access they need goes, announced or found within 15 s; Activity's stream ends on sign-out | `access-stream.test.ts` |
| (feature) The audit log names the account a request ran as, through awaits, timers and tasks it started; MineShell's own work none | `requestcontext.test.ts` |
| The overview sent each crash diagnosis's log line, and Forge's startup question in full, to accounts without console access | `routes/access-filtering.test.ts` |
| A pack file's `../` path made MineShell write a download outside the server folder | `server/packs/index.test.ts` |
| A pack's download URL (or a redirect from it) could point MineShell at loopback or private-network services | `server/download.test.ts` |
| (feature) An exact local address can be allowed by global admins only; the refusal is asked about on its task and on the pack file it failed | `server/download.test.ts`, `server/packs/index.test.ts` |
| The ZGC preset's `-XX:+ZGenerational` stopped Java 17 servers from starting (and ZGC Java 8 ones), also as the default for new servers | `server/jvm-presets.test.ts`, `routes/instances/[id]/settings/runtime.test.ts`, `flows/instance-defaults.test.ts` |
| (feature) JVM flags a server's Java does not start with are refused when saved, in Java's words; a saved preset names the installed Java versions that refuse it | `routes/instances/[id]/settings/runtime.test.ts`, `routes/settings/presets.test.ts` |
| A saved preset could take a built-in preset's name (shown twice in the picker), and names of only symbols shared one id | `routes/settings/presets.test.ts` |
| (feature) Saved presets are edited in place (name, description, flags); a rename keeps the id new-server defaults refer to | `routes/settings/presets.test.ts` |
| Deleting the saved preset new servers got made them fall back to Aikar without a word | `routes/settings/presets.test.ts` |
| (feature) Notifications: routing to MineShell's and a server's own destination, encrypted addresses, Discord/ntfy/webhook bodies, old events not sent, crash loops folded; the history reports starts, stops, joins and leaves once | `server/notifications.test.ts`, `flows/history.test.ts` |
| (feature) Memory check before a start: the server's ceiling plus the running servers' room to grow against what is available | `server/memoryguard.test.ts` |
| (feature) New-server defaults for resource limits (automatic memory limit fitted to the heap) and update checks | `flows/instance-defaults.test.ts` |
| Forge's update check offered 14.23.0.2486 over 2859 (its metadata is out of order) and newer-than-recommended builds as releases; Quilt's list was unordered too | `server/updatecheck.test.ts`, `server/modloaders.test.ts` |
| (feature) Update checks: newer pack version / loader build by date and channel, Cleanroom kept on its line, skip, hidden after the server moved on, retry after a failure | `server/updatecheck.test.ts` |
| (feature) Credits: README's section lists every entry of the About page's list | `shared/credits.test.ts` |
| (feature) Removing a player: player file, .dat_old, stats, advancements and MineShell's backups into the trash; refused while they are online or RCON cannot tell | `flows/playerdata.test.ts` |
| (feature) Player stats: 1.13+ and 1.12 files read into one shape (old stat names mapped), names from lang files, times/distances/damage shown readably, distance without falling | `server/playerstats.test.ts`, `flows/playerstats.test.ts` |
| A memory limit of heap + 512 MB let the kernel kill a big pack (1.5-3.3 GB outside its heap), and the kill showed as a crash with no cause | `shared/memorylimit.test.ts`, `crashdiag/crashdiag.test.ts` |
| A new server could be given a stopped server's voice chat or map mod port (only game and RCON ports were avoided) | `flows/ports.test.ts` |
| (feature) Cap on all servers: soft memory cap and CPU quota on the shared slice, a slice file MineShell did not write left alone, the start warning past the cap | `server/servercap.test.ts` |
| (feature) Ports tab: each server's ports, /proc/net listeners and their units, clashes, ports held by others, a server on its old port, changing a port where it is configured | `flows/ports.test.ts` |
| (feature) Pack change preview: the user's own files in moved folders, keeping them over the new version's, and bringing them back without a base; only offered paths are copied | `flows/pack-change.test.ts` |
| (feature) Where new ports start: saved starts for game, RCON distance, voice chat and map mod ports, RCON kept out of 32768+, invalid ranges refused and ignored | `flows/ports.test.ts` |
| (feature) Mod updates in the periodic check: servers without a pack only, enabled mods, skipped until a different set, cleared by updating | `server/updatecheck.test.ts`, `flows/mod-updates.test.ts` |
| "Update mods" refused every mod from the browser: the review's "<file>\n<version>" values arrive with CRLF, and the split left "\r" on the file name | `server/formvalues.test.ts` |
| (feature) Data pack updates: newer releases of browser-installed packs, file swapped, hand-added ones left out; a loaded world-generation pack only stopped, after a snapshot | `flows/datapack-updates.test.ts` |
| (feature) Earlier downloads with the same hash copied instead of fetched; never a file changed since, never by name, never without a hash | `server/filecache.test.ts` |
| (feature) The same mod twice: enabled jars sharing a declared mod id, not disabled copies, template ids or dependency blocks | `crashdiag/crashdiag.test.ts` |
| Pruning's Analyse button showed nothing until a manual reload: reading a region awaited only microtasks, so the page's data reload waited behind the analysis (seconds per region) | `flows/chunk-prune.test.ts` ("lets other requests in") |
| A second analysis of the same server could start while one ran: the check came after an await | `flows/chunk-prune.test.ts` ("reports the analysis under way") |
| (feature) Prune from an analysis: only chunks it marked and the user did not protect, still under the threshold on disk; an older analysis refused | `flows/chunk-prune.test.ts`, `shared/chunkprune.test.ts` |
| 1.21.9+ worlds: the spawn radius kept nothing, Restore chunks opened at 0,0 (spawn moved to Data.spawn.pos) | `flows/chunk-prune.test.ts` ("reads the spawn") |
| (feature) One number out of NBT without parsing it (`peekNumber`): every tag kind skipped, both chunk layouts, damaged files refused | `server/nbt.test.ts` |
| Cancel did nothing for most tasks (only pack downloads, the map render and Spark checked it) and said "after the current download finishes" for all; cancelled pack downloads were forgotten, so the missing-files retry counted them as done | `server/tasks.test.ts` ("cancelling"), `server/packs/index.test.ts` ("lists the files a cancel left"), `flows/chunk-prune.test.ts` ("stops an analysis when cancelled") |
| "Snapshot now" was refused while the server ran, though scheduled snapshots copied running servers live | `flows/snapshot-schedule.test.ts` ("Snapshot now" on a running server) |
| (feature) Recent crashes cleared from the overview only after a clean start, by hand or on their own after a one-click fix | `flows/history.test.ts` ("clears crashes") |
| (feature) Exported packs list the server in the game's multiplayer list (servers.dat) in each format's game folder | `flows/pack-export.test.ts` ("multiplayer list") |
| (feature) Roofs on the chunk map: found by height whatever they are made of, the floor under the first open space, walls, missing sections as air; not superflat or oceans; dimensions open where their chunks are | `server/chunkmap.test.ts` ("below a roof"), `shared/chunkmap.test.ts` |
| (feature) Names for 1.12 numbered dimensions: Forge's `forge dimensions` once per run, else ranked guesses from configs (biome ids and counts never) | `flows/dimension-names.test.ts` |
| The overworld was labelled "region" once a world had named dimensions: every label was rebuilt from the first folder | `flows/dimension-names.test.ts` |
