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
  for (const e of m.edges) lines.push(`${e.from} → ${e.to} (${e.weight})`);
  return lines.join("\n");
}

/**
 * `map`'s mermaid rendering: `flowchart LR` with one node per domain and one edge per
 * DomainEdge. Node ids are the sanitized [A-Za-z0-9_] name suffixed with the domain's
 * index, which trivially guarantees uniqueness even when two domains render to the
 * same display name (a real label-collision case — see domains.ts); the display
 * label is kept verbatim via `id["name"]` so the collision stays visible.
 */
export function renderMapMermaid(m: MapResult): string {
  const lines = ["flowchart LR"];
  const idByName = new Map<string, string>(); // first domain with a given name wins edge endpoints
  m.domains.forEach((d, i) => {
    const id = `${d.name.replace(/[^A-Za-z0-9_]/g, "_")}_${i}`;
    if (!idByName.has(d.name)) idByName.set(d.name, id);
    lines.push(`  ${id}["${d.name}"]`);
  });
  for (const e of m.edges) {
    const from = idByName.get(e.from);
    const to = idByName.get(e.to);
    if (!from || !to) continue; // defensive: an edge naming a domain absent from m.domains
    lines.push(`  ${from} -->|${e.weight}| ${to}`);
  }
  return lines.join("\n");
}
