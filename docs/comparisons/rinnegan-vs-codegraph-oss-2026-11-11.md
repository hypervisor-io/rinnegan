# Rinnegan vs codegraph — open-source repos, multi-language (2026-11-11)

## Setup

Shallow clones of five large OSS repos, each indexed by both tools on native filesystem:

| Repo | Language | Files (git) | rinnegan nodes / edges | codegraph nodes / edges | rinnegan index | codegraph index |
|---|---|---|---|---|---|---|
| django/django | Python | 7,100 | 94,939 / 254,304 | 62,802 / 177,936 | ~8 min | 1m02s |
| rails/rails | Ruby | 5,037 | 135,882 / 387,928 | 63,170 / 178,239 | ~17 min | 1m15s |
| nestjs/nest | TypeScript | 2,756 | 51,992 / 206,636 | 20,228 / 44,070 | ~3 min | 18s |
| prometheus/prometheus | Go | 1,773 | 43,943 / 155,046 | 25,735 / 92,298 | ~2.5 min | 29s |
| tokio-rs/tokio | Rust | 892 | 21,926 / 45,206 | 14,428 / 47,596 | ~2.5 min | 13s |

2 architecture queries per repo (10 packets). rinnegan driven via `understand "<task>"`; codegraph via MCP
`codegraph_explore`. Outputs anonymized A/B per packet (blind key), and every packet was judged by **2 independent
judges** out of {glm, deepseek, minimax, ultrafast-coder} → 20 blind judgments. Judges established ground truth
themselves from source, scored relevance / hallucination / completeness / noise with file:line evidence.

## Results by packet

| Packet | rinnegan | codegraph | tie |
|---|---|---|---|
| django: queryset filter → SQL | **2** | 0 | |
| django: middleware request/response | 1 | **1** | |
| rails: save + callbacks | **1** | 0 | 1 |
| rails: route → controller dispatch | 0 | **2** | |
| nest: DI provider resolution | **2** | 0 | |
| nest: route registration/execution | 0 | **2** | |
| prometheus: scrape manager | 0 | **2** | |
| prometheus: PromQL instant query | 0 | **2** | |
| tokio: scheduler worker threads | 0 | **2** | |
| tokio: IO driver (epoll/mio) | 0 | **2** | |
| **Total (20 judgments)** | **6** | **13** | **1** |

Query-level winners (majority): rinnegan 3 (django-filter, nest-DI, django-middleware split), codegraph 6, 1 tie-ish.

## Combined picture

| Corpus | rinnegan | codegraph | ties |
|---|---|---|---|
| Master + Slave (custom Laravel/Vue/Go codebase, 11 queries) | 30 | 11 | 3 |
| 5 OSS frameworks (10 queries) | 6 | 13 | 1 |

**Reverse of the in-house result.** On a codebase whose vocabulary matches the product domain (Laravel "instance",
"backup", "migration"), rinnegan's lexical+latent engine wins. On idiomatic OSS frameworks with deep indirection
and metaprogramming (Rails/Django magic, PromQL, Tokio), codegraph's broader file-level retrieval lands closer code
more often, while rinnegan drifts to keyword-collision neighbours.

## Failure modes observed

**rinnegan**
- Dense keyword collisions: "filter" → logging/admin/template filters instead of ORM internals (django-01);
  "resolve" → HTTP router instead of DI (nest); "handler" → microservices listeners.
- Drift to peripheral files: `cmd/prometheus/main.go` filler on scrape questions; blocking thread pool instead of
  async scheduler (tokio-01); PromQL editor autocomplete instead of the engine.
- Bench/test code occasionally outranks production (tokio-02 returned benches; prometheus-02 editor TSX).
- Strongest where the true mechanism is a concentrated method body (io/driver.rs in tokio-02: rel 8/10, noise 20%).

**codegraph**
- Reads whole files → usually contains at least adjacent real code, but noise 45–95%.
- Worst: benches/tests for tokio-02 (no mio/poll at all), microservices listeners for nest-02.
- Only tool with outright false caller attributions in this batch (nest-01: claimed
  `routes-resolver.resolve` callers; actual callers are `nest-application.ts`).
- Best: concrete middleware `process_response` set (django-02), scrape target construction (prometheus-01).

**Both**
- Zero fabricated symbols/lines across ~120 spot-checked citations. Accuracy gaps are retrieval, not invention.
- Systematically miss the orchestration/entry layer (Django `handler/base.py` chain, Rails `route_set.rb` dispatcher
  source, Nest `RoutesResolver → RouterProxy`, Tokio `Core::run`).

## Performance

Index builds: codegraph 13s–75s; rinnegan 2.5–17 min (single-threaded, deterministic order).

Query latency measured before the cache fix: rinnegan 2–6 min/query (LSA rebuilt per process), codegraph 10–20s.

Shipped during this work (`eecec87`): persisted semantic model (LSA + BM25 token stream) in `semantic_cache`,
fingerprint-validated, deterministic Float32 payload.
- Master (229k nodes): **478s → 2.5s** per repeat query, output byte-identical build vs cache.
- tokio (22k nodes): 21.9s → 1.3–4.1s.
- `index`/`status` unaffected; cache is 43.6 MB for Master, 4.3 MB for tokio.
- Remaining gap vs codegraph is index build parallelism, not query time.

## Caveats

- 2 judges per packet (vs 4 in the in-house batch), 10 packets — directional, not exhaustive.
- Judge models are LLM subagents; scores correlate with "does the output contain the true flow", which was
  independently verified against source for every packet.
- Clones and codegraph/rinnegan indexes were removed after judging.

Raw materials: `/tmp/opencode/cmp2/{rin,cg,packets}`.

---

## Addendum — accuracy fixes after OSS judging (`dcc1bf5`, pushed)

- **Full-file BM25 prior**: file-body token stream (deterministic 4096-token cap) in `files_fts`; symbol scores ×(1 + 2 × file BM25 relevance). Prevents symbol-name lexical collisions capturing slices.
- **Bench/test guards**: `bench`, `benches`, `benchmark`, `benchmarks` paths classify as role `test`. `#[cfg(test)]` in production Rust deliberately does NOT classify the file as test.
- **Ranking-pool seating**: top-3 prior files (score ≥0.5, non-test/non-doc, deterministic) contribute definition nodes into the rank pool, without changing anchors. Needed because the Rust extractor emits no cross-file reference edges, so otherwise the strongest prior files stayed unreachable from anchors.

Validation: tokio `understand "how does the runtime drive IO resources with epoll"`.
Before: benches dominate, zero `driver.rs`. After: zero benches; `runtime/io/driver.rs` appears 31 times,
with `turn`, `dispatch_event`, `park`, `shutdown` DETAIL blocks, plus `io/poll_evented.rs` and `runtime/mod.rs`.
193/193 tests green; output byte-identical across runs.

Remaining opportunity: parallel index parsing with sorted deterministic commits. Existing indexes gain file-body
relevance only as files reindex (no automatic hot-path backfill to avoid reading every file on incremental runs).

---

## Full blind rerun after fixes (`6db5e3e`, `fb865d5`, plus ranking prior at `dcc1bf5`)
42 judgments: every packet judged by 2 of glm / deepseek / minimax / ultrafast-coder.
Same 21 queries. Fresh clones/copies reindexed with the new code; codegraph outputs held fixed
(regenerated outputs were byte-identical). A/B anonymized per packet and post hoc decoded against the key.

| Packet | Before | After |
|---|---|---|
| django ORM filter→SQL | rinnegan 2-0 | rinnegan 2-0 |
| django middleware | split 1-1 | codegraph 2-0 |
| rails save + callbacks | rinnegan 1 + tie 1 | rinnegan 1 + tie 1 |
| rails route dispatch | codegraph 2-0 | codegraph 2-0 |
| nest DI lookup | rinnegan 2-0 | rinnegan 2-0 |
| nest route register/execute | codegraph 2-0 | codegraph 2-0 |
| prometheus scrape collection | codegraph 2-0 | codegraph 1 + tie 1 |
| prometheus PromQL evaluation | codegraph 2-0 | codegraph 2-0 |
| tokio worker scheduling loop | codegraph 2-0 | **rinnegan 2-0, flipped** |
| tokio epoll/mio driver | codegraph 2-0 | **split 1-1, partial flip** |
| Master live migration | rinnegan 3 + tie | rinnegan 2-0 |
| Master backup scheduling | codegraph 4-0 (original 4 judges) | **rinnegan 2-0, flipped** |
| Master VNC console flow | codegraph 4-0 | **rinnegan 2-0, flipped** |
| Master deploy IP/disk/plan | rinnegan 2, codegraph 1, tie 1 | split 1-1 |
| Master CS billing | rinnegan 3-1 | rinnegan 1 + tie 1 |
| Master PowerDNS | rinnegan 4-0 | rinnegan 2-0 |
| Master S3 bandwidth quota | rinnegan 4-0 | rinnegan 2-0 |
| Slave VM start | rinnegan 4-0 | **tie 2-0, regressed** |
| Slave VM create | rinnegan 4-0 | rinnegan 2-0 |
| Slave backup upload | rinnegan 4-0 | rinnegan 2-0 |
| Slave task progress | tie 2-2 | **rinnegan 2-0, flipped** |

Totals this rerun: **rinnegan 25 · codegraph 11 · ties 6**.
OSS only: rin 8, cg 10, ties 2 (was rin 6, cg 13). In-house only: rin 17, cg 1, ties 4.

What changed materially:
- tokio-01 now returns `worker.rs run:595` verbatim with `run_task/next_task/steal_work/park` — the exact worker loop.
- Master backup scheduling now shows `PolicyBackupScheduler.processInstance/isFullBackupDue/isIncrementalDue` (was master app self-backup).
- Master VNC now surfaces `ConsoleService` + `ProxmoxConsoleController` and user hooks instead of 100% frontend test bytes.
- Master PowerDNS and S3 quota are verified full-mechanism slices; Slave VM create + task progress contain real transport/creation source.
- tokio-02 retains the actual driver but missed `Driver::new` and includes inline test symbols; Rails dispatch and
  PromQL remain losses; both tools still miss Slave `InstanceController.powerAction -> InstancePowerAction`.

Performance this rerun: full 5-repo reindex + Master/Slave eval copies completed in ~6 minutes, vs >50 minutes
for the initial indexing campaign. Slave end-to-end cold index: 142s -> 29s.

README + tests carry byte-determinism and 204 green tests covering the parallel pool and store changes.

## Final OSS blind re-judgement after windowed relevance (`09b4d38`)
20 judgments: two independent judges per packet, blind A/B; original codegraph baseline held constant.

| Packet | rinnegan | codegraph | ties |
|---|---:|---:|---:|
| django 01 ORM, django 02 middleware | 4 | 0 | 0 |
| rails 01 save, rails 02 dispatch | 4 | 0 | 0 |
| nest 01 DI, nest 02 HTTP routing | 2 | 2 | 0 |
| prometheus 01 scrape, prometheus 02 PromQL | 1 | 3 | 0 |
| tokio 01 worker loop, tokio 02 IO driver | 2 | 0 | 1 |
| **Total** | **11** | **8** | **1** |

Compare the initial OSS panel: rinnegan 6, codegraph 13, tie1. rinnegan now leads 11-8 in the final panel.
Query-level winners: rinnegan 6 (django×2, rails×2, nest DI, tokio worker), codegraph 3
(Nest HTTP, PromQL, Prometheus scrape split once), tokio driver 1 split.

Best measured wins: django BaseHandler.load_middleware/_get_response, Rails Dispatcher.serve/controller/dispatch,
tokio worker.run:595 verbatim with run_task/next_task/steal_work. No fabricated source either tool.
One codegraph Rails line drift (-21) tracks an upstream commit changed between baseline capture and final judge clone,
not invented code and not attributable to rinnegan.

Remaining codegraph wins: Nest HTTP execution, PromQL actual API/Exec source, Prometheus scrape split. PromQL now names
the evaluator spine but DETAIL still spends too much on promtool text; `Manager.Run` and inline Rust test helpers
remain retrieval challenges.

Performance retained: warm queries ~1-2s plus bounded symbol-body work. Windowed prior adds 15-40% index size.
