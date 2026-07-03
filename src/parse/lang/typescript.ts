import ts from "typescript";
import { nodeId } from "../../core/types.js";
import type { GraphNode, GraphEdge, NodeKind, ReadWrite } from "../../core/types.js";
import type { ParseResult, ImportRef } from "../extract.js";

interface Decl {
  id: string;
  name: string;
  kind: NodeKind;
}

interface Scope {
  ownerId: string;
  start: number;
  end: number;
  names: Map<string, Decl>;
  parent: Scope | null;
}

const FILE_QN = "<file>";

function functionLike(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n)
  );
}

export function extractTypeScript(path: string, source: string, language: string): ParseResult {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const imports: ImportRef[] = [];
  let unresolved = 0;

  function collectImport(n: ts.ImportDeclaration): void {
    if (!ts.isStringLiteral(n.moduleSpecifier)) return;
    const moduleSpec = n.moduleSpecifier.text;
    const line = lineOf(n.getStart(sf));
    const clause = n.importClause;
    if (!clause) return;
    if (clause.name) imports.push({ localName: clause.name.text, importedName: "default", moduleSpec, line });
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) {
      imports.push({ localName: nb.name.text, importedName: "*", moduleSpec, line });
    } else if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        imports.push({ localName: el.name.text, importedName: (el.propertyName ?? el.name).text, moduleSpec, line });
      }
    }
  }

  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const colOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).character + 1;

  const fileId = nodeId(path, FILE_QN);
  nodes.push({
    id: fileId, kind: "file", qualifiedName: FILE_QN, filePath: path, language,
    startLine: 1, endLine: lineOf(source.length),
  });

  const rootScope: Scope = { ownerId: fileId, start: 0, end: source.length, names: new Map(), parent: null };
  const scopeStack: Scope[] = [rootScope];
  const nameStack: string[] = [];
  const declNamePos = new Set<number>();
  const ownerForNode = new Map<ts.Node, string>();
  const nodeScope = new Map<ts.Node, Scope>([[sf, rootScope]]);
  const cur = () => scopeStack[scopeStack.length - 1];

  // type-aware method resolution state
  const classMethods = new Map<string, Map<string, string>>(); // className -> methodName -> nodeId
  const varType = new Map<string, string>(); // variable/param nodeId -> className

  function typeNameFromTypeNode(t: ts.TypeNode | undefined): string | undefined {
    if (t && ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) return t.typeName.text;
    return undefined;
  }
  function inferType(n: ts.Node): string | undefined {
    if (ts.isVariableDeclaration(n)) {
      if (n.type) return typeNameFromTypeNode(n.type);
      if (n.initializer && ts.isNewExpression(n.initializer) && ts.isIdentifier(n.initializer.expression)) {
        return n.initializer.expression.text;
      }
    }
    if (ts.isParameter(n) && n.type) return typeNameFromTypeNode(n.type);
    return undefined;
  }

  function signatureOf(n: ts.Node): string {
    const txt = n.getText(sf);
    const brace = txt.indexOf("{");
    const head = (brace >= 0 ? txt.slice(0, brace) : txt.split("\n")[0]).trim();
    return head.slice(0, 200);
  }
  function isExported(n: ts.Node): boolean {
    const mods = ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined;
    return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  }

  function declInfoFor(n: ts.Node): { name: string; kind: NodeKind; nameNode: ts.Node } | null {
    if (ts.isFunctionDeclaration(n) && n.name) return { name: n.name.text, kind: "function", nameNode: n.name };
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return { name: n.name.text, kind: "method", nameNode: n.name };
    if (ts.isConstructorDeclaration(n)) return { name: "constructor", kind: "method", nameNode: n };
    if (ts.isClassDeclaration(n) && n.name) return { name: n.name.text, kind: "class", nameNode: n.name };
    if (ts.isInterfaceDeclaration(n)) return { name: n.name.text, kind: "interface", nameNode: n.name };
    if (ts.isTypeAliasDeclaration(n)) return { name: n.name.text, kind: "type_alias", nameNode: n.name };
    if (ts.isEnumDeclaration(n)) return { name: n.name.text, kind: "enum", nameNode: n.name };
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const init = n.initializer;
      const isFn = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
      const isConst =
        ts.isVariableDeclarationList(n.parent) && (n.parent.flags & ts.NodeFlags.Const) !== 0;
      return { name: n.name.text, kind: isFn ? "function" : isConst ? "constant" : "variable", nameNode: n.name };
    }
    if (ts.isParameter(n) && ts.isIdentifier(n.name)) return { name: n.name.text, kind: "variable", nameNode: n.name };
    return null;
  }

  // ---- Pass A: declarations, scopes, containment ----
  function visitA(n: ts.Node): void {
    let pushedName = false;
    let pushedScope = false;

    if (ts.isImportDeclaration(n)) collectImport(n);

    const d = declInfoFor(n);
    if (d) {
      const fqn = [...nameStack, d.name].join(".") || d.name;
      const id = nodeId(path, fqn);
      nodes.push({
        id, kind: d.kind, qualifiedName: fqn, filePath: path, language,
        startLine: lineOf(n.getStart(sf)), endLine: lineOf(n.getEnd()),
        signature: signatureOf(n), isExported: isExported(n),
      });
      cur().names.set(d.name, { id, name: d.name, kind: d.kind });
      declNamePos.add(d.nameNode.getStart(sf));
      edges.push({
        source: cur().ownerId, target: id, kind: "contains", line: lineOf(n.getStart(sf)),
        col: colOf(n.getStart(sf)), provenance: "ast_exact", confidence: 1, resolver: "ts-scope",
      });
      if (d.kind === "method") {
        const parts = fqn.split(".");
        const m = parts.pop()!;
        const cls = parts.join(".");
        let mm = classMethods.get(cls);
        if (!mm) classMethods.set(cls, (mm = new Map()));
        mm.set(m, id);
      } else {
        const ty = inferType(n);
        if (ty) varType.set(id, ty);
      }

      if (functionLike(n)) {
        ownerForNode.set(n, id);
        nameStack.push(d.name);
        pushedName = true;
      } else if (ts.isClassDeclaration(n)) {
        nameStack.push(d.name);
        pushedName = true;
      } else if (ts.isVariableDeclaration(n) && n.initializer && functionLike(n.initializer)) {
        ownerForNode.set(n.initializer, id);
      }
    }

    if (functionLike(n)) {
      const owner = ownerForNode.get(n) ?? cur().ownerId;
      const s: Scope = { ownerId: owner, start: n.getStart(sf), end: n.getEnd(), names: new Map(), parent: cur() };
      nodeScope.set(n, s);
      scopeStack.push(s);
      pushedScope = true;
    }

    ts.forEachChild(n, visitA);
    if (pushedScope) scopeStack.pop();
    if (pushedName) nameStack.pop();
  }
  visitA(sf);

  // ---- scope/name resolution helpers ----
  function lookup(scope: Scope, name: string): Decl | undefined {
    for (let s: Scope | null = scope; s; s = s.parent) {
      const d = s.names.get(name);
      if (d) return d;
    }
    return undefined;
  }

  const unresolvedNodes = new Set<string>();
  function ensureUnresolved(name: string, line: number, col: number): string {
    const qn = `<unresolved>.${name}`;
    const id = nodeId(path, qn);
    if (!unresolvedNodes.has(id)) {
      unresolvedNodes.add(id);
      nodes.push({
        id, kind: "unresolved", qualifiedName: qn, filePath: path, language,
        startLine: line, endLine: line,
      });
    }
    return id;
  }

  const emittedEdge = new Set<string>();
  function pushEdge(e: GraphEdge): void {
    // line in the key so each call SITE gets an edge — verify's added-range
    // check needs per-site granularity, not just per-(source,target) (F1).
    const key = `${e.source}|${e.target}|${e.kind}|${e.readWrite ?? ""}|${e.line}`;
    if (emittedEdge.has(key)) return;
    emittedEdge.add(key);
    edges.push(e);
  }

  function readWriteOf(id: ts.Identifier): ReadWrite {
    const p = id.parent;
    if (ts.isBinaryExpression(p) && p.left === id) {
      const op = p.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken) return "write";
      if (op >= ts.SyntaxKind.PlusEqualsToken && op <= ts.SyntaxKind.CaretEqualsToken) return "readwrite";
    }
    if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
      (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) {
      return "readwrite";
    }
    return "read";
  }

  // ---- Pass B: calls + references (scope threaded via traversal, O(1) lookups) ----
  function visitB(n: ts.Node, scope: Scope, classCtx: string | null): void {
    const here = nodeScope.get(n) ?? scope;
    const childClass = ts.isClassDeclaration(n) && n.name ? n.name.text : classCtx;
    // calls
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const line = lineOf(n.getStart(sf));
      const col = colOf(n.getStart(sf));
      const owner = here.ownerId;
      if (ts.isIdentifier(callee)) {
        const resolved = lookup(here, callee.text);
        if (resolved) {
          pushEdge({ source: owner, target: resolved.id, kind: "calls", line, col, provenance: "ast_exact", confidence: 1, resolver: "ts-scope", readWrite: "call" });
        } else {
          unresolved++;
          pushEdge({ source: owner, target: ensureUnresolved(callee.text, line, col), kind: "calls", line, col, provenance: "unresolved", confidence: 0, resolver: "ts-scope", readWrite: "call", metadata: { boundary: "unresolved-callee" } });
        }
      } else if (ts.isPropertyAccessExpression(callee)) {
        // a.b() — resolve via receiver type (new X / annotation / this)
        const methodName = callee.name.text;
        const recv = callee.expression;
        let className: string | undefined;
        if (recv.kind === ts.SyntaxKind.ThisKeyword) className = classCtx ?? undefined;
        else if (ts.isIdentifier(recv)) {
          const d = lookup(here, recv.text);
          if (d) className = varType.get(d.id);
        }
        const targetId = className ? classMethods.get(className)?.get(methodName) : undefined;
        if (targetId) {
          pushEdge({ source: owner, target: targetId, kind: "calls", line, col, provenance: "ast_inferred", confidence: 0.85, resolver: "ts-type", readWrite: "call", metadata: { receiverType: className } });
        } else {
          unresolved++;
          pushEdge({ source: owner, target: ensureUnresolved(methodName, line, col), kind: "calls", line, col, provenance: "unresolved", confidence: 0, resolver: "ts-type", readWrite: "call", metadata: { boundary: "dynamic-dispatch", receiver: recv.getText(sf).slice(0, 40) } });
        }
      }
    }

    // variable initializer = write
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
      const resolved = lookup(here, n.name.text);
      const owner = here.ownerId;
      if (resolved) {
        pushEdge({ source: owner, target: resolved.id, kind: "references", line: lineOf(n.name.getStart(sf)), col: colOf(n.name.getStart(sf)), provenance: "ast_exact", confidence: 1, resolver: "ts-scope", readWrite: "write" });
      }
    }

    // identifier references (skip declaration names and call callees handled above)
    if (ts.isIdentifier(n) && !declNamePos.has(n.getStart(sf))) {
      const p = n.parent;
      const isCallee = ts.isCallExpression(p) && p.expression === n;
      const isPropName = ts.isPropertyAccessExpression(p) && p.name === n;
      if (!isCallee && !isPropName) {
        const resolved = lookup(here, n.text);
        if (resolved && resolved.kind !== "function" && resolved.kind !== "class") {
          const rw = readWriteOf(n);
          const owner = here.ownerId;
          if (owner !== resolved.id) {
            pushEdge({ source: owner, target: resolved.id, kind: "references", line: lineOf(n.getStart(sf)), col: colOf(n.getStart(sf)), provenance: "ast_exact", confidence: 1, resolver: "ts-scope", readWrite: rw });
          }
        }
      }
    }

    ts.forEachChild(n, (c) => visitB(c, here, childClass));
  }
  visitB(sf, rootScope, null);

  return { nodes, edges, unresolved, imports };
}
