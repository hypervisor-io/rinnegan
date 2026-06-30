import { describe, it, expect } from "vitest";
import { truncatedSvd } from "./svd.js";
import { LsaIndex } from "./lsa.js";
import { Bm25Index } from "./bm25.js";
import { rrfFuse } from "./fuse.js";

describe("truncatedSvd", () => {
  it("is deterministic and sign-canonical", () => {
    const m = [
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [0, 0, 1],
    ];
    const a = truncatedSvd(m, 2, { seed: 42 });
    const b = truncatedSvd(m, 2, { seed: 42 });
    expect(a.s).toEqual(b.s);
    expect(a.u).toEqual(b.u);
    expect(a.v).toEqual(b.v);
    expect(a.s.length).toBe(2);
    // largest singular value first
    expect(a.s[0]).toBeGreaterThanOrEqual(a.s[1]);
  });
});

describe("LsaIndex", () => {
  const docs = [
    { id: "auth", text: "handleUserSession authenticate login credential validatePassword" },
    { id: "math", text: "computeSum addNumbers multiplyMatrix factorial" },
    { id: "render", text: "drawCanvas paintPixels renderFrame displayImage" },
  ];

  it("ranks the auth doc highest for a login-flow query (semantic, no model)", () => {
    const idx = LsaIndex.build(docs);
    const res = idx.query("user login flow", 3);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].id).toBe("auth");
  });

  it("is deterministic across builds", () => {
    const a = LsaIndex.build(docs).query("login", 3);
    const b = LsaIndex.build(docs).query("login", 3);
    expect(a).toEqual(b);
  });
});

describe("Bm25Index + rrfFuse", () => {
  const docs = [
    { id: "auth", text: "authenticate login session" },
    { id: "db", text: "database query connection" },
  ];

  it("bm25 finds keyword match", () => {
    const idx = new Bm25Index(docs);
    expect(idx.search("login", 2)[0].id).toBe("auth");
  });

  it("rrf fuses two lists deterministically", () => {
    const fused = rrfFuse([
      [{ id: "auth", score: 0.9 }, { id: "db", score: 0.1 }],
      [{ id: "auth", score: 0.5 }],
    ]);
    expect(fused[0].id).toBe("auth");
  });
});
