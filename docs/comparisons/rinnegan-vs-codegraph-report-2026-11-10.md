# Rinnegan vs Codegraph — blind accuracy comparison (2026-11-10)

Repos: Master `/mnt/d/Hypervisor_Code/Master` (Laravel 13 + Vue 3 KVM control panel, 7,801 indexed files),
Slave `/mnt/d/Hypervisor_Code/Slave` (Laravel hypervisor agent + Go/Rust, 1,673 indexed files).

Tools, driven exactly as an agent would drive them:
- **rinnegan** — fixed local build (`fix: polyfill missing ctype imports…`, `fix: don't abort the whole index…`, pushed to `hypervisor-io/rinnegan@main`), `understand "<task>"` per query.
- **codegraph** v0.9.9 — MCP `codegraph_explore` over the existing indexes (Master DB served from a native-fs copy; symlinked source tree).

11 queries (4 Slave + 7 Master) spanning PHP services, jobs, console commands, Vue frontend, bash deploy scripts, Go.
4 independent blind judges (**glm, deepseek, minimax, ultrafast-coder** subagents): outputs were anonymized A/B
(per-packet random assignment, key held by orchestrator), each judge independently established ground truth from
source, then scored relevance / hallucination-penalty / completeness / noise with file:line evidence.

## Verdict by packet (majority across 4 judges)

| Query | Winner | Margin |
|---|---|---|
| Slave: VM start command receive/execute | **rinnegan** 4–0 | marginal (both tools miss the real flow) |
| Slave: KVM VM create via libvirt | **rinnegan** 4–0 | slight |
| Slave: backup execution + upload | **rinnegan** 4–0 | clear |
| Slave: task progress reporting to master | tie 2–2 | both miss `Task.php` core |
| Master: live migration end-to-end | **rinnegan** 3–0 (1 tie) | narrow — both miss `LiveMigrationService` |
| Master: instance backup scheduling/initiation | **codegraph** 4–0 | rinnegan anchored on wrong subsystem (`Services/Backup/BackupService` = master self-backup) |
| Master: user VNC console flow | **codegraph** 4–0 | rinnegan returned 100% test-harness bytes |
| Master: deployment IP/disk/plan orchestration | **rinnegan** 2–1 (1 tie) | both miss `InstanceService::create` |
| Master: CS hourly billing auto-suspend | **rinnegan** 3–1 | clear |
| Master: rDNS via PowerDNS | **rinnegan** 4–0 | clear |
| Master: S3 bandwidth quota enforcement | **rinnegan** 4–0 | decisive |

**Grand total: rinnegan 30 · codegraph 11 · ties 3** (44 blind judgments).

## Aggregated metric averages (all 22 outputs per tool)

| Metric | rinnegan | codegraph |
|---|---|---|
| relevance_accuracy | ~4.2/10 | ~3.4/10 |
| hallucination_penalty (10 = none) | ~9.6/10 | ~9.5/10 |
| completeness | ~3.5/10 | ~2.6/10 |
| noise_ratio | ~68% | ~84% |

## Key findings

1. **No fabrication from either tool.** Judges spot-checked ~200 citations; every path/line/symbol was exact.
   Accuracy differences are pure retrieval/relevance, not honesty.
2. **Rinnegan's failure mode** (why it lost Master P2/P3): keyword capture by *same-named different-subsystem* code
   (`Services/Backup/BackupService.php` master self-backup for instance-backup queries; `tests/Frontend/*.cjs`
   harness for the VNC query) and tests/docs outranking production code when few symbols match.
3. **Codegraph's failure mode**: relationship edges often name the true spine (`applyBalancePolicy → SuspendInstances`,
   `liveMigrateInstance → prepareStorageMapping`) but its verbatim payload is dominated by unrelated whole files
   (~85% average noise), so the useful signal is one line in 25 KB.
4. **Shared gap**: neither tool surfaces controller → job → service entry-point chains; both bias to models and
   periphery. All judges independently flagged this ("neither surfaced `InstanceService::create`,
   `PolicyBackupScheduler`, `ConsoleService::mintKvmSession`…").
5. **Ops notes**: rinnegan index: Master ~50 min on native fs (7.6k files; /mnt/d drvfs is ~10× slower — index from
   a native-fs copy and copy `.rinnegan/graph.db` back). Queries ~7 min cold on Master, ~2 min on Slave.
   Codegraph: 1.2 GB Master DB, ~2 min cold explore per call; unix-socket daemon can't run on /mnt/d (ENOTSUP).

Raw materials: outputs `cmp/rin/` + `cmp/cg/`, packets + blind key `cmp/packets/`, judge transcripts in session log,
per-judge tally `cmp/tally.md`.

---

## Addendum — retrieval fixes shipped after the judging

Commits `559e425` + `af84bd0` (pushed to hypervisor-io/rinnegan@main), 174/174 tests green:
- **Anchor quality tiers**: anchors must be definition symbols in non-test/non-doc files; widen pool before falling back (kills `Mock.a`/`Page.header`-type anchors).
- **Query-term coverage**: every distinct task token gets an anchor (whole-token FTS first, then substring), with file-path affinity as tie-break — rare decisive tokens (`vnc`) no longer starved by common ones (`user`).
- **Caller-chain bonus**: symbols that call a seed rank ×1.3 (entry-point → job → service shows up).
- **Test-intent guard**: test-role files never seed/render unless the task mentions tests.
- **Doc-asset role**: `docs/`, `documentation/` trees → role `doc` at 0.5 weight; mockup JS no longer wins slices.
- **Substring token fallback**: `seed()` reaches `novnc`/`vncTicket` from `vnc` (FTS is whole-token only).
- ANALYZER_VERSION 1→2 so stored roles re-derive.

Validation on the previously-failing Master VNC query (blind judge score 1/10, 100% test-harness bytes):
now returns `User/.../InstanceManage/InstanceHeader.vue`, `InstanceSettingsTab.updateVNC`, admin `saveVNC`,
zero test-harness bytes, zero docs mockups in DETAIL.
