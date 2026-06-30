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

## Status

Phase 1–4 core under active construction. TypeScript extraction first; Python/Go and the
daemon/watcher are Phase 5.
