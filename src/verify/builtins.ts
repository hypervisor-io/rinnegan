// Per-language global/builtin identifier sets. Used by the unknown-symbol check
// (verify.ts) to avoid flagging legitimate calls to language builtins as
// hallucinated symbols. Only languages listed here get error-severity
// unknown-symbol findings — see the honesty rule in verify.ts.

const JS_TS_BUILTINS = new Set([
  "console", "JSON", "Math", "Object", "Array", "Promise", "Set", "Map", "String",
  "Number", "Boolean", "Date", "RegExp", "Error", "Symbol", "parseInt", "parseFloat",
  "isNaN", "fetch", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "structuredClone", "require",
]);

const PYTHON_BUILTINS = new Set([
  "print", "len", "range", "str", "int", "float", "dict", "list", "set", "tuple",
  "open", "isinstance", "super", "enumerate", "zip", "map", "filter", "sorted",
  "getattr", "setattr", "hasattr", "type", "Exception", "ValueError", "TypeError",
]);

const GO_BUILTINS = new Set([
  "make", "len", "cap", "new", "append", "copy", "delete", "panic", "recover",
  "print", "println", "close", "min", "max", "clear",
]);

export const BUILTINS: Record<string, Set<string>> = {
  typescript: JS_TS_BUILTINS,
  javascript: JS_TS_BUILTINS,
  python: PYTHON_BUILTINS,
  go: GO_BUILTINS,
};
