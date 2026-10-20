# MineShell — project handoff

SvelteKit web control panel for modded Minecraft servers, run as systemd units. Fuller
picture: `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, `docs/ROADMAP.md` (open work; built features: `docs/ROADMAP-ARCHIVE.md`). History of what
changed and why lives in `git log` (one commit per fix/feature, descriptive messages); this
file is the current state and the knowledge that is not obvious from the code.

## Working on it

```sh
npm run dev          # uses .env: ~/mineshell-data, dev copies of the user's servers, run as real minecraft@ units
# Node 24 for development (.nvmrc; nvm use). better-sqlite3 13+ is N-API: one prebuilt
# binary works on every Node, no rebuild after switching (11.x needed one, and crashed the
# dev server on Node 24 with an assertion in Statement::~Statement). CI also runs 22
# (22.12 is the minimum: Vite 8 / Kit 3), which catches anything only newer Node has.
npm run check        # svelte-check, must stay at 0 errors / 0 warnings
npm test             # Vitest, ~40s, fully offline; CI (GitHub Actions) runs check + test + build on Node 22 and 24
git config core.hooksPath .githooks   # once per clone: pre-push runs check + the tests related to the push
```

- **Tests** (`tests/README.md`): never touch real data, never start processes, never use the
  network - each is enforced in `tests/setup.ts`, not just documented. That relies on
  `env.dir` in the `sveltekit()` options and on process env beating `.env` (Vite's
  `loadEnv`), which is also what makes the throwaway dev server below safe - together with
  separate SvelteKit output folders: Kit writes the env it started with into
  `<outDir>/generated/dev/env/config.js` and every dev server watching that folder reloads
  with it, so a shared `.svelte-kit` let `npm test` or a throwaway server move a running
  `npm run dev` onto their data. Tests use `.svelte-kit-test`, a dev server given
  `MINESHELL_DATA` on the command line `.svelte-kit-<hash>` (`vite.config.ts`). Flow tests in
  `tests/flows/` run whole operations on throwaway instances; API code replays recorded
  responses (`RECORD_HTTP=1` re-records). A bug fix gets a test that fails without it.
- **Trying things against real loaders**: run a second dev server on a throwaway data dir,
  never the real one:
  `tests/tools/devserver.sh start` (= `MINESHELL_DATA=/tmp/ms-test MINESHELL_AUTH=off
  MINESHELL_UNIT_PREFIX=mstest npx vite dev --port 5199`), and `devserver.sh stop` to end it -
  never `pkill -f '...5199'`: the calling shell's command line holds the pattern too.
  Installing its template unit (Settings) writes `mstest@*` files to
  `~/.config/systemd/user/`; `devserver.sh clean` removes them with the data dir when done
  (the units outlive the data dir otherwise). Booting a server directly with the
  unit's env file (`$DATA/units/<id>.env`) avoids systemd entirely. `tests/tools/` has a row
  seeder, a screenshot taker that waits for the page (also the phone-width overflow check)
  and an RCON client (tests/README, "Manual tools"); add reusable checking tools there.
- **README screenshots**: `npm run screenshots` redraws `docs/screenshots/` from invented
  data (`tests/tools/screenshots/README.md`: scenes, shots, a fake server under real
  `msshot@` units, cleaned up afterwards). Redraw the affected shots when a page they show
  changes; add a shot or scene there rather than taking pictures by hand.
- **Access policy**: every page load, form action and endpoint method needs an entry in
  `src/lib/server/access/policy.ts` (`docs/ARCHITECTURE.md`, Access). Without one it is refused
  for everyone, the owner included (dev logs "not in the access policy"), and
  `access/policy.test.ts` fails. A check that depends on the posted form goes in the handler
  (`requireAccess`) and the entry is wrapped in `handler(...)`. Plan and phases: ROADMAP-ARCHIVE,
  "Accounts and permissions".
- **No formatter**: there is no Prettier config and the code is hand-formatted (tabs, single
  quotes, no trailing commas). Running Prettier rewrites whole files. Match surrounding style.
  `sv migrate` reprints whole files too: use its output as a checklist, not as the change.
- **SvelteKit 3**: no `svelte.config.js` (options go in `sveltekit({...})` in
  `vite.config.ts`); `#lib/...` subpath imports instead of `$lib`, with `.js` on TypeScript
  modules; env vars are declared in `src/env.ts` (each `undefined` when unset - `config.ts`'s
  defaults rely on it) and read from `$app/env/private`. `csrf.trustedOrigins: ['*']` turns
  Kit's own origin check off; `guard.ts` does the host-only check. An enhanced form posting
  to another page navigates there - and `?/x` drops the page's query, which counts as another
  page: import `enhance` from `#lib/shared/forms.js`, never `$app/forms`. `crashdiag.ts` imports `./zip.ts` with the extension
  because `tests/crashdiag/capture.mjs` runs it under plain node.
- **Releases** (built 2026-10-09): tag `v<package.json version>` -> Release workflow ->
  archive + `install.sh` on GitHub (DEPLOYMENT.md). `scripts/install.sh` can be tried locally
  with `MINESHELL_ARCHIVE=dist/...` and throwaway `MINESHELL_HOME/CONFIG/SERVICE/DATA/
  UNIT_PREFIX/PORT` (remove the `mstest*` units afterwards). On this machine the real MineShell
  is the `mineshell` user service on port 3000 (data `~/.local/share/mineshell`, prefix
  `mineshell`); this repo's `.env` (`~/mineshell-data`, prefix `minecraft`) holds dev copies of the user's
  servers, not the installed ones.
  The old Python MineShell is `~/mineshell-old` - never delete anything there.
- **Self-update** (`selfupdate.ts`): only when the service has `MINESHELL_INSTALL_*` (written
  by install.sh from the 0.2 installer on). The installer runs as a `systemd-run --user`
  transient unit, because restarting MineShell kills its children. Tried end to end on a
  throwaway install (0.1.0 -> 0.1.1 from a local http server, by writing `update.check` into
  its DB; and a broken archive -> failed with the installer's log, old version kept). Since
  2026-10-13 downloads from local addresses are refused: allow 127.0.0.1 under MineShell
  settings > System (or Activity's prompt) to repeat that. Used
  for real 2026-10-09: the user's install went 0.2.0 -> 0.2.1 through the button.
  `__MINESHELL_VERSION__` is package.json's version (vite `define`), not Kit's `version`.
- **Migrations need a downgrade marker** as their first line: `-- downgrade: safe` (only adds:
  tables, nullable/defaulted columns, indexes; changes no data an older version reads) or
  `-- downgrade: unsafe - <why>`, which stops Settings > Updates going back past it
  (`db/migrate.test.ts` requires the line; ARCHITECTURE, "Updating itself"). Only 0019 is unsafe.
- **Reinstalling `node_modules`** (`npm ci`, a lockfile regeneration) leaves VS Code's Svelte
  language server showing hundreds of bogus errors (`$state`, `$app/forms` unknown) until
  "Svelte: Restart Language Server".
- **Commits**: one logical change per commit; `fix:`/`feat:`/`test:`/`ci:`/`docs:`/`chore:`
  prefixes; body says what was wrong and why the fix is right. The prefixes pick the next
  version and `feat:`/`fix:` subjects become release-note lines (write them for users);
  `feat!:`/`fix!:` marks a breaking change. Releasing: `npm run release`, then the printed
  push (DEPLOYMENT, "Publishing a release").
- **Docs move with the code**: a change that alters something a doc describes updates it in
  the same commit. `README.md` = what MineShell does (feature list, requirements, config
  table); `docs/ARCHITECTURE.md` = how and why (units, drop-ins, stopping, console, tables,
  journalled operations, worlds, safety, endpoints); `docs/DEPLOYMENT.md` = setup and
  operations (user units only: system scope was removed 2026-10-06);
  `docs/ROADMAP.md` = open work and decisions, nothing built (a built entry moves to
  `docs/ROADMAP-ARCHIVE.md` with its notes; what it leaves out goes to "Leftovers of built features");
  `tests/README.md` = test tooling, helpers and the bug -> test table; `docs/notes/` = the
  hard-won facts per area (below). Full pass done 2026-10-06.

## Hard-won facts

What is not obvious from the code, per area in `docs/notes/`. Read the area's file before
changing code in it; add a fact there when something cost time to find out.

- [loaders.md](docs/notes/loaders.md) - install shapes per loader, Java per Minecraft version
  and Java downloads, Cleanroom (CleanMix, Fugue, Scalar), Forge's startup questions,
  version/loader migration, client-only mods
- [packs-and-mods.md](docs/notes/packs-and-mods.md) - the modpacks.ch mirror and CurseForge
  endpoints, pack version change, config merge, pack rollback, uploaded packs, the pack install
  form, mod updates, client pack export
- [item-icons.md](docs/notes/item-icons.md) - itemicons.ts/entityicons.ts: model lookup,
  projection turns the user checked, item names and lang keys, 1.12 and 1.7.10 quirks
- [player-data.md](docs/notes/player-data.md) - NBT, item formats per DataVersion, Curios,
  enchantment names, player names and faces, online-player refusal, backups
- [worlds.md](docs/notes/worlds.md) - snapshots and their retention and schedule, several
  worlds, dimensions, pruning, data packs, chunk map and restore, world map (BlueMap, Dynmap)
- [operations.md](docs/notes/operations.md) - journalled operations and recovery, server
  export/import, mod bisect, new server defaults
- [runtime.md](docs/notes/runtime.md) - scheduler, stuck/paused/crashed detection, limits,
  exit codes, Java heap reads, journal reads, history, boot start, console and RCON, crash
  diagnosis, Spark, Chunky, notifications, playit.gg
- [status.md](docs/notes/status.md) - where things stood, what the user has yet to try, the
  state of the user's test servers (MeatballCraft)

Cross-cutting UI facts stay here, since most UI work touches them:

### UI layout (October 2026 redesign)
- Server actions live in the instance header (`instances/[id]/+layout.svelte`), posting to
  the overview's actions and applying the result in place. Sub-tab bars use the global
  `.subhead`/`.subtabs`; boxed tables `.table-box`; number strips `.strip` (app.css).
- A server's Settings: every section mounted (hidden by tab), one form per section on its
  old action, the save bar submits the changed ones; "changed" is computed against `data`,
  and reloads copy in only server-side changes (see ARCHITECTURE, Frontend). Actions it
  posts to must keep current values for fields not on the form.
- The redesign mockup is fully built (ROADMAP-ARCHIVE, "UI redesign").

### UI pitfalls already paid for
- `use:enhance` resets forms after success; data-bound forms use `update({ reset: false })`.
- Selects/checkboxes bound one-way to `data` miss post-save updates; use `bind:` on local state
  re-synced by `$effect`.
- An `$effect` calling an async function tracks everything read before its first `await`.
- Phones: narrow-window layout under `max-width: 60rem`, touch sizing under
  `pointer: coarse` (ARCHITECTURE, Frontend). Small controls get `class="hit-area"` instead
  of growing. Checked with a script that loads every page at 390 px and lists anything past
  the edge; desktop compared before/after by element boxes (only invisible ones moved).
- Slow `load` data is returned unawaited and read through `streamed()` (`lib/shared/streamed.svelte.ts`),
  not `{#await}`: an await block re-shows its placeholder on every reload/form action.
- Uploads take drops through `use:dropzone` (`lib/shared/dropzone.ts`) on the section they
  belong to: it fills that section's file input and fires change, so the upload code is the
  same as for picking; a drop outside every zone is swallowed, not opened by the browser.
- CSS a component gives to markup rendered inside it by others: `:global(.own-class .x)`
  has the specificity a page's `.x` rule had; `.own-class :global(.x)` adds the hash class
  and outranks the children's own rules (RestartFields' amber boot note went grey).
- List heights use the `fitToViewport` action (`src/lib/shared/fitToViewport.ts`), not
  `calc(100vh - ...)`.

## Open work

`docs/ROADMAP.md`, "Current direction"; status and open threads in `docs/notes/status.md`.
