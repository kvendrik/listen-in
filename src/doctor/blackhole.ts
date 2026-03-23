#!/usr/bin/env bun

/**
 * blackhole.ts — verify BlackHole 2ch is correctly wired as system audio output
 *
 * Plays a short tone through the system output and records from BlackHole
 * simultaneously. If BlackHole captures the signal, the wiring is correct.
 *
 * Usage:
 *   bun blackhole.ts
 *
 * Prerequisites:
 *   brew install ffmpeg blackhole-2ch
 *
 * BlackHole wiring (if this script fails):
 *   1. Open Audio MIDI Setup
 *   2. Click + → Create Multi-Output Device
 *      ✓ BlackHole 2ch  ✓ your speakers/headphones
 *   3. System Settings → Sound → Output → set to that Multi-Output Device
 */

import * as p from "@clack/prompts";
import { spawn } from "bun";

const TONE_FILE = "/tmp/bh-tone.wav";
const CAPTURE_FILE = "/tmp/bh-capture.wav";
const SILENCE_DB = -60; // anything below this is treated as silence

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findBlackHoleIndex(): Promise<string | null> {
  const proc = spawn(
    ["ffmpeg", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
    { stdout: "ignore", stderr: "pipe" },
  );
  const text = await new Response(proc.stderr).text();

  let inAudio = false;
  for (const line of text.split("\n")) {
    if (line.includes("AVFoundation audio devices")) {
      inAudio = true;
      continue;
    }
    if (!inAudio) continue;
    const m = line.match(/\[(\d+)\]\s+(.+)/);
    if (m?.[1] && m?.[2] && m[2].toLowerCase().includes("blackhole"))
      return m[1];
  }
  return null;
}

async function measureDb(file: string): Promise<number> {
  const proc = spawn(
    ["ffmpeg", "-i", file, "-filter:a", "volumedetect", "-f", "null", "-"],
    { stdout: "ignore", stderr: "pipe" },
  );
  const text = await new Response(proc.stderr).text();
  await proc.exited;
  const m = text.match(/mean_volume:\s*([-\d.]+)\s*dB/);
  return m?.[1] ? parseFloat(m[1]) : -91;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function checkBlackHole(): Promise<boolean> {
  // 1. Find BlackHole
  const spinner = p.spinner();
  spinner.start("Checking BlackHole");

  const index = await findBlackHoleIndex();

  if (!index) {
    spinner.stop("BlackHole not found");
    p.log.error("BlackHole 2ch is not installed or not visible to ffmpeg.");
    p.log.info("Install it:  brew install blackhole-2ch  (then restart)");
    process.exit(1);
  }

  spinner.stop(`Found BlackHole device`);

  // 2. Confirm with user before making noise
  const confirmed = await p.confirm({
    message:
      "This test plays a low frequency tone through your speakers for ~1 second. Ready?",
    initialValue: true,
  });

  spinner.start("Testing playback capture");

  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  await spawn(
    [
      "ffmpeg",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:duration=1",
      TONE_FILE,
    ],
    { stdout: "ignore", stderr: "ignore" },
  ).exited;

  const record = spawn(
    [
      "ffmpeg",
      "-y",
      "-f",
      "avfoundation",
      "-i",
      `:${index}`,
      "-t",
      "1.5",
      CAPTURE_FILE,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  // Brief pause so the recorder is fully initialised before playback starts.
  await Bun.sleep(200);
  await spawn(["afplay", TONE_FILE], { stdout: "ignore", stderr: "ignore" })
    .exited;
  await record.exited;

  const db = await measureDb(CAPTURE_FILE);

  // 6. Result
  if (db > SILENCE_DB) {
    spinner.stop(
      `✓ BlackHole is wired correctly (${db.toFixed(1)} dB detected)`,
    );
    return true;
  } else {
    spinner.stop(
      `Only ${db.toFixed(1)} dB captured — BlackHole is not receiving system audio.`,
    );
    p.note(
      "1. Open Audio MIDI Setup (Spotlight → 'Audio MIDI Setup')\n" +
        "2. Click + → Create Multi-Output Device\n" +
        "   ✓ BlackHole 2ch\n" +
        "   ✓ Your speakers or headphones\n" +
        "3. System Settings → Sound → Output\n" +
        "   → Select that Multi-Output Device",
      "How to fix",
    );
    p.log.error("Re-run this script after completing the steps above.");
    return false;
  }
}
