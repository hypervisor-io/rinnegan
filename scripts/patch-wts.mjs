#!/usr/bin/env node
// Postinstall patch: web-tree-sitter 0.24.x cannot link grammar wasms that
// import C ctype functions it does not export (first seen with the bash
// grammar from tree-sitter-wasms 0.1.13: `env.isalpha` → the lazy-linking
// stub resolves to undefined and every bash parse throws
// "resolved is not a function").
//
// Fix: give the lazy stub a small JS ctype fallback so the import resolves
// instead of crashing. Idempotent; safe to run repeatedly.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let p;
try { p = require.resolve("web-tree-sitter/tree-sitter.js"); }
catch { process.exit(0); } // not installed yet — nothing to patch
if (!existsSync(p)) process.exit(0);

let s = readFileSync(p, "utf8");
const MARK = "/* rinnegan-ctype-polyfill */";
if (s.includes(MARK)) process.exit(0);

const OLD = `                if (!(prop in stubs)) {
                  var resolved;
                  stubs[prop] = (...args) => {
                    resolved ||= resolveSymbol(prop);
                    return resolved(...args);
                  };
                }`;
const NEW = `                if (!(prop in stubs)) {
                  var resolved;
                  stubs[prop] = (...args) => {
                    resolved ||= resolveSymbol(prop) || ${MARK} CTYPE_POLYFILLS[prop];
                    return resolved(...args);
                  };
                }`;
if (!s.includes(OLD)) {
  console.error("patch-wts: expected snippet not found; web-tree-sitter may have changed. Leaving file untouched.");
  process.exit(0);
}

const POLYFILL_DEF = `
          var CTYPE_POLYFILLS = {
            // int isalpha(int c) etc. — ASCII-only is sufficient for grammar
            // wasms built by recent tree-sitter CLI/emscripten combos.
            isalpha: (c) => (/[A-Za-z]/).test(String.fromCharCode(c)) ? 1 : 0,
            isalnum: (c) => (/[A-Za-z0-9]/).test(String.fromCharCode(c)) ? 1 : 0,
            isdigit: (c) => (c >= 48 && c <= 57) ? 1 : 0,
            isspace: (c) => (c === 32 || (c >= 9 && c <= 13)) ? 1 : 0,
            isupper: (c) => (c >= 65 && c <= 90) ? 1 : 0,
            islower: (c) => (c >= 97 && c <= 122) ? 1 : 0,
            ispunct: (c) => (/[!-/:-@\\[-\`{-~]/).test(String.fromCharCode(c)) ? 1 : 0,
            isxdigit: (c) => (/[0-9A-Fa-f]/).test(String.fromCharCode(c)) ? 1 : 0,
          };
          var proxyHandler = {`;

const ANCHOR = "          var proxyHandler = {";
if (!s.includes(ANCHOR)) {
  console.error("patch-wts: proxyHandler anchor not found; leaving file untouched.");
  process.exit(0);
}
s = s.replace(OLD, NEW).replace(ANCHOR, POLYFILL_DEF);
writeFileSync(p, s);
console.log("patch-wts: applied ctype polyfill to", p);
