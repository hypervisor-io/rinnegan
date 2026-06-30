import { nodeId } from "../../core/types.js";
import type { GraphNode, GraphEdge, NodeKind } from "../../core/types.js";
import type { ParseResult } from "../extract.js";
import { getTsTree, type TsNode } from "../treesitter.js";

/**
 * Terraform / HCL extractor. HCL is configuration, not procedural code, so the
 * graph models the *infrastructure* relationships an agent actually asks about:
 * each `block` (resource / variable / module / data / output / locals / …) is a
 * label-named definition, and each traversal expression (`var.region`,
 * `aws_instance.web.id`, `module.vpc.out`) is a `references` edge to the block
 * it points at. In-file targets resolve ast_exact; everything else (builtins,
 * cross-file vars) is an honest unresolved boundary.
 *
 * The terraform grammar is ABI-compatible with our web-tree-sitter runtime and
 * is vendored under vendor/wasm/ (not in tree-sitter-wasms).
 */

const KIND_BY_TYPE: Record<string, NodeKind> = {
  variable: "variable",
  local: "variable",
  locals: "variable",
  output: "variable",
  module: "module",
  provider: "module",
  terraform: "module",
  resource: "struct",
  data: "struct",
};

// Traversal scopes that are language builtins, never in-file definitions.
const BUILTIN_SCOPES = new Set(["path", "terraform", "each", "count", "self"]);

function firstLine(t: string): string {
  return t.split("\n")[0].trim().slice(0, 200);
}

/** A block's type identifier and string labels, e.g. ("resource", ["aws_instance","web"]). */
function blockHead(n: TsNode): { type: string; labels: string[] } | null {
  let type: string | null = null;
  const labels: string[] = [];
  for (const c of n.namedChildren) {
    if (c.type === "block_start" || c.type === "body") break;
    if (c.type === "identifier" && type === null) type = c.text;
    else if (c.type === "string_lit") {
      const lit = c.namedChildren.find((g) => g.type === "template_literal");
      labels.push(lit ? lit.text : c.text.replace(/^"|"$/g, ""));
    }
  }
  return type ? { type, labels } : null;
}

function bodyOf(n: TsNode): TsNode | null {
  return n.namedChildren.find((c) => c.type === "body") ?? null;
}

export async function extractTerraform(path: string, source: string, language: string): Promise<ParseResult> {
  const root = await getTsTree(language, source);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let unresolved = 0;

  const fileId = nodeId(path, "<file>");
  nodes.push({
    id: fileId, kind: "file", qualifiedName: "<file>", filePath: path, language,
    startLine: 1, endLine: source.split("\n").length,
  });

  // alias key (as written in references, e.g. "var.region", "aws_instance.web",
  // "module.vpc", "data.aws_ami.ubuntu", "local.x") → def node id.
  const aliasMap = new Map<string, string>();

  function registerAlias(type: string, labels: string[], id: string, block: TsNode): void {
    if (type === "variable" && labels[0]) aliasMap.set(`var.${labels[0]}`, id);
    else if (type === "module" && labels[0]) aliasMap.set(`module.${labels[0]}`, id);
    else if (type === "output" && labels[0]) aliasMap.set(`output.${labels[0]}`, id);
    else if (type === "data" && labels[0] && labels[1]) aliasMap.set(`data.${labels[0]}.${labels[1]}`, id);
    else if (type === "resource" && labels[0] && labels[1]) aliasMap.set(`${labels[0]}.${labels[1]}`, id);
    else if (type === "locals") {
      // each attribute name becomes local.<name>, pointing at the locals block.
      const body = bodyOf(block);
      if (body) for (const a of body.namedChildren) {
        if (a.type === "attribute") {
          const id0 = a.namedChildren.find((c) => c.type === "identifier");
          if (id0) aliasMap.set(`local.${id0.text}`, id);
        }
      }
    }
  }

  // Pass A: blocks → definitions (nested blocks scoped under their parent FQN).
  function walkDefs(n: TsNode, stack: string[], owner: string, top: boolean): void {
    if (n.type === "block") {
      const head = blockHead(n);
      if (head) {
        const local = [head.type, ...head.labels].join(".");
        const fqn = [...stack, local].join(".");
        const id = nodeId(path, fqn);
        nodes.push({
          id, kind: KIND_BY_TYPE[head.type] ?? "struct", qualifiedName: fqn, filePath: path, language,
          startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1, signature: firstLine(n.text),
        });
        edges.push({
          source: owner, target: id, kind: "contains", line: n.startPosition.row + 1,
          col: n.startPosition.column + 1, provenance: "ast_exact", confidence: 1, resolver: "terraform",
        });
        if (top) registerAlias(head.type, head.labels, id, n);
        const body = bodyOf(n);
        if (body) for (const c of body.namedChildren) walkDefs(c, [...stack, local], id, false);
        return;
      }
    }
    for (const c of n.namedChildren) walkDefs(c, stack, owner, top);
  }
  const rootBody = bodyOf(root);
  if (rootBody) for (const c of rootBody.namedChildren) walkDefs(c, [], fileId, true);

  const unresolvedNodes = new Set<string>();
  function ensureUnresolved(name: string, line: number): string {
    const qn = `<unresolved>.${name}`;
    const id = nodeId(path, qn);
    if (!unresolvedNodes.has(id)) {
      unresolvedNodes.add(id);
      nodes.push({ id, kind: "unresolved", qualifiedName: qn, filePath: path, language, startLine: line, endLine: line });
    }
    return id;
  }

  const emitted = new Set<string>();
  function pushEdge(e: GraphEdge): void {
    const key = `${e.source}|${e.target}|${e.kind}|${e.line}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    edges.push(e);
  }

  // Resolve a traversal path against alias keys, longest prefix first.
  function resolve(path0: string[]): string | null {
    for (const len of [3, 2]) {
      if (path0.length >= len) {
        const hit = aliasMap.get(path0.slice(0, len).join("."));
        if (hit) return hit;
      }
    }
    return null;
  }

  // Pass B: traversal references. A `variable_expr` plus its trailing `get_attr`
  // siblings form one traversal (var.region, aws_instance.web.id, …).
  function walkRefs(n: TsNode, owner: string): void {
    const blockOwner = ownerForBlock(n) ?? owner;
    const kids = n.namedChildren;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].type === "variable_expr") {
        const idn = kids[i].namedChildren.find((c) => c.type === "identifier");
        if (idn) {
          const segs = [idn.text];
          let j = i + 1;
          while (j < kids.length && kids[j].type === "get_attr") {
            const g = kids[j].namedChildren.find((c) => c.type === "identifier");
            if (g) segs.push(g.text);
            j++;
          }
          emitRef(segs, kids[i], blockOwner);
        }
      }
    }
    for (const c of kids) walkRefs(c, blockOwner);
  }

  // Map a block node back to its def id (recomputing FQN is avoided by id lookup via line+name);
  // simpler: track owner through the recursion. We re-derive via a parallel walk below.
  const blockId = new Map<TsNode, string>();
  function indexBlocks(n: TsNode, stack: string[]): void {
    if (n.type === "block") {
      const head = blockHead(n);
      if (head) {
        const local = [head.type, ...head.labels].join(".");
        const fqn = [...stack, local].join(".");
        blockId.set(n, nodeId(path, fqn));
        const body = bodyOf(n);
        if (body) for (const c of body.namedChildren) indexBlocks(c, [...stack, local]);
        return;
      }
    }
    for (const c of n.namedChildren) indexBlocks(c, stack);
  }
  if (rootBody) for (const c of rootBody.namedChildren) indexBlocks(c, []);
  function ownerForBlock(n: TsNode): string | undefined {
    return blockId.get(n);
  }

  function emitRef(segs: string[], at: TsNode, owner: string): void {
    if (BUILTIN_SCOPES.has(segs[0]) || segs.length < 2) return;
    const line = at.startPosition.row + 1;
    const col = at.startPosition.column + 1;
    const target = resolve(segs);
    if (target) {
      pushEdge({ source: owner, target, kind: "references", line, col, provenance: "ast_exact", confidence: 1, resolver: "terraform", readWrite: "read" });
    } else {
      unresolved++;
      pushEdge({ source: owner, target: ensureUnresolved(segs.join("."), line), kind: "references", line, col, provenance: "unresolved", confidence: 0, resolver: "terraform", readWrite: "read", metadata: { boundary: "unresolved-ref" } });
    }
  }

  walkRefs(root, fileId);

  return { nodes, edges, unresolved, imports: [] };
}
