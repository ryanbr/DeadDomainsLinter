# Dead Domains Linter Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog], and this project adheres to [Semantic Versioning].

[Keep a Changelog]: https://keepachangelog.com/en/1.0.0/
[Semantic Versioning]: https://semver.org/spec/v2.0.0.html

## [2.0.0] - 2026-05-25

Fork release with substantial divergence from upstream 1.0.33. Major bump
reflects new flags, the migration off `node-fetch`/`node:punycode`, and the
rewritten caching/concurrency internals — behaviour for existing flags is
backward-compatible, but the userland dep set and on-disk progress output
changed enough to warrant the version jump.

### Added

- `-o`, `--output <path>`: write the modified filter list to a separate path
  instead of overwriting the input. Incompatible with `--export`; requires
  exactly one input file.
- `--diff[=<path>]`: emit a unified diff of the proposed removals/modifications
  to a `.patch` file (default `dead_domains_<timestamp>.patch`) without
  touching the input. Auto-confirms; incompatible with `--export` and
  `--output`.
- `-c`, `--concurrent <n>`: cap concurrent rule processing (default 10).
- Bare `--export` (no value) now generates `dead_domains_<timestamp>.txt`.
- Per-rule confirmation prompt gains `Yes to all` and `No to all` bulk
  choices. Both are scoped per-file: choosing one on file A does not carry
  into file B in a multi-file run.
- Prompt also gains an `Exit` option, and `Ctrl+C` exits cleanly instead of
  hanging.
- Progress now reports `Analyzed X/Y rules, found Z issues` in-place via
  `\r`, with totals shown on the final tick.

### Changed

- Switched from `node-fetch@2` to the built-in `fetch` backed by an
  `undici.Agent` with a custom DNS cache. Eliminates the
  `DEP0040 — punycode is deprecated` warning that fired on every run.
- Replaced `node:punycode` usage with the userland `punycode` package for the
  same reason.
- DNS-check throughput improved: replaced the busy-wait semaphore with a
  promise-based one, and rotated across 4 public resolvers
  (Google/Cloudflare/Quad9/OpenDNS).
- `processListAst` semaphore uses a head-indexed FIFO instead of
  `Array.shift()` — O(n²) → O(n) in the queue (200ms recovered on a 100k-rule
  list).
- Domain liveness cache split into two tiers: a synchronously-readable
  resolved map and an in-flight promise map. Concurrent callers asking for
  the same uncached domain share one urlfilter request instead of each
  issuing their own. Cache hits no longer allocate per-domain microtasks.
- Replaced `Array.includes` lookups with `Set`/`Map` for O(1) membership in
  the hot path.
- Startup banner drops the `@adguard/` scope — matches the binary name the
  user invoked.
- `--output` validation error now echoes the glob expression so the user can
  see what was searched.
- Dependencies bumped within ranges; `consola` 3.2.3 → 3.4.2.

### Fixed

- `dnsLookup` no longer NPE's when `dns.lookup` returns an error or empty
  address list (covers both the cache-hit and fresh-resolve paths).
- In-flight cache entries are evicted into the resolved map on success,
  halving the steady-state cache footprint.
- Promise-cache dedup test now asserts the fetch count is exactly 1 (was
  `<= 1`, which would have silently passed a regression that skipped the
  fetch entirely).
- Skip `modifyRule` cloning when exporting — pure speedup for `--export`
  runs.
- ESLint warnings/errors cleared across the project.

## [1.0.33] - 2025-09-01

### Changed

- Linter now respects retry-after header for requests to adtidy API [#43].
- Non ascii domains are now converted to punycode and checked [#35].

[#35]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/35
[#43]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/43

## [1.0.28] - 2025-07-09

### Added

- Option to add a file with domains to ignore when running [#33].

[1.0.28]: https://github.com/AdguardTeam/DeadDomainsLinter/compare/v1.0.22...v1.0.28
[#33]: https://github.com/AdguardTeam/DeadDomainsLinter/pull/33

## [1.0.22] - 2024-12-26

### Fixed

- `consola.info is not a function` error [#32].

[1.0.22]: https://github.com/AdguardTeam/DeadDomainsLinter/compare/v1.0.19...v1.0.22
[#32]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/32

## [1.0.19] - 2024-02-08

### Changed

- Requests to the urlfilter service so that only domain info was checked
  without testing which lists match the domain, it should speed up the process.

[1.0.19]: https://github.com/AdguardTeam/DeadDomainsLinter/compare/v1.0.18...v1.0.19

## [1.0.18] - 2024-02-01

### Fixed

- Issue with importing a list of domains [#23].

[1.0.18]: https://github.com/AdguardTeam/DeadDomainsLinter/compare/v1.0.16...v1.0.18
[#23]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/23

## [1.0.16] - 2024-01-31

### Added

- Option to use a pre-defined list of dead domains from a file [#20].
- Option to export the list of dead domains to a file [#8].

### Fixed

- Issue with keeping negated domains in a network rule [#19].

[1.0.16]: https://github.com/AdguardTeam/DeadDomainsLinter/compare/v1.0.13...v1.0.16
[#8]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/8
[#19]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/19
[#20]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/20

## [1.0.13] - 2024-01-31

### Fixed

- Issue with some rarely visited domains marked as dead [#16].
- Issue with rules that target IP ranges [#17].
- Issue with checking FQDN in rules [#18].

[1.0.13]: https://github.com/AdguardTeam/DeadDomainsLinter/compare/v1.0.8...v1.0.13
[#16]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/16
[#17]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/17
[#18]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/18

## [1.0.8] - 2024-01-31

### Fixed

- Issue with extracting domains from some URL patterns [#11].
- Issue with testing custom TLD [#13].

[1.0.8]: https://github.com/AdguardTeam/DeadDomainsLinter/compare/v1.0.6...v1.0.8
[#11]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/11
[#13]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/13

## [1.0.6] - 2024-01-29

### Added

- Option to comment the rule out instead of removing it [#4].

### Changed

- Speed up the build by running several checks in parallel [#2].

### Fixed

- Issue with incorrect line numbers [#1].
- Issue with counting IPv4 addresses as dead domains [#5].
- Issue with suggesting removing TLDs and extension IDs [#6].

[1.0.6]: https://github.com/AdguardTeam/DeadDomainsLinter/compare/v1.0.4...v1.0.6
[#1]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/1
[#2]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/2
[#4]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/4
[#5]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/5
[#6]: https://github.com/AdguardTeam/DeadDomainsLinter/issues/6
