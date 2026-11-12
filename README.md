<div align="center">

<img src="docs/branding/rinnegan-cool.png" alt="Rinnegan — the all-seeing eye for your codebase" width="100%" />

# Rinnegan

**The all-seeing eye for your codebase.**

</div>

**Verifiable code-knowledge engine.** For any task, Rinnegan returns
the *minimal, maximal-signal, provenance-tagged* slice of a codebase — the smallest set of
facts an AI agent needs to write precise, hallucination-free code. Like the dōjutsu it's named
for, it perceives every path: the whole symbol graph, every edge, and the blast radius of any
change — while marking exactly which facts are ground truth.

- **Deterministic.** No neural embeddings, no AI tokenization, no external API. Same
  corpus ⇒ byte-identical index and output — `index` parses files on a bounded worker
  pool but commits them in sorted file order, so neither `--jobs` nor parse-completion
  order can change a single row.
- **Semantic discovery without a model.** Classical latent-semantic analysis (TF-IDF +
  truncated SVD) — find code by meaning, fully local and reproducible.
- **Provenance on every fact.** Each graph edge is tagged `ast_exact | ast_inferred |
  heuristic | lexical | latent | unresolved` with a confidence. Only `ast_exact` is
  ground truth; everything else is visibly labeled.
- **Beats lost-in-the-middle.** Output is budgeted and position-ordered (highest signal
  at the context edges) so a fraction of a 1M window is more than enough.

Surfaces: **library** (`Rinnegan`), **CLI** (`rinnegan understand <task>`), **MCP server**
(default tools: `understand`, `lookup`, `verify`, `map`; `RINNEGAN_MCP_TOOLS=all` adds
`search`, `deps`, `refs`, `callers`, `impact`).

See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for the build plan.

## Install & use

```bash
git clone https://github.com/hypervisor-io/rinnegan.git
cd rinnegan
npm install        # better-sqlite3 ships a prebuilt binary (Node 22+)
npm run build
node bin/rinnegan.js index [--jobs N] # build the SQLite knowledge graph (N parse workers, default cores-1; 1 = serial)
node bin/rinnegan.js understand "how does X work"   # minimal provenance-tagged slice
node bin/rinnegan.js mcp              # MCP server (understand, lookup, verify, map)
```

Other commands: `inventory`, `verify [--staged|--diff <file|->] [--allow <names...>]`,
`search`, `deps <file>`, `refs <symbol> [--write|--read]`, `callers <symbol>`,
`tests <symbol>`, `lookup <name>`, `impact <symbol>`, `docs --stale`, `map [--mermaid]`,
`status`, `watch`. `understand` also takes `-s, --scope <domain>` to restrict the slice
to one architectural domain (see `rinnegan map`). Add `--json` to any command for
machine output.

**Agent loop.** `understand` the task → `lookup` anything about to be called → write
the patch → `verify` it → apply.

## How it works

A repo becomes a queryable graph in five stages, then gets budgeted into an answer:

```mermaid
flowchart LR
  subgraph Ingest
    A["scanFiles<br/>git-first, .gitignore-respected"] --> B["two-gate change detection<br/>mtime, then hash"]
  end

  subgraph Parse
    C1["TS/JS compiler AST"]
    C2["tree-sitter<br/>19 languages"]
    C3["bespoke<br/>Elixir, Terraform, SFC, docs, manifests"]
  end

  subgraph Store
    D[("SQLite graph<br/>nodes + edges: provenance, confidence, FTS5")]
    E["role classification"]
  end

  F["cross-file import resolution<br/>unresolved → ast_inferred"]

  subgraph Semantic
    G["TF-IDF → truncated SVD, LSA, + BM25<br/>deterministic, no model"]
  end

  subgraph Signal
    H["seed → spine<br/>anchor + bounded graph walk"]
    I["rank<br/>relevance × centrality × trust × role"]
    J["budget<br/>MAP → SIGNATURES → DETAIL"]
  end

  subgraph Surfaces
    K["CLI"]
    L["MCP<br/>understand, lookup, verify, map"]
    M["library"]
  end

  B --> C1 & C2 & C3
  C1 & C2 & C3 -->|"provenance-tagged nodes+edges"| D
  D --> E
  D --> F
  F --> G
  G --> H
  E -.->|"role weight"| I
  H --> I --> J
  J --> K & L & M
```

**The agent loop**, and what `verify` actually does before an edit is trusted:

```mermaid
flowchart LR
  U["understand the task"] --> L["lookup<br/>anything about to be called"]
  L --> P["write the patch"]
  P --> V["verify the diff"]
  V -->|clean| AP["apply"]
  V -->|findings| P

  subgraph Overlay["verify's overlay (always rolls back)"]
    direction LR
    V1["parse post-image"] --> V2["check against graph<br/>unknown-symbol, signature, blast-radius"] --> V3["rollback"]
  end

  V --> V1
```

## Sharing the index (CI cache)

The index is one file: `.rinnegan/graph.db`. Cache it in CI so warm runs update instead
of reindexing cold.

```yaml
- run: npm ci && npm run build
- uses: actions/cache@v4
  with:
    path: .rinnegan
    key: rinnegan-${{ runner.os }}-${{ github.sha }}
    restore-keys: rinnegan-${{ runner.os }}-
- run: node bin/rinnegan.js index
```

`bin/rinnegan.js` runs the built `dist/cli/main.js`, so install + build must happen
before `index` regardless of cache state; the cache only covers `.rinnegan`, so its
position relative to `npm ci`/`npm run build` doesn't change correctness — it's placed
after here to follow the standard deps-then-build-then-restore-artifacts order.

`index`'s two-gate change detection (mtime, then hash) means a restored cache only
reparses what changed since it was written — not the whole repo. Confirm two machines
(or a cache restore vs. the working tree) hold the same corpus:

```bash
node bin/rinnegan.js status --json | jq .fingerprint
```

No S3 or git-backed store for the index — it's a single SQLite file, so `actions/cache`
(or a plain `cp`) is the whole sharing story.

### The semantic model is cached in the same file

`understand` ranks seeds with a deterministic LSA (TF-IDF + truncated SVD) + BM25
model. The SVD is the only expensive step in the pipeline — minutes on a large corpus
— so it must not run once per process. `index` stays semantic-free and fast; the first
`understand` after an index change builds the model and persists it in
`graph.db`'s `semantic_cache` row, and every later process loads it instead:

| corpus | `understand`, first run (build + save) | later runs (load) |
| --- | --- | --- |
| 229k nodes | 478 s | 2.5 s |
| 22k nodes | 21 s | 1.3 s |

The cache key is the corpus fingerprint (the same value `status` prints) plus the
node count and the tokenizer recipe version, so any index mutation — or any change
to how documents are tokenized — invalidates it; a stale model is never served. The
payload is a versioned, little-endian binary blob (bump `SEMANTIC_CACHE_VERSION` in
`src/semantic/cache.ts` to invalidate every existing row), and loading it reproduces
the built model bit for bit, so answers are identical either way. On a read-only
`graph.db` queries still work; they just rebuild instead of caching.

### Path-aware, best-window file prior + identifier morphology (retrieval)

Symbol text alone is captured by lexically-loud files: a query about "driving IO
with epoll" finds `benches/*.rs` and test helpers before `runtime/io/driver.rs`,
because only symbol names are indexed. `index` therefore also writes each file's
PATH and BODY tokens to `files_fts` and `files_windows`:

- **path tokens** (`path_tokens`, weighted 6:1 over the body) — a path is a
  deliberate, low-noise statement of what a file is for (`promql/engine.go`,
  `action_dispatch/routing/route_set.rb`). Without them a short README that
  repeats the query's words outranks the file that implements the concept because
  BM25 length-normalizes long documents down.
- **whole-file body tokens** (`files_fts.tokens`, deterministic `basicTokens` in
  file order, capped at 4096 tokens per file) — one BM25 document per file.
- **body windows** (`files_windows` + `files_windows_fts`): the same body tiled
  into at most 16 contiguous chunks of ≥512 tokens (exactly 512 until a file gets
  long enough to need bigger ones, never more rows than that), each carrying
  absolute `start_line`/`end_line`. Every window is its own BM25 document, with
  the file's path tokens repeated in its `path_tokens` column.
- **identifier morphology** on both sides: a small, corpus-independent map of
  programming verbs (`evaluate`/`evaluation` → `eval`, `registration` →
  `register`, `routing` → `route`) plus a conservative suffix rule, so a prose
  task can meet the identifiers it names. Raw tokens are always kept, so exact
  matches never regress.

`understand` scores each file in both views and takes the maximum:

```
window:  max over the file's windows of bm25(files_windows_fts, 0, 6, 1)
whole :                             bm25(files_fts, 0, 6, 1)      (pre-window)
prior  = max(normalize(window), normalize(whole)) ∈ 0..1, best file = 1
```

BM25 divides every term's contribution by the document's length relative to the
average, so a 50k-token implementation file was being averaged — and
length-normalized — away against a 30-line helper that repeated two query words.
A ~512-token window is about one method plus its neighbours, so the file is
ranked by the chunk that actually holds the evidence (`promql/engine.go` reaches
the `eval`/`execEvalStmt` region it never used to). The whole-file view is kept
in the maximum because it is better when the evidence is *diffuse* — a file that
says the right thing once per section accumulates over its whole body under one
document (tokio's `io/poll_evented.rs`), and the maximum is monotone in both, so
no file that used to be strong can be diluted.

Each symbol's rank is then multiplied by `1 + 2·prior`. The six best prior files
(score ≥ 0.5, never test/doc) additionally seat their definition symbols in the
ranking pool, because a ranker can only reorder what the spine already contains —
and on Rust, whose extractor emits no cross-file `references`, the implementing
file is otherwise unreachable. Anchors stay purely lexical.

Two guards keep that seating from becoming a dump: the strongest prior file's own
definitions are reseated as one **same-file coherence** block (top 5 by rank, then
source order), and DETAIL renders at most five facts per file so one long file
cannot spend the whole specificity budget.

### Symbol-body prior (choosing *inside* a file)

The file prior can only say *which file* is about the task. Inside it every symbol
still looks alike, so `scrape/manager.go` hands its DETAIL slots to the ten
`Targets*` accessors — names that repeat the query word — while `reload` /
`updateTsets` (the code that actually collects targets) never appear.

`understand` therefore scores each candidate's **own source body**
(`startLine..endLine`, `bodyRelevance` in `src/signal/body.ts`) with the same
deterministic BM25 and the same tokenizer recipe as the file prior — name,
signature, docstring and body, morphologically expanded — over the candidates
already in the pool (spine + the six prior files), normalized so the best body is
1, and multiplies rank by `1 + 2·score` again. One read per candidate file (the
renderers' cache), never a corpus-wide scan.

Three deterministic limits keep it honest:

- **32 kB body cap** (`BODY_CHAR_CAP`, ≈8k tokens): a generated 6k-line method
  cannot dominate a query's cost, and truncation at a fixed character count keeps
  the score byte-identical run to run.
- **200-line span cap** (`BODY_SPAN_LINES`): a 400-line `main()` or a 600-line
  evaluator mentions every query word somewhere; promoting it spends the one
  boost on a fact too big for DETAIL, and a `module` that wraps a whole file just
  applies the file prior twice. Past that size the body is a file section.
- **Definition kinds only** — a `variable`'s body is an initializer — and no body
  boost for test/doc files unless the task mentions tests.

A missing or unreadable file simply has no body: the prior is a no-op, never an
error. Measured on the five-corpus eval, the body prior is what puts
`execInstantEval`, `runInstantQuery`, `NewInstantQuery` and `execEvalStmt` next to
`eval` for "how does PromQL evaluate an instant query", and it costs ~0.3–0.45 s
per query on a warm index (pool-bounded, not corpus-bounded).

**Upgrading an existing index.** `files.fts_version` records the token recipe that
produced each file's row. A database written before path tokens existed is
migrated automatically on the next write open (the FTS table is recreated and every
file is stamped stale), and the next plain `rinnegan index` rebuilds those rows
from the file bytes — no reparse, no `ANALYZER_VERSION` bump, and later runs are a
cheap per-file presence check. The semantic model's cache key includes the
tokenizer recipe version, so a model built by the old recipe is a miss, not a
subtly-wrong hit. Querying an old `graph.db` read-only still works: a missing
prior is a no-op, never a failure.

## Pre-commit gate

```bash
echo 'rinnegan verify --staged || exit 1' >> .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

Unknown-symbol and parse-failure errors block the commit; signature echoes and
blast-radius warnings inform but never fail it.

## Purpose

Rinnegan is **internal machinery for AI coding agents**, not a user-facing graph tool.
Its sole job: hand any attention-limited / sparse-attention model the *exact signal* it
needs to make precise, no-nonsense edits to an existing codebase — and nothing else.

**Harmonic memory.** `understand` returns three zoom tiers in one budget so the model
gets the shape first and the exact lines last:
`MAP` (symbols by file) → `SIGNATURES` (the spine at a glance, definitions only) →
`DETAIL` (whitespace-minified, provenance-tagged source to edit). Deterministic — no LLM
summarization (that is cognee's bloat; we reject it and keep only the multi-resolution idea).

**Any agent.** `rinnegan install <agent>` emits MCP config for Claude Code, Cursor, Cline,
Codex, Kiro, Pi, Windsurf, Gemini, opencode. MCP stdio is the universal transport.

## Coverage (v0.1)

**Code — 23 languages.** TS/JS (compiler API, type-aware method resolution) + Python,
Go, Rust, Java, PHP, C#, Ruby, C, C++, Swift, Kotlin, Scala, Zig, Lua, Solidity,
Objective-C, Bash, OCaml, ReScript (tree-sitter, verified spec registry — adding a
grammar is one table entry), plus **Elixir** (def/defmodule macros parsed as call nodes)
and **Terraform/HCL** (block defs + `var.*`/resource/module traversal references) via
bespoke extractors. The Terraform grammar is vendored under `vendor/wasm/` (ABI-compatible,
not in tree-sitter-wasms).

**Composite SFCs — Vue / Svelte / Astro.** The `<script>` block is sliced out textually,
parsed with the precise TS/JS extractor, and line numbers are remapped back to the original
`.vue/.svelte/.astro` file — one code path, no SFC grammar required.

**Non-code.**
- **Docs** (`.md/.mdx/.rst/.txt`): markdown links + `[[wikilinks]]` → `references` edges between docs.
- **Manifests** (`package.json/go.mod/pyproject.toml/pom.xml/cargo.toml/apm.yml`): one
  canonical package **hub** node per dependency (shared across manifests) + depends_on edges.
- **MCP configs** (`.mcp.json/mcp.json/claude_desktop_config.json`): server nodes with
  command/args/env requirements + package refs.

**Skipped, with reason (verified by probe, never assumed):** Dart (grammar is ABI v15;
web-tree-sitter runtime supports 13–14 — no compatible build sourced); YAML/Elm/QL (wasm
fails to load under the runtime); CSS/HTML/JSON/TOML (load fine, but no clean def/call model
beyond what the manifest/MCP extractors already cover).

## Status

Working end-to-end: SQLite provenance graph · scope-aware TS/JS extraction
(read/write tags, honest unresolved boundaries) · **cross-file import resolution** ·
**Python + Go extractors** (tree-sitter WASM) · deterministic sparse LSA+BM25 semantic
search · signal engine (minimal spine → provenance rank → budget → position-order →
whitespace-minimized verifiable render) · **incremental file watcher** · library + CLI +
MCP server. 171 tests, including byte-determinism and slice-quality gates.

**v0.2 surface:** a freshness guard (mtime/hash change detection, exposed as a
fingerprint) keeps reads honest about a stale index, file roles back `inventory`, the
new `verify` engine backs the pre-commit gate alongside `lookup`, `map`/domains scope
`understand`, docs get a staleness check (`docs --stale`), and tests are linked back to
the symbols they cover.

**Measured on real codebases:**
- Its own source: task slice **~85% smaller** than dumping the repo, all `[ast_exact]`,
  **~0.3% of a 1M window**.
- repomix (380 TS files, 9.9k symbols): full index in **~6s**, cold `understand` ~1.8s.
- grepai (198 Go files): `understand "vector store search"` returns the three `Search`
  backend impls + dedup — correct, by meaning, deterministic.

**Next:** richer cross-file/type-aware resolution (method calls), more languages,
daemon hardening (Win/WSL/SMB), eval corpus growth.

## Changelog

Terse and reverse-chronological; see `git log` for the full detail this compresses.

### 2026-07-04 — v0.2: anti-hallucination roadmap
- **Added:** freshness guard (mtime/hash reconciliation before every read) · file role
  classification + `inventory` (roles, inbound edges, orphans) · `verify` engine
  (unified-diff parser, graph-native unknown-symbol/signature-echo/blast-radius/
  parse-failure checks) behind a pre-commit gate · `lookup` (exact facts, explicit NOT
  FOUND) · domain detection (label propagation) + `map` (md/mermaid/json) +
  `understand --scope` · `docs --stale` · test linkage (`tests <symbol>`, covered-by
  lines) · corpus fingerprint in `status` · `lookup`/`verify` as MCP tools.
- **Fixed** (same-day follow-up pass): per-call-site edges (dedup keyed by line, not
  just symbol pair); `removeFile` downgrades inbound cross-file edges to `unresolved`
  instead of deleting them, and downgraded placeholders now re-resolve through
  aliased/default imports; domain/mermaid labels route correctly under name
  collisions; `.js`/`.mjs`/`.cjs` specifiers resolve to their TS source (NodeNext).

### 2026-07-03 — roadmap planning
- **Added:** the anti-hallucination roadmap spec, a spec amendment (freshness guard,
  lookup tool, stale-docs, test linkage), and a 20-task/5-phase implementation plan —
  docs only, no code.

### 2026-06-30 — v0.1: core engine
- **Added:** the whole v0.1 core in one day — provenance-centric node/edge types,
  SQLite graph store (FTS5 + WAL), git-first scanner, scope-aware TS/JS extractor,
  cross-file import resolution, deterministic LSA + BM25 + RRF semantic search, the
  minimal-spine signal engine with harmonic MAP/SIGNATURES/DETAIL output, library +
  CLI + single-tool MCP server, an incremental file watcher, type-aware method-call
  resolution, 19 tree-sitter grammars (Python/Go/Rust/Java/PHP/C#/Ruby/C/C++/Swift/
  Kotlin/Scala/Zig/Lua/Solidity/Objective-C/Bash/OCaml/ReScript), Elixir + Terraform
  bespoke extractors, Vue/Svelte/Astro SFC support, docs/manifest/MCP-config
  extractors, the agent MCP `install` command, and the determinism/slice-quality
  eval corpus.
- **Changed:** renamed the project veridex → rinnegan (package, bin, CLI, MCP, lib,
  index dir) and added the Rinnegan branding/hero banner.
