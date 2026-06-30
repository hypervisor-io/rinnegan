# Veridex

**Verifiable code-knowledge engine.** For any task, Veridex returns the *minimal,
maximal-signal, provenance-tagged* slice of a codebase — the smallest set of facts an
AI agent needs to write precise, hallucination-free code.

- **Deterministic.** No neural embeddings, no AI tokenization, no external API. Same
  corpus ⇒ byte-identical index and output.
- **Semantic discovery without a model.** Classical latent-semantic analysis (TF-IDF +
  truncated SVD) — find code by meaning, fully local and reproducible.
- **Provenance on every fact.** Each graph edge is tagged `ast_exact | ast_inferred |
  heuristic | lexical | latent | unresolved` with a confidence. Only `ast_exact` is
  ground truth; everything else is visibly labeled.
- **Beats lost-in-the-middle.** Output is budgeted and position-ordered (highest signal
  at the context edges) so a fraction of a 1M window is more than enough.

Surfaces: **library** (`Veridex`), **CLI** (`veridex understand <task>`), **MCP server**
(single `understand` tool).

See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for the build plan.

## Install & use

```bash
npm install        # better-sqlite3 ships a prebuilt binary (Node 20+)
npm run build
node bin/veridex.js index            # build the SQLite knowledge graph
node bin/veridex.js understand "how does X work"   # minimal provenance-tagged slice
node bin/veridex.js mcp              # MCP server (single 'understand' tool)
```

Other commands: `search`, `deps <file>`, `refs <symbol> [--write|--read]`,
`callers <symbol>`, `impact <symbol>`, `status`. Add `--json` for machine output.

## Status — Phase 1–4 complete (v0.1)

Working end-to-end: SQLite provenance graph · scope-aware TS/JS extraction
(read/write tags, honest unresolved boundaries) · deterministic LSA+BM25 semantic
search · signal engine (minimal spine → provenance rank → budget → position-order →
whitespace-minimized verifiable render) · library + CLI + MCP server. 37 tests
incl. byte-determinism and slice-quality gates.

Measured on its own source: a task slice is **~85% smaller** than dumping the repo,
every fact `[ast_exact]`-grounded, using **~0.3% of a 1M context window**.

**Phase 5 (next):** Python/Go extractors, cross-file import resolution, daemon +
file watcher (Win/WSL/SMB-robust), more languages.
