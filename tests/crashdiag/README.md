# Crash diagnosis tests

Regression tests for `src/lib/server/crashdiag.ts`, the code behind the "what went wrong"
section of the crash panel on an instance's overview page.

## Run

```sh
npm run test:crashdiag          # or: node --experimental-strip-types tests/crashdiag/run.mjs -v
```

Needs Node 22.6+ (for `--experimental-strip-types`), nothing else. A case passes when the
expected diagnosis is listed first and marked fatal; `-v` prints every diagnosis per case.

## What is in here

| Path | What |
|---|---|
| `cases.json` | Expected result per case: diagnosis `kind`, regex for the culprit mod's name, optional regex for the related mod |
| `fixtures/<case>.log` | The console output of a failed start (machine paths replaced by `<instance>` / `<home>`) |
| `fixtures/<case>.mods.json` | The mods folder at the time, trimmed to the jars and class names the log refers to |
| `capture.mjs` | Turns a log + mods folder into a new case |
| `testmods/` | Sources and `build.py` for the tiny mods that crash on purpose |
| `crashrun.sh`, `matrix.sh` | Boot real loaders with those mods to record new logs |

The cases cover each loader's own wording, old and new:

- Fabric loader 0.12 (MC 1.16.5) and 0.19 (MC 1.21.1), Quilt 0.20 (MC 1.20.1)
- Forge 1.12.2, 1.16.5, 1.20.1; NeoForge 1.21.1; Cleanroom 0.4.4 and 0.5.17
- Each with a missing dependency and a mod touching client-only game code; Fabric/Quilt also
  with a mod depending on a client-only mod (the loader skips the client-only jar on servers)
- Real crashes: MeatballCraft on Cleanroom (Cell Terminal version mismatch, Alfheim mixin
  failure, FermiumBooter vs CleanMix, LoliASM on the wrong Forge), Vanilla Perfected
  (simple_datapacks needs client-only Mod Menu), Better MC (missingmodschecker opens a window),
  Cleanroom 0.6 and Fugue 0.24 on Java 21

## Add a case from a real crash

```sh
journalctl --user -u minecraft@<id> -o cat > /tmp/crash.log     # or any saved console log
node --experimental-strip-types tests/crashdiag/capture.mjs \
  <case-name> /tmp/crash.log ~/mineshell-data/instances/<id>/mods <kind> '<culprit regex>' ['<related regex>']
npm run test:crashdiag
```

Trim the log to the failed run first (from the last `Started minecraft@...` line), or the
earlier runs are included too. Check the fixture log for anything you would not want in the
repo (player names, IPs) before committing; crashes at startup normally contain neither.

## Record logs for a new loader or version

Use a throwaway MineShell data directory, never the real one:

```sh
python3 tests/crashdiag/testmods/build.py        # needs a JDK (javac); writes testmods/jars/
MINESHELL_DATA=/tmp/ms-test MINESHELL_AUTH=off MINESHELL_UNIT_PREFIX=mstest npx vite dev --port 5199
```

Create blank instances for the loaders/versions you want (instance ids in `matrix.sh`), then:

```sh
MINESHELL_DATA=/tmp/ms-test OUT=/tmp/crashlogs tests/crashdiag/matrix.sh
```

and capture each `OUT/<instance>--<case>.log` with its `.mods` folder as above.

Caveats learned the hard way:

- `crashrun.sh` boots the server process directly (same Java and arguments as the unit), not
  through systemd. For an end-to-end check of the crash panel, the test server's template unit
  has to be installed (Settings → install unit), which writes `mstest@...` files to
  `~/.config/systemd/user/`; remove them afterwards.
- Even without the template unit, every instance sync writes a restart drop-in
  (`~/.config/systemd/user/mstest@<id>.service.d/`); clean those up too.
- Most loaders exit with code 0 after a startup crash, so `exit=0` in the matrix output does
  not mean the server started; `reached-done` does.
- Fabric loader 0.11.x cannot be installed through MineShell (Fabric's server-jar endpoint
  rejects it); 0.12 is the oldest covered.
