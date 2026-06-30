/** Injected into every MCP session via the initialize response. Single source of agent guidance. */
export const SERVER_INSTRUCTIONS = `Rinnegan returns the minimal, provenance-tagged signal slice of this codebase.

HOW TO USE
- Call \`understand\` FIRST with the task you are about to do (a sentence is fine).
  It returns the few symbols that matter, with verbatim line-numbered source.
- The output is Read-equivalent: cite file:line and edit directly. Do NOT re-grep
  or re-read files it already shows you.

TRUST CONTRACT (this is how you avoid hallucinating)
- Each fact is tagged: [ast_exact] = ground truth, verified from the AST.
  [ast_inferred]/[heuristic]/[latent] = labeled, treat as a lead and verify.
  [unresolved] = the static path ends here; do not invent the missing edge.
- A "dynamic call site(s): static path ends here" note means the call target is not
  statically knowable. Do not guess it.

NOTES
- Whitespace is minimized and blank lines are elided; a jump in line numbers means
  a blank line was removed — line numbers remain exact for citation.
- Secondary tools (search, deps, refs, callers, impact, node) exist but are hidden by
  default to keep tool choice simple. Set RINNEGAN_MCP_TOOLS=all to expose them.`;
