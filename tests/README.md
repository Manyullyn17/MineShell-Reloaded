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
database; the suite is small enough that it does not matter.

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
export, starting servers after a reboot, server history from the journal - on throwaway
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
