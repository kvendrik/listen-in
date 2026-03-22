#!/usr/bin/env bun

/**
 * transcribe.ts — live meeting transcription via whisper-live
 *
 * Two separate audio streams → two WebSocket connections → speaker-tagged output.
 *   **Microphone:** segments from your microphone
 *   **Speakers:**   segments from system audio (BlackHole)
 *
 * API:
 *   const { shutdown } = await start();
 *   const { stop } = listen({ outputFile: "meeting.md" });
 *   await stop();
 *   await shutdown();
 *
 * One-time setup:
 *   bun add nanoid @clack/prompts
 *   brew install ffmpeg blackhole-2ch
 *   pip install whisper-live
 *
 * BlackHole wiring (one-time):
 *   Audio MIDI Setup → + → Create Multi-Output Device
 *     ✓ BlackHole 2ch  ✓ Your speakers
 *   System Settings → Sound → Output → that Multi-Output Device
 */

import { nanoid } from "nanoid";
import * as p from "@clack/prompts";
import { spawn, type Subprocess } from "bun";
import * as fs from "node:fs";
import { name, version } from "./package.json";

// ── Config ────────────────────────────────────────────────────────────────────

const WHISPER_PORT = Number(process.env["WHISPER_PORT"] ?? 9090);
const SERVER_URL =
  process.env["WHISPER_SERVER"] ?? `ws://localhost:${WHISPER_PORT}`;
const MODEL_ENV = process.env["WHISPER_MODEL"] ?? "";
const LANGUAGE = process.env["WHISPER_LANG"] ?? "en";

const SAMPLE_RATE = 16_000;
const CHUNK_MS = 500;
const CHUNK_BYTES = (SAMPLE_RATE * 4 * CHUNK_MS) / 1000; // float32 mono

// ── Public types ──────────────────────────────────────────────────────────────

export type StartResult = { shutdown: () => Promise<void> };
export type ListenOptions = { outputFile: string };
export type ListenResult = { stop: () => Promise<void> };

// ── Internal types ────────────────────────────────────────────────────────────

type AudioDevice = { index: string; label: string };

/** True if ffmpeg’s device label is BlackHole (handles spacing / wording variants). */
function labelLooksLikeBlackHole(label: string): boolean {
  const compact = label.toLowerCase().replace(/\s+/g, "");
  return compact.includes("blackhole") || /\bblack\s*hole\b/i.test(label);
}

type CaptureMode =
  | { kind: "single"; device: string }
  | { kind: "dual"; mic: string; system: string };

type StreamOptions = {
  audioArgs: string[]; // ffmpeg input + output args
  model: string;
  onCompleted: (text: string) => void;
  onPending: (text: string | null) => void;
};

type Stream = { stop: () => Promise<void> };

// ── Module state ──────────────────────────────────────────────────────────────

let _ctx: { model: string; captureMode: CaptureMode } | null = null;

// ── Dependency checks ─────────────────────────────────────────────────────────

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
    const proc = spawn(["python3", "-c", `import ${pkg}`], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
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
      name: "python3",
      check: () => commandExists("python3", ["--version"]),
      fix: "brew install python",
      fatal: true,
    },
    {
      name: "whisper-live",
      check: () => pythonPackageExists("whisper_live"),
      fix: "pip install whisper-live",
      fatal: true,
    },
  ];

  if (process.platform !== "darwin") {
    throw new Error("Only macOS is supported");
  }

  checks.push({
    name: "BlackHole 2ch",
    check: async () => {
      const { devices, rawStderr } = await getDarwinAvFoundationProbe();
      if (devices.some((d) => labelLooksLikeBlackHole(d.label))) return true;
      const raw = rawStderr.toLowerCase();
      return raw.includes("blackhole") || raw.includes("black hole");
    },
    fix:
      "brew install blackhole-2ch, open Audio MIDI Setup to confirm “BlackHole 2ch” appears, " +
      "then set Sound output to a Multi-Output Device that includes BlackHole + your speakers (see transcribe.ts header).",
    fatal: true,
  });

  const spinner = p.spinner();
  spinner.start("Checking dependencies");

  const results = await Promise.all(
    checks.map(async (dep) => ({ dep, ok: await dep.check() })),
  );
  const failures = results
    .filter((r) => !r.ok && r.dep.fatal)
    .map((r) => r.dep);
  const warnings = results
    .filter((r) => !r.ok && !r.dep.fatal)
    .map((r) => r.dep);

  spinner.stop("Dependencies checked");

  for (const dep of warnings)
    p.log.warn(`${dep.name} not found\n  → ${dep.fix}`);
  for (const dep of failures)
    p.log.error(`${dep.name} not found\n  → ${dep.fix}`);

  if (failures.length > 0) {
    p.outro("Install the missing dependencies above and re-run.");
    process.exit(1);
  }
}

// ── Whisper server ────────────────────────────────────────────────────────────

async function pollPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const conn = await Bun.connect({
        hostname: "localhost",
        port,
        socket: { data() {}, open() {}, close() {}, error() {} },
      });
      conn.end();
      return true;
    } catch {
      await Bun.sleep(300);
    }
  }
  return false;
}

async function startWhisperServer(): Promise<Subprocess | null> {
  const alreadyUp = await pollPort(WHISPER_PORT, 500);
  if (alreadyUp) {
    p.log.info(
      `Whisper server already running on :${WHISPER_PORT} — will use it.`,
    );
    return null;
  }

  const spinner = p.spinner();
  spinner.start("Starting whisper-live server");

  const server = spawn(
    ["python3", "-m", "whisper_live.server", "--port", String(WHISPER_PORT)],
    { stdout: "ignore", stderr: "ignore" },
  );

  // Guaranteed cleanup regardless of how the process exits (cancel, crash, normal).
  // Only registered when we own the server, not when reusing an external one.
  process.on("exit", () => {
    try {
      server.kill();
    } catch {
      /* already dead */
    }
  });

  const ready = await pollPort(WHISPER_PORT, 60_000);
  if (!ready) {
    spinner.stop("Server failed to start");
    server.kill();
    p.log.error(
      "whisper-live did not come up within 60 s.\n" +
        "Run manually to debug: python3 -m whisper_live.server",
    );
    process.exit(1);
  }

  spinner.stop("Whisper server ready");
  return server;
}

// ── Audio device discovery ────────────────────────────────────────────────────

function parseAvFoundationAudioDevices(stderr: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  let inAudio = false;
  for (const line of stderr.split("\n")) {
    if (line.includes("AVFoundation audio devices")) {
      inAudio = true;
      continue;
    }
    if (!inAudio) continue;
    const m = line.match(/\[(\d+)\]\s+(.+)/);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      devices.push({ index: m[1], label: m[2].trim() });
    }
  }
  return devices;
}

/** One ffmpeg probe per process — reused by dependency check and device prompts. */
let darwinAvfoundationProbeOnce: Promise<{
  devices: AudioDevice[];
  rawStderr: string;
}> | null = null;

async function getDarwinAvFoundationProbe(): Promise<{
  devices: AudioDevice[];
  rawStderr: string;
}> {
  if (!darwinAvfoundationProbeOnce) {
    darwinAvfoundationProbeOnce = (async () => {
      const proc = spawn(
        ["ffmpeg", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
        { stdout: "ignore", stderr: "pipe" },
      );
      const rawStderr = await new Response(proc.stderr).text();
      await proc.exited;
      return {
        devices: parseAvFoundationAudioDevices(rawStderr),
        rawStderr,
      };
    })();
  }
  return darwinAvfoundationProbeOnce;
}

async function listDevices(): Promise<AudioDevice[]> {
  switch (process.platform) {
    case "darwin":
      return (await getDarwinAvFoundationProbe()).devices;
    case "linux": {
      const proc = spawn(["pactl", "list", "sources", "short"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const text = await new Response(proc.stdout).text();
      return text
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          const [index, label] = line.split("\t");
          if (index === undefined || index === "") return [];
          return [{ index, label: label ?? `source ${index}` }];
        });
    }
    default:
      return [];
  }
}

// ── ffmpeg helpers ────────────────────────────────────────────────────────────

function platformInput(device: string): string[] {
  switch (process.platform) {
    case "darwin":
      return ["-f", "avfoundation", "-i", `:${device}`];
    case "linux":
      return ["-f", "pulse", "-i", device];
    default:
      return ["-f", "dshow", "-i", `audio=${device}`];
  }
}

// Returns the full ffmpeg argument list for a single audio source.
// Named `captureArgs` to avoid confusion with the `audioArgs` field on StreamOptions.
function captureArgs(device: string): string[] {
  return [
    ...platformInput(device),
    "-ar",
    String(SAMPLE_RATE),
    "-ac",
    "1",
    "-f",
    "f32le",
    "pipe:1",
  ];
}

// ── Prompts ───────────────────────────────────────────────────────────────────

// Unwraps a clack prompt result, exiting cleanly if the user cancelled.
function cancelOn<T>(val: T | symbol): T {
  if (p.isCancel(val)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  return val as T;
}

async function promptCaptureMode(devices: AudioDevice[]): Promise<CaptureMode> {
  const micIndex =
    devices.length === 0
      ? cancelOn(
          await p.text({
            message: "Microphone device",
            placeholder: "default",
          }),
        )
      : cancelOn(
          await p.select({
            message: "Microphone (you)",
            options: devices
              .filter((d) => !labelLooksLikeBlackHole(d.label))
              .map((d) => ({ value: d.index, label: d.label })),
          }),
        );

  const wantSystem = cancelOn(
    await p.confirm({
      message: "Also capture system audio? (tags other speakers separately)",
      initialValue: true,
    }),
  );
  if (!wantSystem) return { kind: "single", device: micIndex };

  // Auto-detect BlackHole by name.
  const blackhole = devices.find((d) => labelLooksLikeBlackHole(d.label));
  if (blackhole) {
    p.log.info(`Auto-detected: ${blackhole.label} (index ${blackhole.index})`);
    return { kind: "dual", mic: micIndex, system: blackhole.index };
  }

  // BlackHole not found — prompt the user to pick or type a device.
  p.log.warn("BlackHole not found — install with: brew install blackhole-2ch");

  const systemDevice =
    devices.length === 0
      ? cancelOn(
          await p.text({
            message: "System audio device name",
            placeholder: "BlackHole 2ch",
          }),
        )
      : cancelOn(
          await p.select({
            message: "System audio device (BlackHole or equivalent)",
            options: devices
              .filter((d) => d.index !== micIndex)
              .map((d) => ({ value: d.index, label: d.label })),
          }),
        );

  return { kind: "dual", mic: micIndex, system: systemDevice };
}

async function promptModel(): Promise<string> {
  if (MODEL_ENV) return MODEL_ENV;
  return cancelOn(
    await p.select({
      message: "Whisper model",
      options: [
        { value: "tiny", label: "tiny", hint: "fastest, lowest accuracy" },
        { value: "base", label: "base", hint: "fast" },
        { value: "small", label: "small", hint: "good balance (default)" },
        { value: "medium", label: "medium", hint: "slower, better accuracy" },
        {
          value: "large-v3-turbo",
          label: "large-v3-turbo",
          hint: "large quality, faster",
        },
        {
          value: "large-v3",
          label: "large-v3",
          hint: "best accuracy, needs GPU",
        },
      ],
      initialValue: "small",
    }),
  );
}

// ── Transcription stream ──────────────────────────────────────────────────────

async function createStream(opts: StreamOptions): Promise<Stream> {
  // Connect to the whisper-live server and wait for SERVER_READY.
  // The init listener is named and removed on both resolve and reject paths
  // so it cannot fire again on subsequent transcript messages.
  // The socket is explicitly closed on any rejection to avoid leaks.
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(SERVER_URL);

    const onInit = ({ data }: MessageEvent): void => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data as string);
      } catch {
        return;
      }

      if (msg["message"] === "SERVER_READY") {
        socket.removeEventListener("message", onInit);
        resolve(socket);
      } else if (msg["message"] === "DISCONNECT") {
        socket.removeEventListener("message", onInit);
        socket.close();
        reject(new Error("whisper-live: server full"));
      }
    };

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          uid: nanoid(),
          language: LANGUAGE,
          task: "transcribe",
          model: opts.model,
          use_vad: true,
          multilingual: false,
        }),
      );
    });

    socket.addEventListener("message", onInit);
    socket.addEventListener("error", () => {
      socket.close();
      reject(new Error(`Could not connect to ${SERVER_URL}`));
    });
  });

  let completedText = "";
  let pendingText = "";

  const onMessage = ({ data }: MessageEvent): void => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data as string);
    } catch {
      return;
    }

    const segments = msg["segments"] as
      | Array<{ text: string; completed: boolean }>
      | undefined;
    if (!segments?.length) return;

    const newCompleted = segments
      .filter((s) => s.completed)
      .map((s) => s.text.trim())
      .join(" ");
    pendingText = segments
      .filter((s) => !s.completed)
      .map((s) => s.text.trim())
      .join(" ");

    if (newCompleted.length > completedText.length) {
      opts.onCompleted(newCompleted.slice(completedText.length).trim());
      completedText = newCompleted;
    }

    opts.onPending(pendingText || null);
  };

  ws.addEventListener("message", onMessage);

  const ffmpeg = spawn(["ffmpeg", ...opts.audioArgs], {
    stdout: "pipe",
    stderr: "ignore",
  });
  let buf = new Uint8Array(0);

  const captureLoop = (async () => {
    const reader = ffmpeg.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf);
        merged.set(value, buf.length);
        buf = merged;

        while (buf.length >= CHUNK_BYTES && ws.readyState === WebSocket.OPEN) {
          ws.send(buf.slice(0, CHUNK_BYTES));
          buf = buf.slice(CHUNK_BYTES);
        }
      }
    } catch {
      /* ffmpeg ended */
    }
  })();

  const stop = async (): Promise<void> => {
    ffmpeg.kill();
    await captureLoop;
    ws.removeEventListener("message", onMessage);
    // Flush any in-progress segment to the file before closing.
    if (pendingText) {
      opts.onCompleted(pendingText);
      pendingText = "";
    }
    opts.onPending(null);
    ws.close();
  };

  return { stop };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check dependencies, start the whisper-live server if needed,
 * and run setup prompts (mic selection, model).
 *
 * Returns `shutdown()` which tears down the server (if we started it).
 */
export async function start(): Promise<StartResult> {
  p.intro(`🎙  ${name} v${version}`);

  await checkDependencies();
  const whisperServer = await startWhisperServer();
  const devices = await listDevices();
  const captureMode = await promptCaptureMode(devices);
  const model = await promptModel();

  _ctx = { model, captureMode };

  p.log.info(
    captureMode.kind === "dual"
      ? "Two streams active — mic tagged **Microphone:**, system audio tagged **Speakers:**"
      : "Mic only — all speech tagged **Microphone:**",
  );

  const shutdown = async (): Promise<void> => {
    _ctx = null;
    if (whisperServer) {
      whisperServer.kill();
      await whisperServer.exited;
    }
  };

  return { shutdown };
}

/**
 * Start capturing and transcribing. Segments are appended to `outputFile`
 * live as they complete. Returns `stop()` to end the session.
 *
 * Must be called after `start()`.
 */
export function listen({ outputFile }: ListenOptions): ListenResult {
  if (!_ctx) throw new Error("Call start() before listen().");
  const { model, captureMode } = _ctx;

  const fd = fs.openSync(outputFile, "a");
  const startedAt = new Date();

  const append = (text: string): void => {
    try {
      fs.writeSync(fd, text);
    } catch {
      /* best-effort */
    }
  };

  append(
    `# Meeting transcript\n\n_Started: ${startedAt.toLocaleString()}_\n\n`,
  );
  p.log.success(
    `Live transcript → ${outputFile}\nSpeak now — Ctrl-C to stop.\n`,
  );

  // ── Console: dimmed in-progress text for both streams side by side ────────

  const pending = { Microphone: "", Speakers: "" };

  const redraw = (): void => {
    const parts = [
      pending.Microphone ? `Microphone: ${pending.Microphone}` : "",
      pending.Speakers ? `Speakers: ${pending.Speakers}` : "",
    ].filter(Boolean);
    process.stdout.write(`\x1b[2K\r\x1b[2m${parts.join("  |  ")}\x1b[0m`);
  };

  const onCompleted = (speaker: keyof typeof pending, text: string): void => {
    if (!text) return;
    append(`**${speaker}:** ${text}\n\n`);
    process.stdout.write(`\x1b[2K\r\x1b[1m${speaker}:\x1b[0m ${text}\n`);
    pending[speaker] = "";
    redraw();
  };

  const onPending = (
    speaker: keyof typeof pending,
    text: string | null,
  ): void => {
    pending[speaker] = text ?? "";
    redraw();
  };

  // ── Start one or two streams depending on capture mode ───────────────────

  const streamPromises: Promise<Stream>[] =
    captureMode.kind === "single"
      ? [
          createStream({
            audioArgs: captureArgs(captureMode.device),
            model,
            onCompleted: (t) => onCompleted("Microphone", t),
            onPending: (t) => onPending("Microphone", t),
          }),
        ]
      : [
          createStream({
            audioArgs: captureArgs(captureMode.mic),
            model,
            onCompleted: (t) => onCompleted("Microphone", t),
            onPending: (t) => onPending("Microphone", t),
          }),
          createStream({
            audioArgs: captureArgs(captureMode.system),
            model,
            onCompleted: (t) => onCompleted("Speakers", t),
            onPending: (t) => onPending("Speakers", t),
          }),
        ];

  const streamsReady = Promise.all(streamPromises);

  // Surface connection errors immediately so they're not silently swallowed.
  streamsReady.catch((err: unknown) => {
    p.log.error(
      `Stream connection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;

    // If streams failed to connect, fall back to an empty list so we still
    // write the footer and close the file cleanly.
    const streams = await streamsReady.catch(() => [] as Stream[]);
    await Promise.all(streams.map((s) => s.stop()));

    const endedAt = new Date();
    const duration = Math.round(
      (endedAt.getTime() - startedAt.getTime()) / 1000,
    );
    append(
      `---\n_Ended: ${endedAt.toLocaleString()} · Duration: ${duration}s_\n`,
    );

    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }

    process.stdout.write("\n");
    p.log.success(`Transcript saved → ${outputFile}`);
  };

  return { stop };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (import.meta.main) {
  const { shutdown } = await start();

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outputFile = process.env["OUTPUT_FILE"] ?? `transcript-${ts}.md`;

  const { stop } = listen({ outputFile });

  let stopping = false;
  process.on("SIGINT", async () => {
    if (stopping) return;
    stopping = true;
    await stop();
    await shutdown();
    process.exit(0);
  });
}
