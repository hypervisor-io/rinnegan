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

## Purpose

Veridex is **internal machinery for AI coding agents**, not a user-facing graph tool.
Its sole job: hand any attention-limited / sparse-attention model the *exact signal* it
needs to make precise, no-nonsense edits to an existing codebase — and nothing else.

**Harmonic memory.** `understand` returns three zoom tiers in one budget so the model
gets the shape first and the exact lines last:
`MAP` (symbols by file) → `SIGNATURES` (the spine at a glance, definitions only) →
`DETAIL` (whitespace-minified, provenance-tagged source to edit). Deterministic — no LLM
summarization (that is cognee's bloat; we reject it and keep only the multi-resolution idea).

**Any agent.** `veridex install <agent>` emits MCP config for Claude Code, Cursor, Codex,
Kiro, Pi, Windsurf, Gemini. MCP stdio is the universal transport.

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

## Status — Phase 1–7 (v0.1), 80 tests

## Status — earlier note, Phase 1–5

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
