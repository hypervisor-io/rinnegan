import { GraphStore } from "../graph/store.js";

/**
 * Expand from anchor symbols to the minimal connected subgraph that links them —
 * the call/reference/containment spine. Bounded by depth and node count so the
 * slice stays small (signal, not the whole repo).
 */
export function extractSpine(
  store: GraphStore,
  anchors: string[],
  opts: { depth: number; maxNodes: number },
): Set<string> {
  const included = new Set<string>(anchors);
  let frontier = [...anchors];

  for (let d = 0; d < opts.depth && included.size < opts.maxNodes; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      // forward: what this symbol calls / references / contains
      for (const e of store.outgoing(id, ["calls", "references", "contains"])) {
        if (!included.has(e.target)) {
          included.add(e.target);
          next.push(e.target);
        }
      }
      // backward: callers and the enclosing container (context)
      for (const e of store.incoming(id, ["calls", "contains"])) {
        if (!included.has(e.source)) {
          included.add(e.source);
          next.push(e.source);
        }
      }
      if (included.size >= opts.maxNodes) break;
    }
    frontier = next;
  }
  return included;
}
