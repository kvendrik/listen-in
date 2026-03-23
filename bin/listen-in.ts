#!/usr/bin/env bun

import { Command } from "commander";
import { join, resolve } from "node:path";
import { listen, start, summarize, doctor, OLLAMA_MODEL } from "../src";
import { description, version } from "../package.json";
import * as p from "@clack/prompts";
import * as fs from "node:fs";

const program = new Command("listenin")
  .description(description)
  .version(version)
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
  .action(() => {
    console.error(
      "Config is not implemented yet. For now, use environment variables like WHISPER_LANG, WHISPER_PORT, WHISPER_USE_VAD, WHISPER_BATCH_INFERENCE (GPU), and WHISPER_FW_MODEL.",
    );
    process.exit(1);
  });

program
  .command("clean")
  .description("Clean a transcript markdown file using the local LLM")
  .argument("<path>", "Path to a transcript .md file")
  .option("-o, --output <path>", "Output path. <path>.clean.md by default")
  .action(async (path: string, options: { output: string }) => {
    await cleanTranscript(
      path,
      options.output ? resolve(options.output) : undefined,
    );
  });

await program.parseAsync(process.argv);

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

      await cleanTranscript(outputFile, cleanVersionPath);
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
  const cleanedTranscript = await summarize(resolvedPath);

  fs.writeFileSync(cleanVersionPath, cleanedTranscript);

  spinner.stop(`Ready at ${cleanVersionPath}`);
}
