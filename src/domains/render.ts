import type { Domain, DomainEdge } from "./domains.js";

export interface MapResult {
  domains: (Domain & { topSymbols: { name: string; file: string; line: number }[] })[];
  edges: DomainEdge[];
}

/** `map`'s markdown rendering: one section per domain (entrypoints + top symbols), then a dependencies section. */
export function renderMapMarkdown(m: MapResult): string {
  const lines: string[] = [];
  for (const d of m.domains) {
    lines.push(`## ${d.name}`);
    if (d.entrypoints.length > 0) lines.push(`entrypoints: ${d.entrypoints.join(", ")}`);
    lines.push("top symbols:");
    for (const s of d.topSymbols) lines.push(`- ${s.name} — ${s.file}:${s.line}`);
    lines.push("");
  }
  lines.push("## dependencies");
  // Names can collide across distinct labels (see domains.ts computeDomains). The
  // dependencies section stays human-facing (names, not labels) but disambiguates
  // a colliding name with a "(2)", "(3)", ... suffix — by the domain's position
  // among same-named domains, same order the mermaid renderer assigns node ids in —
  // so the two renderings agree. Non-colliding names are left untouched.
  const countByName = new Map<string, number>();
  for (const d of m.domains) countByName.set(d.name, (countByName.get(d.name) ?? 0) + 1);
  const displayByLabel = new Map<string, string>();
  const seenByName = new Map<string, number>();
  for (const d of m.domains) {
    const seen = seenByName.get(d.name) ?? 0;
    seenByName.set(d.name, seen + 1);
    const collides = (countByName.get(d.name) ?? 0) > 1;
    displayByLabel.set(d.label, collides && seen > 0 ? `${d.name} (${seen + 1})` : d.name);
  }
  for (const e of m.edges) {
    const from = displayByLabel.get(e.fromLabel) ?? e.from;
    const to = displayByLabel.get(e.toLabel) ?? e.to;
    lines.push(`${from} → ${to} (${e.weight})`);
  }
  return lines.join("\n");
}

/**
 * `map`'s mermaid rendering: `flowchart LR` with one node per domain and one edge per
 * DomainEdge. Node ids are the sanitized [A-Za-z0-9_] name suffixed with the domain's
 * index, which trivially guarantees uniqueness even when two domains render to the
 * same display name (a real label-collision case — see domains.ts); the display
 * label is kept verbatim via `id["name"]` so the collision stays visible. Edges are
 * routed by the internal LABEL (fromLabel/toLabel), not the display name — two
 * distinct domains can share a name, and keying by name would route both endpoints
 * to whichever same-named domain happened to be seen first.
 */
export function renderMapMermaid(m: MapResult): string {
  const lines = ["flowchart LR"];
  const idByLabel = new Map<string, string>();
  m.domains.forEach((d, i) => {
    const id = `${d.name.replace(/[^A-Za-z0-9_]/g, "_")}_${i}`;
    idByLabel.set(d.label, id);
    lines.push(`  ${id}["${d.name}"]`);
  });
  for (const e of m.edges) {
    const from = idByLabel.get(e.fromLabel);
    const to = idByLabel.get(e.toLabel);
    if (!from || !to) continue; // defensive: an edge naming a label absent from m.domains
    lines.push(`  ${from} -->|${e.weight}| ${to}`);
  }
  return lines.join("\n");
}
