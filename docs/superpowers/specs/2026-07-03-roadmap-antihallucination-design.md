# Rinnegan Roadmap: Anti-Hallucination & Codebase Understanding

**Date:** 2026-07-03
**Status:** Draft for review
**Goal:** Improve Rinnegan so humans develop better code and codebase understanding
without their coding agents hallucinating — while preserving the core promise:
*deterministic, no neural embeddings, no external API*.

## Background

The original proposal listed four feature areas: backend abstraction (S3/git), a
"brain" (hierarchical keys, vectors, domains, namespaces), quality gates
(secrets/lint/tests/LSP + LLM eval, pre-commit), and a metadata system (xattrs,
JSONL inventory, tree-sitter auto-classification). This design keeps what serves
the goal and rejects what breaks the product's differentiator:

- **Neural vectors and LLM eval are rejected.** They break determinism (same
  corpus ⇒ byte-identical output) — the core promise. LSA already provides
  deterministic meaning-search.
- **Generic quality gates (secrets/lint/tests) are rejected.** gitleaks, eslint,
  and husky own that space. Rinnegan builds the one gate only it can:
  fact-checking code against the knowledge graph.
- **xattrs are rejected.** Extended attributes are lost by git, inconsistent
  across platforms, and invisible to agents. Metadata lives in the SQLite index
  where everything else already lives.
- **S3/git storage abstraction is deferred.** The index is one SQLite file,
  rebuilt deterministically. CI caching + file copy solves sharing without an
  abstraction layer.

## Phase 0 — Freshness guard

**Problem:** the MCP server indexes once at startup (`runMcp`) and never again.
A long-lived session serves stale line numbers and signatures labeled
`ast_exact` — stale ground truth is the worst hallucination amplifier the
product can produce.

**Fix:**
- Before each MCP tool call, run a mtime sweep over known files (gate 1 of the
  indexer's two-gate change detection — milliseconds) and `reindexPath` any
  changed/removed files. New files are picked up by a periodic full scan or on
  sweep miss; correctness bar: no tool answer may cite a file the sweep saw change
  without reparsing it first.
- CLI commands already re-open per invocation but only auto-index when the DB is
  empty (`ensureIndexed`); they get the same sweep so answers are never stale.
- `understand` output header gains a freshness stamp: `# index: fresh` or
  `# index: N file(s) reindexed just now` — the reader knows facts reflect the
  working tree at answer time.

**Testing:** modify a fixture file after indexing, call `understand`/a tool,
assert the answer reflects the new content and the stamp reports the reindex.

## Phase 1 — Role classification + inventory

**What:** Every indexed file gets a `role`, computed deterministically at index
time and stored on the `files` table:

`entrypoint | test | config | generated | vendored | doc | library` (default: `library`)

**Classification signals (checked in this precedence order, first match wins):**

1. `vendored` — path under `vendor/`, `third_party/`, or `.gitmodules`-listed dirs.
2. `generated` — first 20 lines contain `@generated` or `DO NOT EDIT` marker, or
   filename is a lockfile (`package-lock.json`, `Cargo.lock`, `go.sum`, ...).
3. `test` — path matches test conventions (`*.test.*`, `*.spec.*`, `__tests__/`,
   `test_*.py`, `*_test.go`, `spec/`, ...) or file imports a known test framework
   (vitest, jest, mocha, pytest, testing, junit, rspec, ...).
4. `entrypoint` — referenced by a manifest `bin`/`main`/`exports` field (the
   manifests parser already extracts these), or has a shebang line, or matches
   `main.*`/`index.*` in a directory containing a recognized manifest (the
   definition of "package root").
5. `config` — known config filenames/patterns (`tsconfig*.json`, `.eslintrc*`,
   `*.config.{js,ts,mjs}`, `Dockerfile`, `Makefile`, ...) plus everything the
   manifests/MCP-config special parsers already handle.
6. `doc` — the doc extensions already recognized (`.md/.mdx/.rst/.txt`).
7. `library` — everything else.

**Status is computed at query time, not stored** (stored status goes stale):
a node is `orphaned` when it has zero inbound edges and is not exported and its
file is not an entrypoint. Computed with one LEFT JOIN — the graph is local SQLite,
this is cheap.

**Schema change:** `ALTER TABLE files ADD COLUMN role TEXT NOT NULL DEFAULT 'library'`
(new schema ships the column; existing DBs migrate via `CREATE TABLE IF NOT EXISTS`
+ additive `ALTER` guard, same pattern as a re-index).

**Ranking integration:** `rankNodes` gains a role multiplier alongside
`KIND_WEIGHT`: `vendored: 0.2, generated: 0.3, test: 0.5, config: 0.7,
doc: 0.7, library: 1.0, entrypoint: 1.1`. Exception: when the task text contains
a test-intent token (`test`, `spec`, `coverage`), `test` weight becomes `1.0`.
Deterministic — pure function of task string + stored role.

**New command:** `rinnegan inventory [--json]`
- Human output: one line per file — `path  role  language  symbols=N  in=M  [orphaned]`.
- `--json`: JSONL, one object per line:
  `{"path", "role", "language", "symbols", "inboundEdges", "orphaned"}`.
- Sorted by path. Deterministic.

**Consumers:** Phase 2 uses roles to skip vendored/generated files in verification;
Phase 3 uses `entrypoint` roles as domain anchors; `understand` ranking improves
immediately.

## Phase 2 — `rinnegan verify`: the graph-native quality gate

**What:** Fact-check proposed code against the knowledge graph *before* it lands.
This is the direct attack on hallucination: an agent (or human) gets a
deterministic report of which referenced symbols actually exist, what their real
signatures are, and what breaks if edited definitions change.

**Mechanism (reuses the existing parse pipeline — no new tokenizer):**

1. Determine the changed-file set and added-line ranges from one of:
   - `--staged` — `git diff --cached -U0` (the pre-commit mode)
   - `--diff <file>` — a unified diff on disk or stdin (the agent mode: agent
     passes its proposed patch before applying it)
2. For each changed file, parse the **post-image** (staged content via
   `git show :<path>`, or the diff applied in memory) with the existing
   `parseFile` + `resolveImports` machinery. Resolution runs against an
   **in-memory overlay** of the graph (post-image nodes layered over the persisted
   index inside a rolled-back transaction or `:memory:` attach) — `verify` never
   mutates the on-disk index.
3. Report, restricted to added-line ranges:
   - **Unknown symbol** (severity: error) — a call/reference whose resolution is
     `unresolved` and whose name matches nothing in the graph (not a local
     binding, not an import, not a known global). The #1 hallucination signature.
   - **Signature echo** (severity: info) — for every resolved call, print the
     callee's ground-truth signature + `file:line`, so the caller's argument list
     can be compared by the human/agent.
   - **Blast radius** (severity: warn) — for every symbol whose *definition* the
     diff touches, list its callers (existing `impact` query). Warn if callers
     exist outside the diff.
4. Files with role `vendored`/`generated` are skipped.

**Surfaces:**
- CLI: `rinnegan verify [--staged | --diff <patch>] [--json]`. Exit code 1 iff
  any error-severity finding. JSON mode emits the findings array for agents.
- MCP: new tools `verify` (input: unified diff text) and `lookup` (below) join
  `understand` in the default-listed set.
- Pre-commit: documented one-line hook (`rinnegan verify --staged`) in README;
  no husky dependency, users add it to `.git/hooks/pre-commit` or their existing
  hook manager.

**`lookup` — the pre-write companion to verify:**
`verify` catches hallucinations after code is written; `lookup` prevents them
before. New MCP tool + CLI command:

- Input: exact symbol name (optionally qualified).
- Output when found: ground-truth signature, `file:line`, kind, caller count,
  provenance — the facts needed to call it correctly.
- Output when absent: explicit `NOT FOUND — no symbol named 'X' exists in this
  codebase. Do not invent it.` Plus up to 3 nearest FTS matches as "did you mean".
  The explicit negative is the point: agents treat silence as license to invent;
  a stated negative is evidence.

The agent loop becomes: `understand` → `lookup` anything you are about to call →
write patch → `verify` → apply.

**Honesty constraints (same provenance discipline as the rest of the product):**
- Only `ast_exact` facts produce error-severity findings. Heuristic resolutions
  never block a commit — they appear as info with their provenance label.
- Dynamic languages will have unresolvable-but-legitimate calls; the unknown-symbol
  check only fires when the name matches *nothing* in graph, imports, locals, or a
  built-in allowlist per language. False-positive suppression: `--allow <name>`
  and an optional `.rinnegan-allow` file.

## Phase 3 — Domains + architecture map

**What:** Deterministic grouping of files into named domains, plus a rendered
architecture overview for humans.

**Domain computation (on demand, not stored — no staleness):**
1. Build the file-level import graph (already available via `imports` +
   resolved edges).
2. Seed labels: each top-level directory under the source roots is a candidate
   domain (this alone covers most repos).
3. Refine with deterministic label propagation: a file adopts the label with the
   highest edge weight among its neighbors; ties break lexicographically; iterate
   to fixpoint with a hard cap of 10 rounds; files processed in sorted path order.
   No randomness anywhere.
4. Name each domain by the common path prefix of its members; entrypoint-role
   files are listed first as the domain's front door.

**New command:** `rinnegan map [--mermaid] [--json]`
- Markdown output: one section per domain — name, entrypoints, top-5 symbols by
  centrality, and inter-domain dependency lines (`cli → graph, semantic`).
- `--mermaid`: same information as a `flowchart LR` block for embedding in docs.
- `--json`: machine form.

**`understand` integration:** new option `--scope <domain>` restricts seeding and
spine expansion to files in that domain. Helps large repos: the agent first calls
`map`, then `understand --scope`.

**Stale-doc detection:** the docs parser currently extracts links/wikilinks but
ignores inline code. Extend it to resolve `` `identifier` `` mentions against the
graph, producing `references` edges with `heuristic` provenance (name match only).
New command: `rinnegan docs --stale` — lists doc locations whose referenced
symbol no longer exists (`doc.md:12 mentions 'oldFunc' — no such symbol`).
Humans stop learning from rotten docs; agents stop citing them.

**Test linkage:** test-file call edges are already in the graph, and Phase 1
marks test files. New command: `rinnegan tests <symbol>` — tests that (transitively,
depth 2) call the symbol. `understand` DETAIL tier gains a one-line
`covered-by: test/a.test.ts, …` annotation per symbol (empty = visible coverage
gap, no instrumentation needed). Agents learn which tests to run after an edit.

## Phase 4 — Index sharing (deliberately minimal)

**What:** Make the already-deterministic index easy to share; build no storage
abstraction.

- `rinnegan status` gains a `fingerprint` field: hash over `(path, contentHash)`
  pairs sorted by path — the corpus identity. Same fingerprint ⇒ same index bytes.
- README recipe: CI caches the `.db` file keyed on the fingerprint; teammates
  restore instead of re-indexing. Copying the SQLite file *is* the export format.
- S3/git backends: revisit only if a real repo shows indexing time that caching
  cannot absorb. Recorded here so the decision isn't re-litigated from scratch.

## Build order & dependencies

```
Phase 0 (freshness) independent — ship first, everything downstream depends on
                    answers being current.
Phase 1 (roles) ──feeds──▶ Phase 2 (verify skips vendored/generated; test roles
        │                  gate nothing but inform reporting)
        └────────feeds──▶ Phase 3 (entrypoints anchor domains; test roles feed
                           test linkage)
Phase 4 independent, mostly documentation.
```

Each phase ships independently: freshness (0), schema change + inventory (1),
verify + lookup (2), map + stale-docs + test linkage (3), fingerprint + docs (4).
Phases 2 and 3 can build in parallel after 1.

## Testing

Same style as the existing suite (vitest, real fixtures, no mocks of the graph):
- Phase 1: fixture repo with one file per role; assert classification, inventory
  output (text + JSONL), and ranking down-weight of a test file vs library file.
- Phase 2: fixture diff introducing (a) a call to a nonexistent symbol,
  (b) a call to a real symbol, (c) an edit to a called definition; assert
  error/info/warn findings respectively; assert exit codes; assert vendored file
  changes are skipped. `lookup`: found symbol returns signature + location;
  absent symbol returns the explicit NOT FOUND text + nearest matches.
- Phase 3: fixture with two directories importing across a shared module; assert
  stable domain assignment across two runs (byte-identical output). Stale-docs:
  doc mentioning a real and a dead symbol → exactly the dead one reported.
  Test linkage: symbol called by a test file → listed by `rinnegan tests`.
- Phase 4: fingerprint stable across re-index of unchanged corpus; changes when
  any file changes.

## Error handling

- `verify` outside a git repo with `--staged`: clear error, suggest `--diff`.
- Unparseable post-image (syntax error in patch): report as its own error-severity
  finding (an agent patch that doesn't parse is itself a hallucination signal),
  continue with other files.
- `map` on an unindexed repo: auto-index first (same `ensureIndexed` pattern as
  other commands).
- Unknown `--scope` domain: list available domains in the error.

## Out of scope (explicit)

Neural embeddings, LLM-based evaluation of any kind, secrets/lint/test runners,
LSP integration, xattr metadata, S3/git storage backends, multi-repo federation
(hierarchical keys/namespaces across repos). Each either breaks determinism,
duplicates an existing tool, or solves a problem no user has hit yet.

**Deferred (cheap, revisit on demand):** `understand --changed` — seed the slice
from the working-tree diff instead of task text alone.
