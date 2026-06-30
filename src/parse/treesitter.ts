import Parser from "web-tree-sitter";
import { createRequire } from "node:module";
import { nodeId } from "../core/types.js";
import type { GraphNode, GraphEdge, NodeKind } from "../core/types.js";
import type { ParseResult } from "./extract.js";

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | null = null;
const langCache = new Map<string, unknown>();

const WASM: Record<string, string> = {
  python: "tree-sitter-python",
  go: "tree-sitter-go",
};

async function getParser(language: string): Promise<Parser> {
  if (!initPromise) initPromise = (Parser as unknown as { init: () => Promise<void> }).init();
  await initPromise;
  if (!langCache.has(language)) {
    const wasm = require.resolve(`tree-sitter-wasms/out/${WASM[language]}.wasm`);
    const Lang = await (Parser as unknown as { Language: { load: (p: string) => Promise<unknown> } }).Language.load(wasm);
    langCache.set(language, Lang);
  }
  const p = new (Parser as unknown as new () => Parser)();
  (p as unknown as { setLanguage: (l: unknown) => void }).setLanguage(langCache.get(language));
  return p;
}

// Minimal structural typing over web-tree-sitter nodes (avoids depending on its types).
interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildren: TsNode[];
  childForFieldName(field: string): TsNode | null;
}

export interface LangConfig {
  /** Map a node to a definition {kind, name} or null. */
  def(n: TsNode): { kind: NodeKind; name: string } | null;
  callType: string;
  callFnField: string;
  identType: string;
  /** node types that represent a member/qualified call (a.b()) → dynamic boundary */
  selectorTypes: string[];
}

function firstLine(text: string): string {
  return text.split("\n")[0].trim().slice(0, 200);
}

/** Generic tree-sitter extractor: definitions + in-file call resolution + honest boundaries. */
export async function extractTreeSitter(
  path: string,
  source: string,
  language: string,
  cfg: LangConfig,
): Promise<ParseResult> {
  const parser = await getParser(language);
  const tree = parser.parse(source) as unknown as { rootNode: TsNode };
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let unresolved = 0;

  const fileId = nodeId(path, "<file>");
  nodes.push({
    id: fileId, kind: "file", qualifiedName: "<file>", filePath: path, language,
    startLine: 1, endLine: source.split("\n").length,
  });

  const defByName = new Map<string, string>();
  const defNodeId = new Map<TsNode, string>();

  // Pass A: collect definitions + containment
  function walkDefs(n: TsNode, nameStack: string[], ownerId: string): void {
    let owner = ownerId;
    let stack = nameStack;
    const d = cfg.def(n);
    if (d) {
      const fqn = [...nameStack, d.name].join(".");
      const id = nodeId(path, fqn);
      nodes.push({
        id, kind: d.kind, qualifiedName: fqn, filePath: path, language,
        startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1,
        signature: firstLine(n.text),
      });
      edges.push({
        source: ownerId, target: id, kind: "contains", line: n.startPosition.row + 1,
        col: n.startPosition.column + 1, provenance: "ast_exact", confidence: 1, resolver: language,
      });
      if (!defByName.has(d.name)) defByName.set(d.name, id);
      defNodeId.set(n, id);
      stack = [...nameStack, d.name];
      owner = id;
    }
    for (const c of n.namedChildren) walkDefs(c, stack, owner);
  }
  walkDefs(tree.rootNode, [], fileId);

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
    const key = `${e.source}|${e.target}|${e.kind}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    edges.push(e);
  }

  // Pass B: calls
  function walkCalls(n: TsNode, ownerId: string): void {
    const owner = defNodeId.get(n) ?? ownerId;
    if (n.type === cfg.callType) {
      const fn = n.childForFieldName(cfg.callFnField);
      const line = n.startPosition.row + 1;
      const col = n.startPosition.column + 1;
      if (fn && fn.type === cfg.identType) {
        const target = defByName.get(fn.text);
        if (target) {
          pushEdge({ source: owner, target, kind: "calls", line, col, provenance: "ast_exact", confidence: 1, resolver: language, readWrite: "call" });
        } else {
          unresolved++;
          pushEdge({ source: owner, target: ensureUnresolved(fn.text, line), kind: "calls", line, col, provenance: "unresolved", confidence: 0, resolver: language, readWrite: "call", metadata: { boundary: "unresolved-callee" } });
        }
      } else if (fn && cfg.selectorTypes.includes(fn.type)) {
        const name = fn.namedChildren[fn.namedChildren.length - 1]?.text ?? fn.text;
        unresolved++;
        pushEdge({ source: owner, target: ensureUnresolved(name, line), kind: "calls", line, col, provenance: "unresolved", confidence: 0, resolver: language, readWrite: "call", metadata: { boundary: "dynamic-dispatch" } });
      }
    }
    for (const c of n.namedChildren) walkCalls(c, owner);
  }
  walkCalls(tree.rootNode, fileId);

  return { nodes, edges, unresolved, imports: [] };
}

export const PYTHON_CONFIG: LangConfig = {
  def(n) {
    if (n.type === "function_definition") {
      const name = n.childForFieldName("name");
      return name ? { kind: "function", name: name.text } : null;
    }
    if (n.type === "class_definition") {
      const name = n.childForFieldName("name");
      return name ? { kind: "class", name: name.text } : null;
    }
    return null;
  },
  callType: "call",
  callFnField: "function",
  identType: "identifier",
  selectorTypes: ["attribute"],
};

export const GO_CONFIG: LangConfig = {
  def(n) {
    if (n.type === "function_declaration") {
      const name = n.childForFieldName("name");
      return name ? { kind: "function", name: name.text } : null;
    }
    if (n.type === "method_declaration") {
      const name = n.childForFieldName("name");
      return name ? { kind: "method", name: name.text } : null;
    }
    if (n.type === "type_spec") {
      const name = n.childForFieldName("name");
      return name ? { kind: "struct", name: name.text } : null;
    }
    return null;
  },
  callType: "call_expression",
  callFnField: "function",
  identType: "identifier",
  selectorTypes: ["selector_expression"],
};
