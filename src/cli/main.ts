import { Command } from "commander";
import { Rinnegan } from "../index.js";
import { VERSION } from "../version.js";

type Out = (s: string) => void;

function openIndexed(root: string): Rinnegan {
  return Rinnegan.open(root);
}

async function ensureIndexed(vx: Rinnegan): Promise<void> {
  if (vx.stats().nodes === 0) await vx.indexAll();
}

/** Build the commander program. `out` and `cwd` are injectable for testing. */
export function buildProgram(out: Out, cwd: string): Command {
  const program = new Command();
  program.name("rinnegan").description("Verifiable code-knowledge engine").version(VERSION);
  program.option("--json", "machine-readable JSON output (for agents/scripts)");
  program.option("-C, --root <dir>", "project root to operate on (default: cwd)");
  const json = () => !!program.opts().json;
  const dir = (): string => (program.opts().root as string | undefined) ?? cwd;

  program
    .command("index [path]")
    .description("Build/update the index")
    .action(async (path?: string) => {
      const vx = Rinnegan.open(path ?? dir());
      const stats = await vx.indexAll();
      out(json() ? JSON.stringify(stats) : `Indexed ${stats.parsed} file(s), ${stats.nodes} nodes, ${stats.edges} edges (${stats.skipped} unchanged).`);
      vx.close();
    });

  program
    .command("status")
    .description("Show index statistics")
    .action(() => {
      const vx = Rinnegan.open(dir());
      const s = vx.stats();
      out(json() ? JSON.stringify(s) : `nodes=${s.nodes} edges=${s.edges} files=${s.files}`);
      vx.close();
    });

  program
    .command("understand <task...>")
    .description("Return the minimal, provenance-tagged signal slice for a task")
    .option("-b, --budget <n>", "token budget", "6000")
    .action(async (task: string[], opts: { budget: string }) => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      const res = vx.understand(task.join(" "), { tokenBudget: Number(opts.budget) });
      out(json() ? JSON.stringify({ tokensEstimate: res.tokensEstimate, anchors: res.anchors, text: res.text }) : res.text);
      vx.close();
    });

  program
    .command("search <query...>")
    .description("Symbol search (FTS/BM25)")
    .action(async (query: string[]) => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      const hits = vx.search(query.join(" "), 20);
      out(json() ? JSON.stringify(hits) : hits.map((n) => `${n.filePath}:${n.startLine}  ${n.qualifiedName}  [${n.kind}]`).join("\n"));
      vx.close();
    });

  program
    .command("deps <file>")
    .description("File-scoped dependency query")
    .action(async (file: string) => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      const d = vx.deps(file);
      out(json() ? JSON.stringify(d) : d.dependencies.map((x) => `${x.name}  [${x.provenance}/${x.kind}]`).join("\n") || "(none)");
      vx.close();
    });

  program
    .command("refs <symbol>")
    .description("References to a symbol")
    .option("--write", "writes only")
    .option("--read", "reads only")
    .action(async (symbol: string, opts: { write?: boolean; read?: boolean }) => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      const rw = opts.write ? "write" : opts.read ? "read" : undefined;
      const refs = vx.refs(symbol, rw ? { readWrite: rw } : {});
      out(json() ? JSON.stringify(refs) : refs.map((e) => `${e.line}  ${e.readWrite}  <- ${vx.resolveSymbol(symbol)?.qualifiedName ?? symbol}`).join("\n") || "(none)");
      vx.close();
    });

  program
    .command("callers <symbol>")
    .description("Functions that call a symbol")
    .action(async (symbol: string) => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      const c = vx.callers(symbol);
      out(json() ? JSON.stringify(c) : c.map((n) => `${n.filePath}:${n.startLine}  ${n.qualifiedName}`).join("\n") || "(none)");
      vx.close();
    });

  program
    .command("impact <symbol>")
    .description("Blast radius of changing a symbol")
    .action(async (symbol: string) => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      const i = vx.impact(symbol);
      out(json() ? JSON.stringify(i) : i.map((n) => `${n.filePath}:${n.startLine}  ${n.qualifiedName}`).join("\n") || "(none)");
      vx.close();
    });

  program
    .command("watch")
    .description("Index, then keep the index live as files change")
    .action(async () => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      out("Watching for changes (Ctrl-C to stop)...");
      vx.watch((e) => out(`${e.result}: ${e.path}`));
      await new Promise(() => {}); // run until interrupted
    });

  program
    .command("install [agent]")
    .description("Print MCP config to connect Rinnegan to a coding agent (claude-code, cursor, codex, kiro, pi, windsurf, gemini)")
    .action(async (agent?: string) => {
      const { renderInstall } = await import("../mcp/install.js");
      // prefer a global `rinnegan` binary; fall back to this entry's absolute path
      const cmd = process.env.RINNEGAN_BIN ?? "rinnegan";
      out(renderInstall(agent, cmd, ["mcp"]));
    });

  program
    .command("mcp")
    .description("Start the MCP server over stdio (single 'understand' tool)")
    .action(async () => {
      const { runMcp } = await import("../mcp/server.js");
      await runMcp(dir());
    });

  return program;
}

/** Run the CLI. Returns when the chosen command completes. */
export async function runCli(argv: string[], out: Out = console.log, cwd: string = process.cwd()): Promise<void> {
  await buildProgram(out, cwd).parseAsync(argv, { from: "user" });
}

// Entry when executed directly.
const invokedDirectly = process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js") || process.argv[1]?.endsWith("rinnegan.js");
if (invokedDirectly) {
  runCli(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
