import type { GraphStore } from "../graph/store.js";

export interface Domain { name: string; files: string[]; entrypoints: string[] } // files sorted
export interface DomainEdge { from: string; to: string; weight: number } // between domain names

function bump(m: Map<string, Map<string, number>>, a: string, b: string, inc = 1): void {
  let row = m.get(a);
  if (!row) { row = new Map(); m.set(a, row); }
  row.set(b, (row.get(b) ?? 0) + inc);
}

function firstSeg(file: string): string {
  const i = file.indexOf("/");
  return i === -1 ? "." : file.slice(0, i);
}

/** Seed label: first path segment, or (the src/ rule) segment 2 within a dominant top-level source dir. */
function seedLabel(file: string, dominant: string | null): string {
  const i = file.indexOf("/");
  if (i === -1) return ".";
  const first = file.slice(0, i);
  if (dominant !== null && first === dominant) {
    const rest = file.slice(i + 1);
    const j = rest.indexOf("/");
    return j === -1 ? rest : rest.slice(0, j);
  }
  return first;
}

function dirSegs(file: string): string[] {
  const i = file.lastIndexOf("/");
  return i === -1 ? [] : file.slice(0, i).split("/");
}

/** Longest common directory-segment prefix across files; "" if none (caller falls back to the label). */
function commonDirPrefix(files: string[]): string {
  let prefix = dirSegs(files[0]);
  for (const f of files.slice(1)) {
    const segs = dirSegs(f);
    let i = 0;
    while (i < prefix.length && i < segs.length && prefix[i] === segs[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix.join("/");
}

/**
 * Deterministic domain detection via label propagation over the cross-file
 * reference graph — groups files into cohesive domains from the graph the
 * indexer already built, with no config. Five spec-fixed rules (task-14-brief.md):
 * file graph, seed labels, propagate, group into named domains, cross-domain edges.
 */
export function computeDomains(store: GraphStore): { domains: Domain[]; edges: DomainEdge[] } {
  const roles = store.roleByFile();
  const files = [...roles.keys()].filter((f) => !f.startsWith("<")).sort();

  // Rule 1: file graph. Directed counts kept for DomainEdge; symmetrized weights for propagation.
  const fileOf = new Map(store.allNodes().map((n) => [n.id, n.filePath]));
  const directed = new Map<string, Map<string, number>>();
  const undirected = new Map<string, Map<string, number>>();
  for (const e of store.allEdges()) {
    const sf = fileOf.get(e.source), tf = fileOf.get(e.target);
    if (!sf || !tf || sf === tf || sf.startsWith("<") || tf.startsWith("<")) continue;
    bump(directed, sf, tf);
    bump(undirected, sf, tf);
    bump(undirected, tf, sf);
  }

  // Rule 2: seed labels — the src/ rule reseeds by segment 2 when one first segment
  // dominates (>60%) the code files (i.e. files that aren't config/doc).
  const codeFiles = files.filter((f) => roles.get(f) !== "config" && roles.get(f) !== "doc");
  const segCounts = new Map<string, number>();
  for (const f of codeFiles) { const s = firstSeg(f); segCounts.set(s, (segCounts.get(s) ?? 0) + 1); }
  let dominant: string | null = null;
  for (const [seg, count] of segCounts) if (count / codeFiles.length > 0.6) dominant = seg;

  const labels = new Map(files.map((f) => [f, seedLabel(f, dominant)]));

  // Rule 3: propagation, max 10 rounds, sorted path order, ties => lexicographically smallest label.
  for (let round = 0; round < 10; round++) {
    let changed = false;
    for (const f of files) {
      const neighbors = undirected.get(f);
      if (!neighbors || neighbors.size === 0) continue; // no neighbors: keep seed
      const weightByLabel = new Map<string, number>();
      for (const [nf, w] of neighbors) {
        const l = labels.get(nf)!;
        weightByLabel.set(l, (weightByLabel.get(l) ?? 0) + w);
      }
      let best: string | null = null;
      let bestWeight = -Infinity;
      for (const [l, w] of [...weightByLabel].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (w > bestWeight) { bestWeight = w; best = l; }
      }
      if (best !== null && best !== labels.get(f)) { labels.set(f, best); changed = true; }
    }
    if (!changed) break;
  }

  // Rule 4: domains = group by final label, sorted by name; name = longest common dir prefix (fallback: label).
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const l = labels.get(f)!;
    (groups.get(l) ?? groups.set(l, []).get(l)!).push(f);
  }
  const nameOfLabel = new Map<string, string>();
  const domains: Domain[] = [];
  for (const [label, members] of groups) {
    const name = commonDirPrefix(members) || label;
    nameOfLabel.set(label, name);
    domains.push({ name, files: members, entrypoints: members.filter((m) => roles.get(m) === "entrypoint") });
  }
  domains.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Rule 5: edges = directed file-graph weights aggregated between distinct final domains, sorted by (from, to).
  const domainEdges = new Map<string, Map<string, number>>();
  for (const [a, row] of directed) {
    const da = nameOfLabel.get(labels.get(a)!)!;
    for (const [b, w] of row) {
      const db = nameOfLabel.get(labels.get(b)!)!;
      if (da !== db) bump(domainEdges, da, db, w);
    }
  }
  const edges: DomainEdge[] = [];
  for (const [from, row] of domainEdges) for (const [to, weight] of row) edges.push({ from, to, weight });
  edges.sort((a, b) => (a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));

  return { domains, edges };
}
