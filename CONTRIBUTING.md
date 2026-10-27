# Contributing to MineShell

How to set up a development copy, the conventions the code follows, and where things are.

## Setup

Clone the repository and install dependencies:

```sh
npm ci
cp .env.example .env
npm run setup
npm run doctor
npm run dev
```

For a production build:

```sh
npm run build
npm start
```

The production server respects `PORT` and `HOST` from `.env`.

If `doctor` reports that lingering is not enabled, run the following so user services can continue running after logout:

```sh
loginctl enable-linger "$USER"
```

Keep development data separate from any production MineShell installation by using a separate `MINESHELL_DATA` and `MINESHELL_UNIT_PREFIX`.

Run the test suite with:

```sh
npm test
```

Tests run offline and do not touch real server data. For watch mode and further details, see [tests/README.md](tests/README.md).

## Conventions

- **No formatter.** The code is hand-formatted: tabs, single quotes, no trailing commas. Match the surrounding style; running Prettier would rewrite whole files.
- **`npm run check` stays at 0 errors and 0 warnings**, and a bug fix comes with a test that fails without it.
- **One logical change per commit**, with a `fix:`, `feat:`, `test:`, `ci:`, `docs:` or `chore:` prefix. The prefixes decide the next version, and `feat:`/`fix:` subjects become release-note lines, so write them for users.
- **Docs move with the code:** a change to something a document describes updates that document in the same commit ([Architecture](docs/ARCHITECTURE.md), [Deployment](docs/DEPLOYMENT.md), the README's feature list).
- **Every page, form action and endpoint needs an entry in the access policy** (`src/lib/server/access/policy.ts`); without one it is refused for everyone. See [Architecture](docs/ARCHITECTURE.md), "Access".
- Run `git config core.hooksPath .githooks` once per clone: the pre-push hook runs the checks and the tests related to the push.

## Project layout

```text
migrations/          SQL migrations applied at startup
scripts/             Setup and diagnostic tools
src/lib/server/      systemd, RCON, journal, mod providers, scheduling,
                     monitoring, world operations, and other server-side logic
src/lib/shared/      Shared browser/server utilities, formatting, console handling, NBT
src/lib/components/  Shared UI components
src/routes/          Pages and endpoints
tests/               Test helpers, flow tests, fixtures, and recorded crash/log data
docs/                Architecture, deployment, and roadmap documentation
```

## Theming

MineShell's colors are defined using CSS custom properties in `src/app.css`. To add a theme, define a `[data-theme='name']` block and add an entry to `src/lib/shared/themes.ts`. The theme picker updates automatically.

The default theme is Deep Slate.
