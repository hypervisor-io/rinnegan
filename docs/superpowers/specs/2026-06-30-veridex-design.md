# Rinnegan — Design Spec

**Status:** Approved (2026-06-30)
**Working name:** Rinnegan *(verifiable index)*

---

## 1. Thesis

Rinnegan is a verifiable code-knowledge engine. For any task it returns the
**minimal, maximal-signal, provenance-tagged** slice of a codebase — the smallest
set of facts an AI agent needs to write precise, hallucination-free code.

It is built on three findings from the research and from the failure modes of the
prior art (codegraph, repomix, grepai):

1. **Context rot is real even at 1M tokens.** "Lost in the middle" causes >30–40%
   accuracy loss for mid-context information (RoPE long-term decay + softmax
   concentrating attention on primacy/recency; Veseli 2025: once context is >50%
   full the model favors recent > middle > early). **More context is not better.**
   Dumping a whole repo (repomix-style) into a 1M window actively hurts.
2. **Tool count drives hallucination.** Agents with many similar tools make
   function-selection errors. → one primary tool, secondaries hidden by default.
3. **RAG hallucination = retrieval failure + generation noise.** Fix = retrieve
   minimal, rank hard, ground every fact in structural truth, and make
   un-grounded facts *visibly* un-grounded.

**Core principle: precision over recall.** Fuzzy semantic recall is hallucination
fuel, so semantic discovery is used only to *seed* retrieval — it never masquerades
as structural truth in the precision output.

**Hard constraint (from product owner):** the system must NOT require an external
embedding model or AI tokenization (the codegraph property — deterministic, offline,
no API), **and yet** must still offer semantic discovery. This is resolved by a
classical, fully-local **latent-semantic (LSA)** layer (§5), not neural embeddings.

---

## 2. What we must beat (issues found in the base tools)

| Tool | Concrete issue | Rinnegan response |
|---|---|---|
| codegraph | Same-named symbol resolves to wrong (first) def — #1079 | Scope/FQN-aware resolution (§4) |
| codegraph | No file-scoped dependency query — #500 | First-class `deps` query (§7) |
| codegraph | No read/write (lvalue/rvalue) distinction — #996 | `read_write` tag on every reference edge (§4, §6) |
| codegraph | MCP stdio framing mismatch (Content-Length vs newline) — #172 | Spec-correct MCP stdio framing (§7) |
| codegraph | `projectPath` required even when index exists — #196 | Optional projectPath when a single index is resolvable (§7) |
| codegraph | Over-calls explore; low-salience agent steering — #1080 | One high-value `understand` tool + sharp server instructions (§7) |
| codegraph | Daemon staleness on Windows/WSL/SMB — #723, #1014, #1057 | Robust daemon lifecycle + temp-dir socket fallback (§8) |
| repomix | Whole output built in memory (string-limit risk) | Streamed, budgeted emission (§6) |
| repomix | Compression covers only 16 languages; just packs, no ranking | AST graph + hard rerank, not a flat dump (§6) |
| grepai | Regex symbol extraction → false positives | Tree-sitter AST extraction (§4) |
| grepai | Naive keyword half of hybrid (no BM25/IDF) | Real BM25 + LSA fusion (§5) |
| grepai | O(n) linear vector scan in default store | LSA over compact latent matrix + indexed candidate gen (§5) |
| grepai | Model change ⇒ full re-index | Deterministic local LSA — no model to change (§5) |

---

## 3. Architecture overview

TypeScript, Node 22+ (built-in `node:sqlite`), tree-sitter WASM. Three surfaces
over one shared library core: **MCP server** (primary, for agents), **CLI** (humans
+ scripts), **library** (importable API).

```
Ingest → Parse(AST) → Graph store(provenance) → ┬→ Deterministic semantic (LSA+BM25)
                                                 └→ Signal engine → {MCP, CLI, library}
                              Watcher/daemon keeps the index live
```

Each layer is an independently testable unit with a narrow interface. No layer
reaches past its neighbor's interface.

---

## 4. Layer: Ingest + Parse (the truth layer)

**Ingest** (`src/ingest/`)
- Git-first file enumeration (`git ls-files`, tracked + untracked, gitignore-correct),
  fallback directory walk for non-git dirs.
- Ignore stack: defaults (node_modules, dist, vendor, lockfiles, …) + `.gitignore`
  + `.rinneganignore` + CLI/config patterns.
- Filters: >1 MB skip, binary detection, minified detection (`*.min.js`, `*.bundle.*`).
- Two-gate incremental: (1) mtime ≤ lastIndex AND already-indexed ⇒ skip; (2) read,
  SHA-256, compare stored hash ⇒ skip if unchanged.

**Parse** (`src/parse/`)
- Tree-sitter WASM in a worker pool; recycle workers every N files to reclaim WASM
  linear memory (codegraph lesson).
- Per-language extractors emit nodes, edges, and unresolved references.
- **Precision requirements (the differentiators):**
  - **Scope/FQN-aware resolution.** Same-named symbols in different files/scopes
    resolve by qualified name + lexical scope, not by DB insertion order.
    (Directly fixes codegraph #1079.)
  - **Read/write tagging.** Every `references` edge to a variable/property/field
    carries `read_write ∈ {read, write, readwrite, call, addr}`. (Fixes #996.)
  - **Honest unresolved nodes.** A reference that cannot be resolved becomes a
    first-class `unresolved` boundary node with the call-site location — never
    dropped, never guessed.

---

## 5. Layer: Graph store (the provenance core — the unique heart)

`src/graph/` over SQLite (own schema, WAL). This schema is what makes the codebase
unique: it is built around **verifiability**, not just connectivity.

**Node** fields: `id` (hash of filePath+qualifiedName), `kind`, `qualifiedName`,
`filePath`, `language`, `startLine`, `endLine`, `signature`, `docstring`,
`visibility`, flags (`isExported`/`isAsync`/`isStatic`/`isAbstract`),
`decorators`, `typeParameters`, `returnType`, `updatedAt`.

**Edge** fields: `source`, `target`, `kind`, `line`, `col`,
and the verifiability columns —
- `provenance ∈ {ast_exact, ast_inferred, lexical, latent, heuristic, unresolved}`
- `confidence ∈ [0,1]`
- `resolver` (name of the rule/pass that produced the edge)
- `read_write` (for reference edges)
- `metadata` (JSON; dynamic-dispatch markers, synthesis channel, etc.)

**Edge kinds:** `contains, calls, imports, exports, extends, implements,
references, type_of, returns, instantiates, overrides, decorates`.

**Provenance contract:**
- `ast_exact` = produced directly from the AST with unambiguous resolution → the
  only class treated as ground truth.
- `ast_inferred` = AST-derived but required an inference step (e.g. supertype BFS).
- `lexical` / `latent` = produced by the semantic layer (discovery only).
- `heuristic` = pattern-synthesized (observer/callback/dispatch tables).
- `unresolved` = boundary; the static path ends here.

FTS5 virtual table over enriched node docs (maintained by triggers) backs lexical
search and LSA document assembly.

---

## 6. Layer: Deterministic semantic (LSA + BM25, no neural net, no API)

`src/semantic/`. Delivers "find by meaning" with **zero model download, zero API,
full reproducibility** — the resolution of the §1 hard constraint.

- **Symbol document assembly.** For each symbol build a bag of terms from: split
  identifiers (camelCase/snake → tokens), signature, docstring, comments, and the
  names of graph neighbors (callers/callees/type). Programming-synonym + stemming
  expansion (small curated lexicon, e.g. auth↔authenticate↔login, rm↔delete↔remove).
- **TF-IDF term–symbol matrix**, then **truncated SVD → LSA latent space** (k≈100–300
  dims), computed locally and deterministically. Query → same TF-IDF transform →
  fold into latent space → cosine against symbol latent vectors.
- **BM25 lexical** over the same FTS5 docs (real IDF weighting — beats grepai's
  naive word-overlap).
- **Fusion:** Reciprocal Rank Fusion of {LSA, BM25, exact-symbol-name} lists.
- **Determinism:** SVD seeded/canonicalized so the same corpus yields byte-identical
  latent vectors → reproducible results, no "reindex on model change" (grepai's pain
  cannot occur — there is no model).

Semantic output is tagged `latent`/`lexical` provenance and used to **seed**
retrieval. It is never emitted as structural truth.

---

## 7. Layer: Signal engine (the noise remover) + query API

`src/signal/`. The product's reason to exist: turn a task into the minimal,
position-optimized, verifiable slice.

Pipeline for `understand(task)`:
1. **Seed** — fused semantic+lexical+symbol search → candidate anchor nodes.
2. **Spine extraction** — expand along the graph (calls/deps/types) to the
   **minimal connected subgraph** that links the anchors, bounded by depth + budget.
3. **Hard rerank** — score each node by
   `graphCentrality × queryRelevance × provenanceConfidence × changeRecency`.
   Cross-encoder-style narrowing of the candidate set to the few that matter.
4. **Skeletonize off-spine** — polymorphic siblings / incidental neighbors collapse
   to signatures only; on-spine exemplars stay full.
5. **Budget-aware emission** — sized to leave large 1M headroom (typical target
   <50k tokens). Streamed, never assembled whole-in-memory (fixes repomix).
6. **Position-aware ordering** — highest-signal facts placed at primacy/recency
   edges; compressed low-signal in the middle. Directly attacks lost-in-the-middle.
7. **Verifiable rendering** — every fact carries provenance tag + `file:line` +
   line-numbered verbatim source (Read-equivalent, so the agent cites and edits
   without a separate read). Dynamic-dispatch sites render an explicit
   "static path ends here" marker instead of a guessed edge.
8. **Whitespace minimization (literal-noise removal).** Because every emitted line
   carries an *explicit* line number, redundant whitespace can be deleted with zero
   information loss:
   - **Uniform dedent** — strip the common leading indentation of each emitted block
     (indentation is the largest whitespace-token sink; line numbers are preserved so
     `file:line` citations remain exact).
   - **Blank-line elision via line-number gaps** — omit pure-blank lines; a jump in the
     printed line numbers (e.g. `10 → 13`) unambiguously signals the gap.
   - **Trailing-whitespace trim.**
   This is the "signal not noise" principle applied to literal characters. It stacks on
   top of minimal-spine selection: repomix dumps whole files *with* whitespace; Rinnegan
   emits the minimal spine *without* redundant whitespace.

**Secondary queries** (library + CLI + hidden MCP tools): `search`, `node`,
`callers`, `callees`, `impact`, `deps` (file-scoped dependency query — fixes #500),
`refs` (with read/write filter — fixes #996).

---

## 8. Layer: MCP server, CLI, daemon, watcher

**MCP** (`src/mcp/`)
- Primary listed tool: **`understand(task)`** → the verifiable slice. One tool keeps
  the agent's tool-selection space tiny (anti-hallucination, anti-#1080).
- Secondary tools defined but unlisted by default (env-flag to enable).
- **Spec-correct stdio framing** (Content-Length, per MCP/LSP spec — fixes #172).
- **Optional `projectPath`** — resolved from cwd / single registered index (#196).
- Sharp `initialize` instructions: call `understand` first; treat output as
  Read-equivalent; only `ast_exact` is ground truth; do not re-grep.

**Daemon** (`src/daemon/`) — one shared process per project root over a Unix
socket / named pipe; lockfile arbitration; idle timeout; **temp-dir socket fallback**
for ExFAT/FAT/SMB/WSL (fixes the #723/#1014/#1057 cluster); PPID + liveness watchdogs.

**Watcher** (`src/watch/`) — debounced recursive watch; incremental two-gate sync;
worktree-aware PID/ready files (grepai); per-file staleness banners on query output
(codegraph); branch-switch ⇒ full reconcile.

**CLI** (`src/cli/`) — `init, index, sync, status, understand, search, deps,
callers, callees, impact, refs, explain`. Dual output: rich/ANSI for humans,
compact/structured for LLM piping (fixes codegraph's human-only output, #500 theme).

**Library** (`src/index.ts`) — `Rinnegan.init/open`, `indexAll`, `understand`,
`search`, `getDeps`, `getRefs`, `getCallers`, `getImpact`, `watch`. The shared core
that forces clean boundaries.

---

## 9. Anti-hallucination contract (acceptance criteria)

- No fact is emitted without a `provenance` tag.
- Only `ast_exact` edges appear unqualified in precision output; `ast_inferred`,
  `heuristic`, `latent`, `unresolved` are visibly labeled.
- Dynamic dispatch / reflection → explicit boundary marker, never a guessed edge.
- Every claim is citable to `file:line` with verbatim line-numbered source.
- Low-confidence edges are excluded from precision output, available in discovery.
- Semantic (latent/lexical) results never presented as structural truth.

---

## 10. Uniqueness (why this is not a fork)

- Provenance/confidence/read-write-centric SQLite schema (the base tools' schemas
  are connectivity-centric).
- Deterministic LSA semantic layer — novel: codegraph has no semantics, grepai uses
  neural embeddings.
- Signal + position-aware emission engine — novel.
- Single unified `understand` contract with a verifiability rendering format.
- Written fresh in TypeScript; patterns learned from the prior art, zero code copied.

---

## 11. Testing strategy

- **Golden-corpus eval harness** (codegraph-style `__tests__/evaluation/`):
  - Resolution precision/recall (esp. same-name disambiguation — the #1079 regression).
  - Provenance accuracy (is each edge's tag correct?).
  - Read/write tag accuracy.
  - "Slice contains the answer" — does `understand(task)` include the symbols a known
    fix touches?
  - Token-budget adherence (output stays under target).
  - **Byte-determinism** — same corpus ⇒ identical index + identical `understand`
    output across runs (guards the no-model promise).
- Unit tests per layer behind its interface; integration tests for the daemon/MCP
  round-trip.

---

## 12. Build phases (full system; sequenced by the implementation plan)

- **P1 — Truth layer:** ingest + AST parse + provenance graph store, languages
  TS/Python/Go. Scope-aware resolution, read/write tags, unresolved boundaries.
- **P2 — Semantic layer:** symbol-doc assembly, TF-IDF, deterministic LSA, BM25, RRF fusion.
- **P3 — Signal engine:** spine extraction, rerank, skeletonize, budgeted +
  position-aware verifiable emission.
- **P4 — Surfaces:** MCP server (`understand` + hidden tools), CLI, daemon, watcher.
- **P5 — Hardening:** eval harness, byte-determinism gate, more languages.

Each phase ships independently testable and is gated by its slice of §11.
