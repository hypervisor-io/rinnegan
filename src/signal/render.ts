import { GraphStore } from "../graph/store.js";
import type { GraphNode, Provenance } from "../core/types.js";
import type { Ranked } from "./rank.js";

/**
 * Whitespace minimization (literal-noise removal). Because every emitted line
 * carries an explicit line number, redundant whitespace is deleted with zero
 * information loss:
 *  - uniform dedent (strip common leading indentation)
 *  - elide pure-blank lines (a jump in line numbers signals the gap)
 *  - trim trailing whitespace
 */
export function minifyBlock(srcLines: string[], startLine: number): string {
  const nonblank = srcLines.filter((l) => l.trim().length > 0);
  if (nonblank.length === 0) return "";
  const indent = Math.min(...nonblank.map((l) => /^[ \t]*/.exec(l)![0].length));
  const out: string[] = [];
  srcLines.forEach((l, i) => {
    if (l.trim().length === 0) return; // elided; line-number gap encodes it
    const ded = l.slice(indent).replace(/\s+$/, "");
    out.push(`${String(startLine + i).padStart(5)}  ${ded}`);
  });
  return out.join("\n");
}

/** The strongest provenance among a node's edges → why we trust it. */
function nodeProvenance(store: GraphStore, node: GraphNode): Provenance {
  if (node.kind === "unresolved") return "unresolved";
  let best: Provenance = "ast_inferred";
  const order: Provenance[] = ["unresolved", "latent", "lexical", "heuristic", "ast_inferred", "ast_exact"];
  let bestRank = 0;
  for (const e of [...store.incoming(node.id), ...store.outgoing(node.id)]) {
    const r = order.indexOf(e.provenance);
    if (r > bestRank) {
      bestRank = r;
      best = e.provenance;
    }
  }
  return best;
}

export interface RenderedFact {
  id: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  provenance: Provenance;
  score: number;
  body: string;
}

export function renderFact(
  store: GraphStore,
  r: Ranked,
  fileSource: string | undefined,
  opts: { skeleton: boolean },
): RenderedFact {
  const n = r.node;
  const prov = nodeProvenance(store, n);
  let body: string;

  if (n.kind === "unresolved") {
    body = `      (unresolved — static path ends here)`;
  } else if (opts.skeleton || !fileSource) {
    body = `${String(n.startLine).padStart(5)}  ${(n.signature ?? n.qualifiedName).trim()}`;
  } else {
    const lines = fileSource.split("\n").slice(n.startLine - 1, n.endLine);
    body = minifyBlock(lines, n.startLine);
  }

  // dynamic-dispatch boundary note
  const dyn = store.outgoing(n.id, ["calls"]).filter((e) => e.metadata?.boundary === "dynamic-dispatch");
  if (dyn.length > 0) body += `\n      ⤷ ${dyn.length} dynamic call site(s): static path ends here`;

  const header = `// ${n.filePath}:${n.startLine}-${n.endLine}  ${n.qualifiedName}  [${prov}]  signal=${r.score.toFixed(2)}`;
  return {
    id: n.id,
    qualifiedName: n.qualifiedName,
    filePath: n.filePath,
    startLine: n.startLine,
    endLine: n.endLine,
    provenance: prov,
    score: r.score,
    body: `${header}\n${body}`,
  };
}
