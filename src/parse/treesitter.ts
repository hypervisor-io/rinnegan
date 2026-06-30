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
  rust: "tree-sitter-rust",
  java: "tree-sitter-java",
  php: "tree-sitter-php",
  c_sharp: "tree-sitter-c_sharp",
  ruby: "tree-sitter-ruby",
  c: "tree-sitter-c",
  cpp: "tree-sitter-cpp",
  swift: "tree-sitter-swift",
  kotlin: "tree-sitter-kotlin",
  scala: "tree-sitter-scala",
  zig: "tree-sitter-zig",
  lua: "tree-sitter-lua",
  solidity: "tree-sitter-solidity",
  objc: "tree-sitter-objc",
  bash: "tree-sitter-bash",
  ocaml: "tree-sitter-ocaml",
  rescript: "tree-sitter-rescript",
  elixir: "tree-sitter-elixir",
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
export interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildren: TsNode[];
  childForFieldName(field: string): TsNode | null;
}

/** Parse a source string and return the root node, for bespoke extractors. */
export async function getTsTree(language: string, source: string): Promise<TsNode> {
  const parser = await getParser(language);
  return (parser.parse(source) as unknown as { rootNode: TsNode }).rootNode;
}

type NameStrategy = "field" | "firstIdent" | "declarator";
interface DefRule {
  type: string;
  kind: NodeKind;
  nameField?: string; // default "name"
  nameStrategy?: NameStrategy; // default "field"
}
interface CallRule {
  type: string;
  fnField?: string;
}
export interface LangConfig {
  defs: DefRule[];
  calls: CallRule[];
  identType: string;
  /** node types that represent a member/qualified call (a.b()) → dynamic boundary */
  selectorTypes: string[];
}

const NAMEISH = /^(identifier|simple_identifier|type_identifier|name|word|value_name|value_identifier)$/;

/** Descend declarators (c/c++) to the first identifier/field_identifier. */
function descendName(n: TsNode): TsNode | null {
  const stack = [...n.namedChildren];
  while (stack.length) {
    const c = stack.shift()!;
    if (c.type === "identifier" || c.type === "field_identifier") return c;
    if (/declarator/.test(c.type)) stack.push(...c.namedChildren);
  }
  return null;
}

function defOf(cfg: LangConfig, n: TsNode): { kind: NodeKind; name: string } | null {
  for (const r of cfg.defs) {
    if (n.type !== r.type) continue;
    let nameNode: TsNode | null;
    if (r.nameStrategy === "declarator") nameNode = descendName(n);
    else if (r.nameStrategy === "firstIdent") nameNode = n.namedChildren.find((c) => NAMEISH.test(c.type)) ?? null;
    else nameNode = n.childForFieldName(r.nameField ?? "name");
    if (nameNode) return { kind: r.kind, name: nameNode.text };
  }
  return null;
}
function callFnOf(cfg: LangConfig, n: TsNode): TsNode | null {
  for (const r of cfg.calls) {
    if (n.type !== r.type) continue;
    const byField = r.fnField ? n.childForFieldName(r.fnField) : null;
    if (byField) return byField;
    // fallback: first identifier-ish child (grammars without a function field, e.g. kotlin)
    return n.namedChildren.find((c) => c.type === cfg.identType) ?? null;
  }
  return null;
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
    const d = defOf(cfg, n);
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
    const fn = callFnOf(cfg, n);
    if (fn) {
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

/**
 * Per-language tree-sitter specs. Adding a grammar from tree-sitter-wasms is a
 * table entry — node/field names verified against the actual grammar, not assumed.
 */
export const SPECS: Record<string, LangConfig> = {
  python: {
    defs: [
      { type: "function_definition", kind: "function" },
      { type: "class_definition", kind: "class" },
    ],
    calls: [{ type: "call", fnField: "function" }],
    identType: "identifier",
    selectorTypes: ["attribute"],
  },
  go: {
    defs: [
      { type: "function_declaration", kind: "function" },
      { type: "method_declaration", kind: "method" },
      { type: "type_spec", kind: "struct" },
    ],
    calls: [{ type: "call_expression", fnField: "function" }],
    identType: "identifier",
    selectorTypes: ["selector_expression"],
  },
  rust: {
    defs: [
      { type: "function_item", kind: "function" },
      { type: "struct_item", kind: "struct" },
      { type: "enum_item", kind: "enum" },
      { type: "trait_item", kind: "interface" },
    ],
    calls: [{ type: "call_expression", fnField: "function" }],
    identType: "identifier",
    selectorTypes: ["field_expression", "scoped_identifier"],
  },
  java: {
    defs: [
      { type: "method_declaration", kind: "method" },
      { type: "class_declaration", kind: "class" },
      { type: "interface_declaration", kind: "interface" },
    ],
    calls: [{ type: "method_invocation", fnField: "name" }],
    identType: "identifier",
    selectorTypes: ["field_access"],
  },
  php: {
    defs: [
      { type: "function_definition", kind: "function" },
      { type: "method_declaration", kind: "method" },
      { type: "class_declaration", kind: "class" },
    ],
    calls: [
      { type: "function_call_expression", fnField: "function" },
      { type: "member_call_expression", fnField: "name" },
    ],
    identType: "name",
    selectorTypes: ["member_access_expression"],
  },
  c_sharp: {
    defs: [
      { type: "method_declaration", kind: "method" },
      { type: "class_declaration", kind: "class" },
      { type: "interface_declaration", kind: "interface" },
      { type: "struct_declaration", kind: "struct" },
    ],
    calls: [{ type: "invocation_expression", fnField: "function" }],
    identType: "identifier",
    selectorTypes: ["member_access_expression"],
  },
  ruby: {
    defs: [
      { type: "method", kind: "method" },
      { type: "class", kind: "class" },
      { type: "module", kind: "module" },
    ],
    calls: [{ type: "call", fnField: "method" }],
    identType: "identifier",
    selectorTypes: ["scope_resolution"],
  },
  c: {
    defs: [{ type: "function_definition", kind: "function", nameStrategy: "declarator" }],
    calls: [{ type: "call_expression", fnField: "function" }],
    identType: "identifier",
    selectorTypes: ["field_expression"],
  },
  cpp: {
    defs: [
      { type: "function_definition", kind: "function", nameStrategy: "declarator" },
      { type: "class_specifier", kind: "class" },
      { type: "struct_specifier", kind: "struct" },
    ],
    calls: [{ type: "call_expression", fnField: "function" }],
    identType: "identifier",
    selectorTypes: ["field_expression"],
  },
  swift: {
    defs: [
      { type: "function_declaration", kind: "function" },
      { type: "class_declaration", kind: "class" },
      { type: "protocol_declaration", kind: "interface" },
    ],
    calls: [{ type: "call_expression" }],
    identType: "simple_identifier",
    selectorTypes: ["navigation_expression"],
  },
  kotlin: {
    defs: [
      { type: "function_declaration", kind: "function", nameStrategy: "firstIdent" },
      { type: "class_declaration", kind: "class", nameStrategy: "firstIdent" },
    ],
    calls: [{ type: "call_expression" }],
    identType: "simple_identifier",
    selectorTypes: ["navigation_expression"],
  },
  scala: {
    defs: [
      { type: "function_definition", kind: "function" },
      { type: "object_definition", kind: "module" },
      { type: "class_definition", kind: "class" },
      { type: "trait_definition", kind: "interface" },
    ],
    calls: [{ type: "call_expression", fnField: "function" }],
    identType: "identifier",
    selectorTypes: ["field_expression"],
  },
  zig: {
    defs: [{ type: "function_declaration", kind: "function" }],
    calls: [{ type: "call_expression", fnField: "function" }],
    identType: "identifier",
    selectorTypes: ["field_expression"],
  },
  lua: {
    defs: [
      { type: "function_definition_statement", kind: "function", nameStrategy: "firstIdent" },
      { type: "function_definition", kind: "function", nameStrategy: "firstIdent" },
    ],
    calls: [{ type: "function_call", fnField: "name" }, { type: "call", fnField: "name" }],
    identType: "identifier",
    selectorTypes: ["dot_index_expression", "method_index_expression"],
  },
  solidity: {
    defs: [
      { type: "function_definition", kind: "function" },
      { type: "contract_declaration", kind: "class" },
      { type: "struct_declaration", kind: "struct" },
    ],
    calls: [{ type: "call_expression", fnField: "function" }],
    identType: "identifier",
    selectorTypes: ["member_expression"],
  },
  objc: {
    defs: [
      // class name is the first identifier; superclass is the second (firstIdent picks the name).
      { type: "class_interface", kind: "class", nameStrategy: "firstIdent" },
      { type: "class_implementation", kind: "class", nameStrategy: "firstIdent" },
      // method_type wraps the return type, so the first bare identifier is the selector name.
      { type: "method_declaration", kind: "method", nameStrategy: "firstIdent" },
      { type: "method_definition", kind: "method", nameStrategy: "firstIdent" },
    ],
    calls: [{ type: "message_expression", fnField: "method" }],
    identType: "identifier",
    selectorTypes: [],
  },
  bash: {
    // shell "calls" are commands; a command_name matching an in-file function resolves.
    // identType is command_name (not a bare word) so the `name` field node matches directly.
    defs: [{ type: "function_definition", kind: "function" }],
    calls: [{ type: "command", fnField: "name" }],
    identType: "command_name",
    selectorTypes: [],
  },
  ocaml: {
    // let-bindings nest the name as a value_name child; firstIdent picks it.
    // application_expression.function is a value_path; identType=value_path lets
    // a simple `add` resolve while qualified `Mod.add` falls to a boundary.
    defs: [{ type: "let_binding", kind: "function", nameStrategy: "firstIdent" }],
    calls: [{ type: "application_expression", fnField: "function" }],
    identType: "value_path",
    selectorTypes: [],
  },
  rescript: {
    defs: [{ type: "let_binding", kind: "function", nameStrategy: "firstIdent" }],
    calls: [{ type: "call_expression", fnField: "function" }],
    identType: "value_identifier",
    selectorTypes: [],
  },
};
