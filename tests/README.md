# Tests

```sh
npm test                  # whole suite (Vitest), about 5 seconds, fully offline
npm run test:watch        # re-runs affected tests on save
npx vitest run java       # only test files whose path contains "java"
```

## Where tests go

Next to the code they test, as `<module>.test.ts`:

```
src/lib/server/java.ts        src/lib/server/java.test.ts
src/lib/shared/links.ts       src/lib/shared/links.test.ts
```

`$lib` imports work as in the app. Bigger fixture-driven suites get their own folder here
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
  (`envDir` in `vite.config.ts`, `kit.env.dir` in `svelte.config.js`).
- `tests/setup.ts` checks the data and unit directories MineShell actually resolved before any
  test file runs and aborts the whole run if they are not inside that temporary directory.
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
before committing, since live data moves (new versions appear). Write assertions that survive
that: "contains 0.4.4-alpha", not "exactly these 37 versions". Large downloads (a `.mrpack`,
a mod jar) are not recorded; pass a small stand-in through the `extra` option instead.

Code with side effects beyond that is tested through its pure parts (planning, parsing,
matching), which is why some modules export small helpers such as `targetModNames` in
`packchange.ts` and `pickVersionForJava` in `cleanroom.ts`.

## Helpers

`tests/helpers/fs.ts`:

| Helper | Use |
|---|---|
| `tempDir()` | A fresh folder inside the run's throwaway directory (cleaned up automatically) |
| `writeJar(dir, name, files)` | A mod jar from `{ 'path/in/jar': content }` |
| `zipBuffer(files)` | The same as an in-memory zip, e.g. a `.mrpack` for `parsePack` |
| `mcmodInfo(modid, name)` | A Forge 1.12-style `mcmod.info` |
| `ls(dir)` | Sorted directory listing |

`tests/helpers/process.ts`: `fakeProcesses(handler)` and `spawnCalls`, see above.

`tests/helpers/http.ts`: `useRecordedHttp(name, { extra })` and `fetchCalls`, see above.

## When fixing a bug

Add a test that fails without the fix first. Each of these fails if its bug comes back:

| Bug | Test |
|---|---|
| Rollback deleted originals not yet moved aside | `instances.test.ts` |
| CurseForge install on Forge 1.12 instead of 1.12.2 | `mods/curseforge.test.ts` |
| Fugue for Java 25 picked for a Java 21 Cleanroom | `mods/modrinth.test.ts` |
| Player count 0 on Minecraft 1.12 | `rcon.test.ts` |
