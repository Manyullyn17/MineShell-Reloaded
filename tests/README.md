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
(see [crashdiag/](crashdiag/README.md)).

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
database; the suite is small enough that it does not matter. What one file writes is still there
for the files after it, in an order that can change: give mods, projects and servers ids no
other test uses (`upsertMod` reuses a row with the same source and slug, name included), and
do not assert an order that comes from such shared rows.

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

`fetch` throws in tests too. Code that talks to Modrinth, CurseForge, the modpacks.ch mirror
or loader metadata servers is tested against **real responses recorded once** and replayed
offline:

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
Spark profiles and Chunky over a faked RCON, disk usage, Java defaults, client pack
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
| Overlapping RCON commands got each other's output (player list held the tick report) | `rcon.test.ts` |
| Rollback deleted originals not yet moved aside | `instances.test.ts` |
| CurseForge install on Forge 1.12 instead of 1.12.2 | `mods/curseforge.test.ts` |
| Fugue for Java 25 picked for a Java 21 Cleanroom | `mods/modrinth.test.ts` |
| Player count 0 on Minecraft 1.12 | `rcon.test.ts` |
| Pack update kept old jars that changed under the same name | `flows/pack-change.test.ts` |
| Failure while moving a loader aside lost files | `flows/loader-version.test.ts` |
| Cleanup after a failed recovery deleted the originals | `flows/recovery.test.ts` |
| Overview re-read 20000 journal lines every poll | `journal.test.ts` |
| Bans written while stopped had a date vanilla reads as "now" | `flows/players.test.ts` |
| An RCON refusal ("Invalid IP address…") reported as success | `flows/players.test.ts` |
| Removing a loaded world-generation data pack broke the world | `flows/datapacks.test.ts` |
| Restoring a one-dimension snapshot would replace the whole world | `flows/dimensions.test.ts` |
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
