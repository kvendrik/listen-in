#!/usr/bin/env bun

import { Command } from "commander";
import { join, resolve } from "node:path";
import { listen, start, summarize, doctor, getConfig } from "../src";
import { description, version } from "../package.json";
import * as p from "@clack/prompts";
import * as fs from "node:fs";

const config = getConfig();

const program = new Command("listenin")
  .description(description)
  .version(version);

program
  .command("transcribe")
  .description("Transcribe a meeting")
  .action(async () => {
    await startSession();
  });

program
  .command("doctor")
  .description("Check local dependencies and audio setup")
  .action(async () => {
    await doctor();
  });

program
  .command("config")
  .description("Configure defaults like model and output location")
  .action(async () => {
    console.log(config.get());
  })
  .addCommand(
    new Command("set")
      .description("Configure the LLM model")
      .argument("<key>", "The LLM model to use")
      .argument("<value>", "The LLM model to use")
      .action(async ({ key, value }: { key: string; value: string }) => {
        if (!(config.get() as any)[key]) {
          console.error(`Invalid key: ${key}`);
          process.exit(1);
        }
        config.set(key as any, value);
        console.log(`"${key}" set to "${value}"`);
      }),
  );

program
  .command("last")
  .description("Get the last transcript")
  .action(async () => {
    const lastTranscript = getLastTranscript();
    if (!lastTranscript) {
      console.log(`No transcripts found at ${config.get().outputDir}`);
      process.exit(1);
    }
    console.log(lastTranscript);
  });

program
  .command("clean")
  .description("Clean a transcript markdown file using the local LLM")
  .argument("<path>", "Path to a transcript .md file")
  .option("-o, --output [path]", "Output path. <path>.clean.md by default")
  .action(
    async (path: string, options: { output?: string; model?: string }) => {
      if (path === "last") {
        const lastTranscript = getLastTranscript();
        if (!lastTranscript) {
          console.log(`No transcripts found at ${config.get().outputDir}`);
          process.exit(1);
        }
        path = lastTranscript;
      }

      if (!fs.existsSync(path)) {
        console.log(`File does not exist: ${path}`);
        process.exit(1);
      }

      await cleanTranscript(
        path,
        options.output ? resolve(options.output) : undefined,
      );
    },
  );

await program.parseAsync(process.argv);

function getLastTranscript(): string | null {
  const outputDir = config.get().outputDir;

  if (!fs.existsSync(outputDir)) {
    return null;
  }

  const byMtime = fs.readdirSync(outputDir).flatMap((name) => {
    const full = join(outputDir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) return [];
      return [{ name, mtime: st.mtimeMs }];
    } catch {
      return [];
    }
  });

  byMtime.sort((a, b) => b.mtime - a.mtime);
  const lastTranscript = byMtime[0]?.name;

  return lastTranscript ? join(outputDir, lastTranscript) : null;
}

async function startSession(): Promise<void> {
  const { shutdown } = await start();

  const outputDir = join(process.cwd(), ".transcripts");
  fs.mkdirSync(outputDir, { recursive: true });

  const outputFile = join(outputDir, `${filenameDate(new Date())}.md`);
  const cleanVersionPath = outputFile.replace(/\.md$/, ".clean.md");

  if (fs.existsSync(cleanVersionPath)) {
    p.log.error(`File already exists: ${cleanVersionPath}`);
    process.exit(1);
  }

  const { stop } = await listen({
    outputFile,
  });

  let stopping = false;

  // Sync handler: async listeners don’t reliably block shutdown; second Ctrl+C forces exit.
  process.on("SIGINT", () => {
    if (stopping) {
      console.log("\nForce exit.");
      process.exit(1);
    }

    stopping = true;
    console.log(
      "\nStopping microphone/speakers — waiting for in-flight transcription to finish (Ctrl-C again to force quit).",
    );

    void (async () => {
      try {
        await stop();
        await shutdown();
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }

      process.exit(0);
    })();
  });
}

function filenameDate(d: Date): string {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
}

async function cleanTranscript(
  transcriptMdPath: string,
  outputPath?: string,
): Promise<void> {
  const spinner = p.spinner();
  spinner.start(`Cleaning up transcript..`);

  const cleanVersionPath =
    outputPath ?? transcriptMdPath.replace(/\.md$/, ".clean.md");

  if (fs.existsSync(cleanVersionPath)) {
    spinner.error(
      `File already exists: ${cleanVersionPath}. Use -o to specify a different output path.`,
    );
    process.exit(0);
  }

  const resolvedPath = resolve(transcriptMdPath);
  const cleanedTranscript = await summarize(resolvedPath, config.get().llm);

  fs.writeFileSync(cleanVersionPath, cleanedTranscript);

  spinner.stop(`Ready at ${cleanVersionPath}`);
}
