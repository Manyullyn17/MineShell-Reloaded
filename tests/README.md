# Tests

```sh
npm test                  # whole suite (Vitest), about 3 seconds
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
- Vite and SvelteKit read env files from `tests/env/`, which has none, so `.env` never loads
  (`envDir` in `vite.config.ts`, `kit.env.dir` in `svelte.config.js`).
- `tests/setup.ts` checks the data directory MineShell actually resolved before any test file
  runs and aborts the whole run if it is not that temporary directory.
- `tests/global-setup.ts` deletes the temporary directory afterwards.

Test files run one after another (`fileParallelism: false`) because they share that one
database; the suite is small enough that it does not matter.

Tests must not call systemd, start servers or hit the network. Code that does those things is
tested through its pure parts (planning, parsing, matching), which is why some modules export
small helpers such as `targetModNames` in `packchange.ts`.

## Helpers

`tests/helpers/fs.ts`:

| Helper | Use |
|---|---|
| `tempDir()` | A fresh folder inside the run's throwaway directory (cleaned up automatically) |
| `writeJar(dir, name, files)` | A mod jar from `{ 'path/in/jar': content }` |
| `zipBuffer(files)` | The same as an in-memory zip, e.g. a `.mrpack` for `parsePack` |
| `mcmodInfo(modid, name)` | A Forge 1.12-style `mcmod.info` |
| `ls(dir)` | Sorted directory listing |

## When fixing a bug

Add a test that fails without the fix first. The suite has caught the rollback bug this way:
removing the `keep` check in `removeEntries` makes `instances.test.ts` fail.
