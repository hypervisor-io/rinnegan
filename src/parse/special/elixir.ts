import { nodeId } from "../../core/types.js";
import type { GraphNode, GraphEdge } from "../../core/types.js";
import type { ParseResult } from "../extract.js";
import { getTsTree, type TsNode } from "../treesitter.js";

/**
 * Elixir special extractor. In Elixir there is no `def` *node*: `defmodule`,
 * `def`, `defp`, … are macros, so the grammar parses every one as a `call`
 * whose head identifier is the macro name. This walker recognises those macro
 * calls as definitions and every other `call` with a bare-identifier head as a
 * function invocation, preserving the provenance contract (ast_exact when the
 * callee is defined in-file, unresolved boundary otherwise).
 */

const DEF_MACROS = new Set(["def", "defp", "defmacro", "defmacrop"]);
const MODULE_MACROS = new Set(["defmodule", "defprotocol", "defimpl"]);

function firstLine(t: string): string {
  return t.split("\n")[0].trim().slice(0, 200);
}

/** The head identifier of a `call` node (the macro/function being invoked). */
function callHead(n: TsNode): TsNode | null {
  if (n.type !== "call") return null;
  const first = n.namedChildren[0];
  return first && first.type === "identifier" ? first : null;
}

function argsNode(n: TsNode): TsNode | null {
  return n.namedChildren.find((c) => c.type === "arguments") ?? null;
}

/** arguments[0] is the signature `call` (head = fn name) or a bare identifier (zero-arg). */
function defName(n: TsNode): string | null {
  const a0 = argsNode(n)?.namedChildren[0];
  if (!a0) return null;
  if (a0.type === "call") {
    const h = a0.namedChildren[0];
    return h && h.type === "identifier" ? h.text : null;
  }
  if (a0.type === "identifier") return a0.text;
  return null;
}

/** The signature call node of a def-macro, which must be skipped during call resolution. */
function signatureNode(n: TsNode): TsNode | null {
  const a0 = argsNode(n)?.namedChildren[0];
  return a0 && a0.type === "call" ? a0 : null;
}

function moduleName(n: TsNode): string | null {
  const a0 = argsNode(n)?.namedChildren[0];
  return a0 && a0.type === "alias" ? a0.text : null;
}

export async function extractElixir(path: string, source: string, language: string): Promise<ParseResult> {
  const root = await getTsTree(language, source);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let unresolved = 0;

  const fileId = nodeId(path, "<file>");
  nodes.push({
    id: fileId, kind: "file", qualifiedName: "<file>", filePath: path, language,
    startLine: 1, endLine: source.split("\n").length,
  });

  const defByName = new Map<string, string>();
  const ownerOf = new Map<TsNode, string>(); // def/module call node → its node id
  const signatures = new Set<TsNode>(); // def header calls — never invocations

  // Pass A: definitions + containment.
  function walkDefs(n: TsNode, stack: string[], owner: string): void {
    const head = callHead(n);
    let nextStack = stack;
    let nextOwner = owner;
    if (head && (MODULE_MACROS.has(head.text) || DEF_MACROS.has(head.text))) {
      const isModule = MODULE_MACROS.has(head.text);
      if (!isModule) {
        const sig = signatureNode(n);
        if (sig) signatures.add(sig);
      }
      const name = isModule ? moduleName(n) : defName(n);
      if (name) {
        const fqn = [...stack, name].join(".");
        const id = nodeId(path, fqn);
        nodes.push({
          id, kind: isModule ? "module" : "function", qualifiedName: fqn, filePath: path, language,
          startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1, signature: firstLine(n.text),
        });
        edges.push({
          source: owner, target: id, kind: "contains", line: n.startPosition.row + 1,
          col: n.startPosition.column + 1, provenance: "ast_exact", confidence: 1, resolver: "elixir",
        });
        if (!isModule && !defByName.has(name)) defByName.set(name, id);
        ownerOf.set(n, id);
        nextStack = [...stack, name];
        nextOwner = id;
      }
    }
    for (const c of n.namedChildren) walkDefs(c, nextStack, nextOwner);
  }
  walkDefs(root, [], fileId);

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
    // line in the key so each call site gets an edge, matching typescript.ts (F1).
    const key = `${e.source}|${e.target}|${e.kind}|${e.line}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    edges.push(e);
  }

  // Pass B: calls. Skip each def-macro's signature call so `add(a, b)` in the
  // header is not mistaken for an invocation of `add`.
  function walkCalls(n: TsNode, owner: string): void {
    if (signatures.has(n)) return; // def header — not an invocation, prune the subtree
    const nextOwner = ownerOf.get(n) ?? owner;
    const head = callHead(n);
    if (head && !DEF_MACROS.has(head.text) && !MODULE_MACROS.has(head.text)) {
      const line = n.startPosition.row + 1;
      const col = n.startPosition.column + 1;
      const target = defByName.get(head.text);
      if (target) {
        pushEdge({ source: owner, target, kind: "calls", line, col, provenance: "ast_exact", confidence: 1, resolver: "elixir", readWrite: "call" });
      } else {
        unresolved++;
        pushEdge({ source: owner, target: ensureUnresolved(head.text, line), kind: "calls", line, col, provenance: "unresolved", confidence: 0, resolver: "elixir", readWrite: "call", metadata: { boundary: "unresolved-callee" } });
      }
    }
    for (const c of n.namedChildren) walkCalls(c, nextOwner);
  }
  walkCalls(root, fileId);

  return { nodes, edges, unresolved, imports: [] };
}
