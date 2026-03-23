import path from "node:path";
import { checkBlackHole } from "./blackhole";
import {
  assertOllamaModelPresent,
  ensureOllamaServe,
  OLLAMA_MODEL,
} from "../summarize/ollama-local.ts";
import { prompt } from "../summarize/summarize";
import { spawn } from "bun";
import * as p from "@clack/prompts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

function indentLogBody(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => (line === "" ? "" : `    ${line}`))
    .join("\n");
}

async function checkDependencies(): Promise<void> {
  type DepCheck = {
    name: string;
    check: () => boolean | Promise<boolean>;
    fix: string;
    fatal: boolean;
  };

  const checks: DepCheck[] = [
    {
      name: "ffmpeg",
      check: () => commandExists("ffmpeg", ["-version"]),
      fix: "brew install ffmpeg",
      fatal: true,
    },
    {
      name: "uv",
      check: () => commandExists("uv", ["--version"]),
      fix: "https://github.com/astral-sh/uv",
      fatal: true,
    },
    {
      name: "whisper-live",
      check: () => pythonPackageExists("whisper_live"),
      fix: "From the repo root:\n  uv sync",
      fatal: true,
    },
  ];

  if (process.platform !== "darwin") {
    throw new Error("Only macOS is supported");
  }

  const spinner = p.spinner();
  spinner.start("Checking dependencies");

  const results = await Promise.all(
    checks.map(async (dep) => ({ dep, ok: await dep.check() })),
  );

  //const success = results.filter((r) => r.ok).map((r) => r.dep);

  const failures = results
    .filter((r) => !r.ok && r.dep.fatal)
    .map((r) => r.dep);

  const warnings = results
    .filter((r) => !r.ok && !r.dep.fatal)
    .map((r) => r.dep);

  spinner.stop("Dependencies checked");

  for (const dep of warnings) {
    p.log.warn(`${dep.name} not found:\n${indentLogBody(dep.fix)}`);
  }

  for (const dep of failures) {
    p.log.error(`${dep.name} not found:\n${indentLogBody(dep.fix)}`);
  }

  if (failures.length > 0) {
    p.outro("Install the missing dependencies above and re-run.");
    process.exit(1);
  }

  const blackholeOk = await checkBlackHole();
  if (!blackholeOk) process.exit(1);
}

async function checkOllama(): Promise<void> {
  const spinner = p.spinner();
  spinner.start("Checking Ollama");

  if (!(await commandExists("ollama", ["--version"]))) {
    spinner.stop("Ollama check failed");
    p.log.error(
      `ollama not found:\n${indentLogBody("Install from https://ollama.com or: brew install ollama")}`,
    );
    process.exit(1);
  }

  try {
    const managed = await ensureOllamaServe();
    try {
      await assertOllamaModelPresent(managed.origin, managed.openAiBaseUrl);
      await prompt("Hello, world!");
      //console.log(result);
    } finally {
      await managed.stopIfWeStarted();
    }
    spinner.stop("✓ Qwen2.5 14B ready");
  } catch (e) {
    spinner.stop("Ollama check failed");
    const msg = e instanceof Error ? e.message : String(e);
    p.log.error(
      `${msg}\n${indentLogBody(`Pull the model if needed: ollama pull ${OLLAMA_MODEL}`)}`,
    );
    process.exit(1);
  }
}

export async function doctor() {
  await checkDependencies();
  await checkOllama();

  p.outro(
    "All checks passed. You're ready to transcribe! Run `listenin` to start.",
  );

  process.exit(0);
}

async function commandExists(cmd: string, args: string[]): Promise<boolean> {
  try {
    const proc = spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function pythonPackageExists(pkg: string): Promise<boolean> {
  try {
    const proc = spawn(["uv", "run", "python", "-c", `import ${pkg}`], {
      cwd: REPO_ROOT,
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
