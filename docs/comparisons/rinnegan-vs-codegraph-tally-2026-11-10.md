# Judge tally — Slave batch (blind key: P1 A=rinnegan B=codegraph · P2 A=codegraph B=rinnegan · P3 A=rinnegan B=codegraph · P4 A=rinnegan B=codegraph)

## deepseek (ses_e3cd5ad03ffdTm757F7Fv)
- P1: A(rin) 2/9/1/92% vs B(cg) 0/10/0/96% → A marginal (both miss real flow: InstancePowerAction/Power::start)
- P2: A(cg) 2/10/1/90% vs B(rin) 4/10/3/55% → B (rin) — surfaced Configuration.php/Bridge/microvmd, still missed createDomainXML
- P3: A(rin) 8/10/7/15% vs B(cg) 4/10/3/70% → A (rin) clear — exact upload path BackupPipeline/BackupTransport/S3
- P4: A(rin) 5/10/4/50% vs B(cg) 4/10/4/55% → A (rin) marginal
- Net rinnegan 4/4 wins (2 clear-ish, 2 marginal); shared retrieval gap on P1/P2 both-tools-miss

## glm (ses_e3cd5ad08ffdd64hxkjNJFpxrk)
- P1: A(rin) 2/9/1/95% vs B(cg) 1/9/1/98% → A marginal (both fail; A names real job via StartGuardTest)
- P2: A(cg) 4/9/3/80% vs B(rin) 5/9/3/72% → B (rin) slight (right file Configuration.php, missed createDomainXML)
- P3: A(rin) 8/10/6/30% vs B(cg) 4/9/3/65% → A (rin) clear
- P4: A(rin) 6/10/4/68% vs B(cg) 5/9/4/48% → A (rin) slight
- Net rinnegan 4/4; zero fabricated citations on both sides; shared miss: routes→controller→job entrypoints

## ultrafast-coder (ses_e3cd5acffffe155RnwAn7E5AOr)
- P1: A(rin) 1/9/0/95% vs B(cg) 0/9/0/98% → A marginal (both miss powerAction chain)
- P2: A(cg) 3/9/1/80% vs B(rin) 4/9/2/70% → B (rin) slight
- P3: A(rin) 8/10/5/15% vs B(cg) 4/9/2/80% → A (rin) clear
- P4: A(rin) 6/9/3/80% vs B(cg) 6/10/4/50% → B (cg) slight — Master::call transport wire beats progress-reporter buried in DeleteBackup noise
- Net rinnegan 3, codegraph 1; both miss entrypoint→job→core chains

## minimax (ses_e3cd5ad00ffe6spQ0MY06ZHp8G)
- P1: A(rin) 2/10/1/92% vs B(cg) 1/10/0/97% → A marginal (both fail)
- P2: A(cg) 3/10/2/85% vs B(rin) 4/10/2/78% → B (rin) marginal
- P3: A(rin) 7/10/6/35% vs B(cg) 5/10/4/65% → A (rin)
- P4: A(rin) 5/10/3/65% vs B(cg) 6/10/4/55% → B (cg) marginal
- Net rinnegan 3, codegraph 1; zero fabrication both tools; failure = retrieval relevance

# MASTER BATCH (key: P1 A=rin B=cg · P2 A=cg B=rin · P3 A=rin B=cg · P4 A=cg B=rin)

## deepseek (ses_e3c642d8affdcrOD5Do7zHEmhm)
- P1 live migration: A(rin) 3.5/10/2.5/50% vs B(cg) 3.5/10/3/80% → tie (both miss LiveMigrationService + MigrateInstance jobs)
- P2 backup schedule: A(cg) 5/10/5/45% vs B(rin) 3.5/10/3.5/55% → A (cg)
- P3 VNC console: A(rin) 1/10/0.5/95% vs B(cg) 2/10/1.5/90% → B (cg)
- P4 deploy IP/disk/plan: A(cg) 3.5/10/2.5/70% vs B(rin) 2/10/1.5/90% → A (cg)
- Net codegraph 3 + 1 tie; hallucination 10/10 everywhere; both miss orchestration services/jobs

## ultrafast-coder (ses_e3c642d86ffeqjRH026PymA6or)
- P1 live migration: A(rin) 4/10/3/40% vs B(cg) 2/9/1/95% → A (rin)
- P2 backup schedule: A(cg) 5/10/4/40% vs B(rin) 2/9/1/90% → A (cg) — rin trapped by same-named Services/Backup/BackupService (master snapshots) for instance backups
- P3 VNC: A(rin) 1/10/1/100% vs B(cg) 2/10/1/97% → B (cg) marginal — rin all test-harness bytes
- P4 deploy: A(cg) 2/10/2/94% vs B(rin) 2/10/2/89% → tie
- Net codegraph 2, rinnegan 1, tie 1; neither builds call chains; no entry-point anchoring

## minimax (ses_e3c642d88ffeCrGaDIy3iQcaGP)
- P1 live migration: A(rin) 4/10/3/45% vs B(cg) 4/10/3/78% → A (rin) narrow
- P2 backup schedule: A(cg) 4/10/3/55% vs B(rin) 3/10/2/70% → A (cg) — rin anchored on wrong subsystem (Services/Backup/BackupService = master backups)
- P3 VNC: A(rin) 2/10/1/88% vs B(cg) 3/10/2/88% → B (cg) — rin 100% test-harness
- P4 deploy alloc: A(cg) 2/10/1/90% vs B(rin) 4/10/3/58% → B (rin)
- Net rinnegan 2, codegraph 2; all citations verified exact both tools

## glm (ses_e3c642d8fffehDvFrXLzW9zeIY)
- P1: A(rin) 4/10/2/40% vs B(cg) 3.5/10/2.5/78% → A (rin) narrow
- P2: A(cg) 4/10/2.5/70% vs B(rin) 3.5/10/2/62% → A (cg) narrow — rin again anchored on master self-backup
- P3: A(rin) 1.5/10/0.5/92% vs B(cg) 2/10/1/93% → B (cg) marginal
- P4: A(cg) 1.5/10/1/90% vs B(rin) 3.5/10/2/65% → B (rin) clear
- Net 2-2; zero fabrication; neither finds true entry points (models-bias, keyword collisions)

# MASTER BATCH NET (4 judges): P1 rin 3 (1 tie) · P2 cg 4-0 · P3 cg 4-0 · P4 rin 2, cg 1, tie 1

## deepseek (Master 5-7, ses_e3c1d1847ffei1nArl74SULPJ3)
- P5 CS billing suspend: A(rin) 6/10/5/45% vs B(cg) 4/8/3/88% → A (rin) — rin shows real chargeHours/processUserCharges chain
- P6 rDNS PowerDNS: A(cg) 2/9/1/95% vs B(rin) 6/10/4/55% → B (rin) — rin surfaces ReverseDns support + setRdnsFromArray entry
- P7 S3 bandwidth: A(rin) 6/10/4/35% vs B(cg) 2/9/1/92% → A (rin) — rin hits BandwidthSuspender::applyAccessChange
- Net rinnegan 3-0; wrong-subsystem retrieval on both sides

## ultrafast-coder (Master 5-7, ses_e3c1d1842ffe0d5K8ApQwaBPCI)
- P5: A(rin) 4/9/3/70% vs B(cg) 3/10/2/95% → A (rin)
- P6: A(cg) 1/10/1/95% vs B(rin) 4/10/2/75% → B (rin) — rin lands on setRdns entry + ReverseDns
- P7: A(rin) 5/10/4/70% vs B(cg) 1/10/0/97% → A (rin) — rin only tool finding BandwidthSuspender
- Net rinnegan 3-0; 0 hallucinations both; both miss decisive symbols (applyBalancePolicy, updatePtrRecord, shouldBeSuspended)

## minimax (Master 5-7, ses_e3c1d1843ffeplBIM0NlY0Scdz)
- P5: A(rin) 6/9/5/80% vs B(cg) 5/9/4/91% → A (rin) narrow
- P6: A(cg) 3/9/2/96% vs B(rin) 7/9/6/65% → B (rin) clear
- P7: A(rin) 8/9/6/78% vs B(cg) 3/9/2/94% → A (rin) clear
- Net rinnegan 3-0

## glm (Master 5-7, ses_e3c1d1849ffdLZtXY4q1V2QT3i)
- P5: A(rin) 4/9/3/70% vs B(cg) 5/9/4.5/85% → B (cg) narrow — edges name applyBalancePolicy/SuspendInstances spine
- P6: A(cg) 3/9/2/88% vs B(rin) 5/9/3.5/55% → B (rin)
- P7: A(rin) 6/9/4/65% vs B(cg) 1.5/8/1/92% → A (rin) decisive
- Net rinnegan 2, codegraph 1

# ================= FINAL NETS =================
SLAVE:  P1 rin 4-0 · P2 rin 4-0 · P3 rin 4-0 · P4 2-2  → rinnegan 14, codegraph 2
MASTER: P1 rin 3 + 1 tie · P2 cg 4-0 · P3 cg 4-0 · P4 rin 2, cg 1, 1 tie · P5 rin 3, cg 1 · P6 rin 4-0 · P7 rin 4-0 → rinnegan 16, codegraph 9, ties 2
GRAND (44 blind judgments, 4 judges x 11 queries): rinnegan 30 · codegraph 11 · ties 3
