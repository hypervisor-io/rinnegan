import { GraphStore } from "../graph/store.js";
import { PROVENANCE_TRUST, type GraphNode, type NodeKind } from "../core/types.js";

/**
 * Definition-level symbols carry the signal; locals/params are mostly noise.
 * This weight pushes functions/classes up and incidental bindings down.
 */
const KIND_WEIGHT: Record<NodeKind, number> = {
  function: 1, method: 1, class: 1, interface: 0.95, struct: 0.95,
  type_alias: 0.8, enum: 0.8, enum_member: 0.4, module: 0.7,
  constant: 0.5, property: 0.55, field: 0.55,
  variable: 0.3, export: 0.4, import: 0.1, unresolved: 0.25, file: 0,
};

export interface Ranked {
  node: GraphNode;
  score: number;
  relevance: number;
  centrality: number;
  trust: number;
}

/**
 * Signal score = relevance × centrality × provenance-trust. Ranks the spine so the
 * few symbols that actually matter to the task float to the top. Deterministic.
 */
export function rankNodes(
  store: GraphStore,
  ids: Set<string>,
  relevance: Map<string, number>,
): Ranked[] {
  const out: Ranked[] = [];
  for (const id of ids) {
    const node = store.getNode(id);
    if (!node) continue;
    if (node.kind === "file" || node.kind === "import") continue;

    const rel = relevance.get(id) ?? 0;
    const centrality = store.incoming(id, ["calls"]).length;

    let trust = 0.4;
    for (const e of [...store.incoming(id), ...store.outgoing(id)]) {
      trust = Math.max(trust, PROVENANCE_TRUST[e.provenance]);
    }
    if (node.kind === "unresolved") trust = 0;

    const kindW = KIND_WEIGHT[node.kind] ?? 0.5;
    const score = (1 + rel * 3) * (1 + Math.log(1 + centrality)) * (0.4 + 0.6 * trust) * kindW;
    out.push({ node, score, relevance: rel, centrality, trust });
  }
  return out.sort(
    (a, b) => b.score - a.score || (a.node.id < b.node.id ? -1 : 1),
  );
}
