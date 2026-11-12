import { describe, it, expect } from "vitest";
import { compactVariants, expandMorphology, lemma, morphVariants, queryConcepts } from "./morph.js";

describe("code-identifier morphology", () => {
  it("collapses the inflections of common programming verbs to one canonical form", () => {
    for (const t of ["evaluate", "evaluated", "evaluates", "evaluating", "evaluation", "evaluations"]) {
      expect(lemma(t)).toBe("eval");
    }
    expect(lemma("running")).toBe("run");
    expect(lemma("runs")).toBe("run");
    for (const t of ["registered", "registers", "registering", "registration", "registrations"]) {
      expect(lemma(t)).toBe("register");
    }
    for (const t of ["routed", "routes", "routing"]) expect(lemma(t)).toBe("route");
    for (const t of ["collected", "collects", "collecting", "collection", "collections", "collector"]) {
      expect(lemma(t)).toBe("collect");
    }
    // already-canonical forms stay themselves
    expect(lemma("eval")).toBe("eval");
    expect(lemma("register")).toBe("register");
    expect(lemma("route")).toBe("route");
    expect(lemma("run")).toBe("run");
  });

  it("is conservative: it never shortens a short word and never mangles unrelated words", () => {
    expect(lemma("cat")).toBe("cat");
    expect(lemma("cats")).toBe("cats"); // < minToken for the trailing-s rule
    expect(lemma("string")).toBe("string"); // "str" would be < 4 chars — refused
    expect(lemma("thing")).toBe("thing");
    expect(lemma("seed")).toBe("seed");
    expect(lemma("handler")).toBe("handler");
    // a general suffix rule still helps ordinary verbs
    expect(lemma("testing")).toBe("test");
    expect(lemma("parsed")).toBe("parse");
    expect(lemma("embedded")).toBe("embed");
  });

  it("expandMorphology keeps the raw token, order and term frequency", () => {
    expect(expandMorphology(["evaluate", "query", "evaluate"])).toEqual([
      "evaluate", "eval", "query", "evaluate", "eval",
    ]);
    expect(expandMorphology(["cat"])).toEqual(["cat"]);
    expect(expandMorphology([])).toEqual([]);
  });

  it("morphVariants is purely additive (never the token itself)", () => {
    expect(morphVariants("evaluate")).toEqual(["eval"]);
    expect(morphVariants("cat")).toEqual([]);
  });

  it("compactVariants recovers a word written as one lowercase run elsewhere", () => {
    expect(compactVariants("how does PromQL evaluate an instant query")).toContain("promql");
    expect(compactVariants("promql/engine.go")).toContain("promql");
    expect(compactVariants("PromQLExtension")).toContain("promqlextension");
    // punctuation never merges two words into one
    expect(compactVariants("scrape-manager")).toEqual(["scrape", "manager"]);
  });

  it("queryConcepts collapses camel-case artifacts to one concept per written word", () => {
    const concepts = queryConcepts("how does PromQL evaluate an instant query");
    expect(concepts).toEqual(["how", "does", "promql", "evaluate", "an", "instant", "query"]);
    // the camel-case split pieces of "PromQL" must NOT become concepts of their own
    expect(concepts).not.toContain("prom");
    expect(concepts).not.toContain("ql");
    // ordinary words are split as usual, punctuation never merges two words
    expect(queryConcepts("scrape/metrics collect-targets")).toEqual([
      "scrape", "metrics", "collect", "targets",
    ]);
  });

  it("is deterministic: the same text yields byte-identical token lists", () => {
    const text = "how does PromQL evaluate an instant query";
    expect(queryConcepts(text)).toEqual(queryConcepts(text));
    expect(expandMorphology(["evaluation", "routing"])).toEqual(expandMorphology(["evaluation", "routing"]));
  });
});
