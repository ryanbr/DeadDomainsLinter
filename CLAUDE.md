# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A CLI that scans adblock filter lists (`*.txt`) for rules referencing dead domains and removes/modifies them. Published to npm as `@adguard/dead-domains-linter`; this checkout is the `ryanbr` fork, which has diverged substantially from upstream `AdguardTeam/DeadDomainsLinter` (see `CHANGELOG.md` `[2.0.0]`). Upstream is wired as the `upstream` git remote; the fork's own remote is named `master` (so `git push master master`).

## Package manager: pnpm, not npm

The repo tracks `pnpm-lock.yaml`. Running `npm install` here generates a stray `package-lock.json` that does **not** belong in the repo — delete it if it appears. In environments where `pnpm` isn't on PATH, use `corepack pnpm <cmd>`.

The husky `pre-commit` hook runs `pnpm run lint` and `pnpm run test` and **hard-requires `pnpm` on PATH** — it fails with `pnpm: not found` under corepack-only setups. When that's the case, commit with `git commit --no-verify` (after running lint + tests manually).

## Commands

- Install: `pnpm install` (or `corepack pnpm install`)
- Lint: `pnpm run lint` (eslint, must be **zero** errors/warnings — the project keeps a clean baseline). Auto-fix: `npx eslint --fix <file>`.
- All tests: `pnpm run test`
- **Mocked tests only** (fast, no network — use this by default): `npx jest --runInBand --testPathIgnorePatterns=/integration/`
- Single test file: `npx jest test/mocked/linter.test.js --runInBand`
- Single test by name: `npx jest --runInBand -t 'dedupes in-flight lookups'`
- Run the CLI from the checkout without installing: `node src/cli.js -i <file>` (also `./src/cli.js`, it has a shebang)

### Tests: mocked vs integration

`test/mocked/` stubs the network and is deterministic. `test/integration/` makes **live DNS / urlfilter calls** and is flaky by nature — the `city.kawasaki.jp` case in `dnscheck.test.js` times out intermittently depending on real DNS, unrelated to code changes. Validate work against the mocked suite; treat an isolated integration failure as environmental unless it reproduces standalone.

Mocked tests stub `global.fetch` directly (`fetch = jest.fn(); global.fetch = fetch` in `beforeEach`, restore in `afterEach`) — there is no `jest.mock('node-fetch')` anymore (see below).

## Runtime requirements

Node ≥18, relied on for **built-in `fetch`** and bundled `undici`. The fork deliberately dropped `node-fetch@2` and `node:punycode` — both pulled in the deprecated `punycode` builtin and printed `DEP0040` on every run. HTTP now goes through global `fetch`; punycode conversion uses the userland `punycode` package (`require('punycode/')`, note the trailing slash). Don't reintroduce `node-fetch` or `node:`-prefixed punycode.

## Architecture

The pipeline is a layered chain, each layer in its own `src/` file, narrowing from files → rules → domains → liveness:

- **`cli.js`** — yargs arg parsing and the per-file loop. Owns the output modes, which are mutually-exclusive and validated here:
  - default: edit input files in place (after confirmation)
  - `--output/-o <path>`: write the modified list elsewhere (single input only)
  - `--export <file>`: write just the list of dead domains (no rule rewriting; sets `domainsOnly`)
  - `--diff[=<path>]`: write a unified diff (via the `diff` package) of proposed changes, touching nothing
  - `--export` and `--diff` imply `auto: true` (non-interactive previews).
- **`filelinter.js`** — `lintFile` parses a file into an agtree AST, then `processListAst` runs every rule through a **promise-based concurrency semaphore** (default 10, `-c` to change). The semaphore uses a head-indexed FIFO (`waitHead` pointer), not `Array.shift()`, to stay O(n) on large lists. `confirm()` drives the interactive Yes / Yes-to-all / No / No-to-all / Exit prompt; "to all" choices mutate `options.auto`/`options.show` and are **scoped per-file** because `cli.js` builds a fresh `linterOptions` object per file. `buildNewContents()` is the pure AST-mutation+serialize step, shared by `applyFileChanges` and the `--diff` path.
- **`linter.js`** — `lintRule` extracts domains from a rule AST (network patterns + `domain`/`denyallow`/`from`/`to` modifiers + cosmetic rule domains), checks liveness, and rewrites the rule (`modifyNetworkRule`/`modifyCosmeticRule`) or signals removal (`null` suggestedRule). Holds the **two-tier domain liveness cache** (module-level, lives for the process): `resolvedCheckCache` (`Map<string, boolean>`, read synchronously on the hot path) and `inFlightCheckCache` (`Map<string, Promise<boolean>>`, dedupes concurrent lookups of the same uncached domain into one urlfilter request). In-flight entries are evicted into the resolved map on success.
- **`urlfilter.js`** — batches domains (25/request) to the AdGuard urlfilter web service; a domain is "dead" when `registered_domain_used_last_24_hours === false`.
- **`fetchdomains.js`** — the actual HTTP via `fetchWithRetry` (honours `Retry-After` on 429/503). Wires an `undici.Agent` with a **custom DNS `lookup`** that caches resolutions for the process and funnels concurrent queries for the same host through one `dns.lookup` (avoids ENOTFOUND under parallel load).
- **`dnscheck.js`** — optional second opinion (`--dnscheck`, default on): re-checks domains the web service flagged dead with a direct A-record query, rotating across Google/Cloudflare/Quad9/OpenDNS resolvers (deliberately *not* AdGuard DNS, to avoid seeding the next domains snapshot). Also tries the `www.` variant.
- **`utils.js`** — `unique()` and `validDomain()` (tldts-based; skips IPs, bare TLDs, and a few special-use TLDs like `.onion`).

Data flow: `cli.js` → `filelinter.lintFile` → `linter.lintRule` → `linter.findDeadDomains` → `urlfilter.findDeadDomains` → `fetchdomains.fetchWithRetry`, with `dnscheck` as a post-filter inside `linter`.

## eslint config

`airbnb-base` + `jsdoc/recommended`, `@babel/eslint-parser`, 120-col `max-len` (URLs ignored), 4-space indent. Local helper functions need JSDoc (the `jsdoc/require-jsdoc` rule fires on them). `import/prefer-default-export` is off, so named-only exports are fine.

## Release process

`bamboo-specs/` is AdGuard's internal CI (Bamboo) and is dead config for the fork — the fork doesn't run it. To cut a fork release: bump `version` in `package.json`, add a section to `CHANGELOG.md`, commit, `git tag -a vX.Y.Z`, push the branch and the tag. **Pushing a tag does not create a GitHub Release** — the Releases page reads a separate API resource; create it with `gh release create vX.Y.Z --notes-file <notes>` (extract the matching CHANGELOG section). `tools/build-txt.js` just writes `dist/build.txt` with the version for CI; not needed locally.
