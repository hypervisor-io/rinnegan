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

## Status — Phase 1–5 (v0.1), 43 tests

Working end-to-end: SQLite provenance graph · scope-aware TS/JS extraction
(read/write tags, honest unresolved boundaries) · **cross-file import resolution** ·
**Python + Go extractors** (tree-sitter WASM) · deterministic sparse LSA+BM25 semantic
search · signal engine (minimal spine → provenance rank → budget → position-order →
whitespace-minimized verifiable render) · **incremental file watcher** · library + CLI +
MCP server. Tests include byte-determinism and slice-quality gates.

**Measured on real codebases:**
- Its own source: task slice **~85% smaller** than dumping the repo, all `[ast_exact]`,
  **~0.3% of a 1M window**.
- repomix (380 TS files, 9.9k symbols): full index in **~6s**, cold `understand` ~1.8s.
- grepai (198 Go files): `understand "vector store search"` returns the three `Search`
  backend impls + dedup — correct, by meaning, deterministic.

**Next:** richer cross-file/type-aware resolution (method calls), more languages,
daemon hardening (Win/WSL/SMB), eval corpus growth.
