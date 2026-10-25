/**
 * Terminal setup acceptance on Windows (#311): the built CLI in a real
 * Windows console (ConPTY, through node-pty), with a fake native agent behind
 * `codex` and `claude` shims.
 *
 * The POSIX suite (setup-terminal-pty.test.ts) drives a PTY through Python's
 * pty/termios modules, which Windows does not have. This suite covers the
 * same terminal surface there: the tool picker, cancelling, handing the real
 * console to a native agent and getting it back, recovery after a failed
 * agent, and finishing a populated setup through the Hub link.
 *
 * node-pty is not a project dependency, so ordinary installs stay free of a
 * native module; the Windows CI job installs it for this run. Without it the
 * suite is skipped locally and fails in CI, so it cannot vanish silently.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

interface PtyProcess {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  kill(): void;
}
interface PtyModule {
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }): PtyProcess;
}

const repo = fileURLToPath(new URL("..", import.meta.url));
const cli = join(repo, "dist", "cli.js");
const pty = loadPty();
const skipReason = process.platform !== "win32" ? "Windows only; POSIX uses setup-terminal-pty" : pty === null ? "node-pty is not installed" : undefined;
const fixtures: Fixture[] = [];

interface Fixture { root: string; project: string; record: string; env: NodeJS.ProcessEnv }
interface Action { expect: string; regex?: boolean; missing?: string[]; input?: string; probe?: boolean }
interface Result { exitCode: number; output: string; events: Array<{ match: string; connected?: boolean }> }
interface AgentRecord { pid: number; agent: string; argv: string[]; stdinTTY: boolean; stdoutTTY: boolean; promptExists: boolean; input?: string }

beforeAll(() => {
  if (process.platform === "win32" && pty === null && process.env.CI) {
    throw new Error("The Windows CI job must install node-pty (npm install --no-save node-pty) for the ConPTY suite.");
  }
  if (!skipReason && !existsSync(cli)) throw new Error("Build dist/cli.js with npm run build before running the ConPTY acceptance tests.");
});

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    if (existsSync(fixture.record)) {
      const { pid } = agentRecord(fixture);
      try { process.kill(pid); } catch { /* already gone */ }
    }
    try {
      rmSync(fixture.root, { recursive: true, force: true });
    } catch {
      // Windows can briefly keep a just-exited process's files open.
    }
  }
});

describe.skipIf(Boolean(skipReason))(`built terminal setup in a Windows console${skipReason ? ` (${skipReason})` : ""}`, { timeout: 60_000 }, () => {
  it("shows the banner and tool picker before any setup writes, then cancels with Ctrl+C", async () => {
    const f = fixture("incomplete");
    const result = await terminal(f, ["setup", "--mode", "agent-memory", "--no-open"], [
      { expect: "Choose your AI tools", missing: [".mex", ".agents", "AGENTS.md", ".gitignore"], input: "\u0003" },
    ]);
    expect(result.exitCode, result.output).toBe(130);
    expect(result.output).toContain("88888b.d88b.");
    expect(result.output).toContain("Codex");
    expect(result.output).toContain("Setup cancelled.");
    expect(readdirSync(f.project)).toEqual([]);
    expect(existsSync(f.record)).toBe(false);
  });

  it("hands the real console to the native agent, takes keyboard input, and returns to the menu", async () => {
    const f = fixture("incomplete");
    const result = await terminal(f, setupArgs(), [
      { expect: "Choose your AI tools", input: "\r" },
      { expect: "MEX_PTY_CHILD_READY", input: "hello native agent\r" },
      { expect: "required scaffold placeholders remain", input: "\u001b[A" },
      { expect: "> Finish later", input: "\r" },
    ]);
    expect(result.exitCode, result.output).toBe(2);
    expect(result.output).toContain("Opening Codex");
    expect(result.output).toContain("Setup paused at population");
    expect(agentRecord(f)).toMatchObject({ agent: "codex", stdinTTY: true, stdoutTTY: true, promptExists: true, input: "hello native agent" });
    expect(agentRecord(f).argv.join(" ")).toContain("Read the full setup population prompt");
    expect(JSON.parse(readFileSync(join(f.project, ".mex", "config.json"), "utf8")).aiTools).toEqual(["codex"]);
    expectPromptCleaned(f);
  });

  it("returns to recovery after a failed native agent and pauses on Finish later", async () => {
    const f = fixture("failed");
    const result = await terminal(f, setupArgs(), [
      { expect: "Choose your AI tools", input: "\r" },
      { expect: "MEX_PTY_CHILD_READY", input: "finish\r" },
      { expect: "Codex stopped before a clean exit", input: "\u001b[A" },
      { expect: "> Finish later", input: "\r" },
    ]);
    expect(result.exitCode, result.output).toBe(2);
    expect(result.output).toContain("Setup paused at population");
    expect(result.output).toContain("Run `mex setup` to continue");
    expectPromptCleaned(f);
  });

  it("finishes a populated setup and serves the Hub link until q", async () => {
    const f = fixture("complete");
    const result = await terminal(f, setupArgs(), [
      { expect: "Choose your AI tools", input: "\r" },
      { expect: "MEX_PTY_CHILD_READY", input: "populate\r" },
      { expect: "http://127\\.0\\.0\\.1:[0-9]+/#token=[A-Za-z0-9_-]+", regex: true, probe: true, input: "q" },
    ]);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("Continue in your browser");
    expect(result.events[2]!.connected).toBe(true);
    expect(result.output).toContain("Hub stopped");
    const address = new URL(result.events[2]!.match);
    expect(await canConnect(Number(address.port))).toBe(false);
    expect(readFileSync(join(f.project, ".mex", "AGENTS.md"), "utf8")).not.toContain("[YYYY-MM-DD]");
    expectPromptCleaned(f);
  });

  it("keeps --yes plain in a real console: scaffold written, no agent started", async () => {
    const f = fixture("incomplete");
    const result = await terminal(f, ["setup", "--mode", "agent-memory", "--tool", "codex", "--yes", "--no-open"], []);
    expect(result.exitCode, result.output).toBe(2);
    expect(result.output).not.toContain("Choose your AI tools");
    expect(existsSync(join(f.project, ".mex", "AGENTS.md"))).toBe(true);
    expect(existsSync(f.record)).toBe(false);
  });
});

function setupArgs(): string[] {
  return ["setup", "--mode", "agent-memory", "--tool", "codex", "--no-open"];
}

function fixture(mode: "incomplete" | "failed" | "complete"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-conpty-"));
  const project = join(root, "project");
  const bin = join(root, "bin");
  const record = join(root, "agent.json");
  mkdirSync(project);
  mkdirSync(bin);
  const agent = join(root, "agent.cjs");
  writeFileSync(agent, FAKE_AGENT, "utf8");
  // Both launchable agents are fake, including when a selection regression
  // would choose Claude instead of the highlighted Codex integration.
  for (const command of ["codex", "claude"]) {
    writeFileSync(join(bin, `${command}.cmd`), `@"${process.execPath}" "${agent}" ${command} %*\r\n`, "utf8");
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Windows environment names are case-insensitive: replace every PATH spelling.
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = [bin, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter);
  Object.assign(env, { MEX_TELEMETRY: "0", DO_NOT_TRACK: "1", MEX_PTY_FAKE_MODE: mode, MEX_PTY_RECORD: record, MEX_HOME: join(root, "home") });
  delete env.CI;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  const f = { root, project, record, env };
  fixtures.push(f);
  return f;
}

/** Run the CLI in a ConPTY, answering each expected screen with its input. */
function terminal(f: Fixture, args: string[], actions: Action[], options: { columns?: number; rows?: number } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = pty!.spawn(process.execPath, [cli, ...args], {
      name: "xterm-256color", cols: options.columns ?? 140, rows: options.rows ?? 40, cwd: f.project, env: f.env,
    });
    let raw = "";
    let searchFrom = 0;
    let step = 0;
    let busy = false;
    let exitCode: number | null = null;
    const events: Result["events"] = [];
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error(`ConPTY step ${step} timed out waiting for ${JSON.stringify(actions[step]?.expect ?? "exit")}\n${plain(raw).slice(-4000)}`));
    }, 50_000);
    const finish = (): void => {
      clearTimeout(deadline);
      resolve({ exitCode: exitCode!, output: plain(raw), events });
    };
    const advance = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        while (step < actions.length) {
          const action = actions[step]!;
          const text = plain(raw).slice(searchFrom);
          const match = action.regex ? new RegExp(action.expect, "u").exec(text)?.[0] : text.includes(action.expect) ? action.expect : undefined;
          if (match === undefined) return;
          searchFrom += text.indexOf(match) + match.length;
          for (const path of action.missing ?? []) {
            if (existsSync(join(f.project, path))) throw new Error(`${path} exists before the screen that should precede any write`);
          }
          const event: Result["events"][number] = { match };
          if (action.probe) event.connected = await canConnect(Number(new URL(match).port));
          events.push(event);
          step += 1;
          if (action.input !== undefined) child.write(action.input);
        }
        if (exitCode !== null) finish();
      } catch (error) {
        clearTimeout(deadline);
        child.kill();
        reject(error);
      } finally {
        busy = false;
      }
    };
    child.onData((data) => {
      raw += data;
      void advance();
    });
    child.onExit(({ exitCode: code }) => {
      exitCode = code;
      if (step >= actions.length) finish();
      else {
        // Output can still be draining; give the matcher one last pass.
        void advance().then(() => {
          if (step < actions.length) {
            clearTimeout(deadline);
            reject(new Error(`CLI exited ${code} before ${JSON.stringify(actions[step]!.expect)}\n${plain(raw).slice(-4000)}`));
          }
        });
      }
    });
  });
}

/** Console output as text: VT sequences removed, line endings normalized. */
function plain(raw: string): string {
  return raw
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[@-Z\\-_]/gu, "")
    .replace(/\r\n?/gu, "\n");
}

function loadPty(): PtyModule | null {
  if (process.platform !== "win32") return null;
  try {
    return createRequire(import.meta.url)("node-pty") as PtyModule;
  } catch {
    return null;
  }
}

function agentRecord(f: Fixture): AgentRecord {
  return JSON.parse(readFileSync(f.record, "utf8")) as AgentRecord;
}

function expectPromptCleaned(f: Fixture): void {
  const local = join(f.project, ".mex", "local");
  expect(existsSync(local) ? readdirSync(local).filter((name) => name.startsWith("setup-population-")) : []).toEqual([]);
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (connected: boolean): void => { socket.destroy(); resolve(connected); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}


/** The fake native agent: plain Node, so it runs wherever the CLI does. */
const FAKE_AGENT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const target = process.env.MEX_PTY_RECORD;
const mode = process.env.MEX_PTY_FAKE_MODE;
const args = process.argv.slice(3);
const pointer = /\x60([^\x60]+prompt\.md)\x60/u.exec(args.join(" "));
const record = {
  pid: process.pid, agent: process.argv[2], argv: args,
  stdinTTY: Boolean(process.stdin.isTTY), stdoutTTY: Boolean(process.stdout.isTTY),
  promptExists: Boolean(pointer && fs.existsSync(pointer[1])),
};
fs.writeFileSync(target, JSON.stringify(record));
process.stdout.write("MEX_PTY_CHILD_READY\n");
let line = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  line += chunk;
  const end = line.search(/\r|\n/u);
  if (end < 0) return;
  record.input = line.slice(0, end);
  fs.writeFileSync(target, JSON.stringify(record));
  if (mode === "complete") {
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith(".md")) {
          const text = fs.readFileSync(file, "utf8");
          const next = text.replaceAll("[Project Name]", "PTY fixture").replaceAll("[Agent / Workspace Name]", "PTY fixture").replaceAll("[YYYY-MM-DD]", "2026-01-01");
          if (next !== text) fs.writeFileSync(file, next);
        }
      }
    };
    walk(".mex");
  }
  process.stdout.write("MEX_PTY_CHILD_DONE\n");
  process.exit(mode === "failed" ? 7 : 0);
});
`;
