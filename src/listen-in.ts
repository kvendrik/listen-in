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
 *   const { stop } = await listen({ outputFile: "meeting.md" });
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
import path from "node:path";

// ── Config ────────────────────────────────────────────────────────────────────

const WHISPER_PORT = Number(process.env["WHISPER_PORT"] ?? 9090);
/** First torch/whisper import + bind can exceed 10s on a cold start. */
const WHISPER_READY_MS = Number(
  process.env["WHISPER_READY_TIMEOUT_MS"] ?? 120_000,
);
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const WHISPER_RUNNER = path.join(
  REPO_ROOT,
  "scripts",
  "run_whisper_live_server.py",
);
const WHISPER_MODEL_VERIFY_SCRIPT = path.join(
  REPO_ROOT,
  "scripts",
  "verify_whisper_model.py",
);
const SERVER_URL =
  process.env["WHISPER_SERVER"] ?? `ws://localhost:${WHISPER_PORT}`;
const LANGUAGE = (process.env["WHISPER_LANG"] ?? "").trim() || "en";
/** Silero VAD inside faster-whisper can drop quiet/system-audio paths; set WHISPER_USE_VAD=0 to disable. */
const WHISPER_USE_VAD =
  process.env["WHISPER_USE_VAD"] !== "0" &&
  process.env["WHISPER_USE_VAD"] !== "false";
/**
 * WhisperLive only shares one faster-whisper model across clients when the server
 * is started with `-fw` (or TensorRT). Without it, each WebSocket loads its own
 * model — costly for dual (mic + system) capture. We default `-fw` to a Systran
 * HF repo matching the chosen size; override with WHISPER_FW_MODEL, or set
 * WHISPER_NO_FW=1 to match legacy behavior.
 */
const WHISPER_FW_MODEL = (process.env["WHISPER_FW_MODEL"] ?? "").trim();
const WHISPER_NO_FW =
  process.env["WHISPER_NO_FW"] === "1" ||
  process.env["WHISPER_NO_FW"] === "true";
/** CPU thread hint for ctranslate2/OpenMP (`--omp_num_threads` on the server). */
const WHISPER_OMP_THREADS = (process.env["WHISPER_OMP_THREADS"] ?? "").trim();
/** Seconds per client; long meetings — upstream README defaults to 600, our runner default was 300. */
const WHISPER_MAX_CONNECTION_TIME = Number(
  process.env["WHISPER_MAX_CONNECTION_TIME"] ?? 3600,
);
const WHISPER_MAX_CLIENTS = (process.env["WHISPER_MAX_CLIENTS"] ?? "").trim();
/**
 * Prevent premature disconnects when partial text repeats for a while.
 * whisper-live examples often use low values, but they can be too aggressive
 * for real meetings with pauses/filler words.
 */
const WHISPER_SAME_OUTPUT_THRESHOLD = Number(
  process.env["WHISPER_SAME_OUTPUT_THRESHOLD"] ?? 60,
);
/**
 * After capture stops, brief yield before we start waiting for partials to clear
 * (lets the tail buffer reach whisper-live).
 */
const SHUTDOWN_GRACE_MS = Number(
  process.env["LISTENIN_SHUTDOWN_GRACE_MS"] ?? 800,
);
/**
 * After capture stops, wait up to this long for in-flight partial segments to
 * become completed (Ctrl+C stops ffmpeg immediately; this phase waits on the server).
 */
const FINALIZE_MAX_MS = Number(
  process.env["LISTENIN_FINALIZE_MAX_MS"] ?? 120_000,
);
/** Partials must stay empty at least this long before we close the socket. */
const FINALIZE_STABLE_MS = Number(
  process.env["LISTENIN_FINALIZE_STABLE_MS"] ?? 1_000,
);
/**
 * After partials look settled, keep the socket open this long anyway. whisper-live
 * often clears open segments briefly while the last chunk is still decoding; closing
 * then drops the tail of the transcript.
 */
const FINALIZE_TAIL_MS = Number(
  process.env["LISTENIN_FINALIZE_TAIL_MS"] ?? 2_500,
);
/**
 * Max wait after the tail drain for any new open segments to clear again.
 */
const FINALIZE_TAIL_PASS2_MAX_MS = Number(
  process.env["LISTENIN_FINALIZE_TAIL_PASS2_MAX_MS"] ?? 20_000,
);

const SAMPLE_RATE = 16_000;
const CHUNK_MS = 500;
const CHUNK_BYTES = (SAMPLE_RATE * 4 * CHUNK_MS) / 1000; // float32 mono

// ── Public types ──────────────────────────────────────────────────────────────

export type StartResult = { shutdown: () => Promise<void> };
export type ListenOptions = { outputFile: string };
export type ListenResult = {
  stop: () => Promise<void>;
  isTranscribing: () => boolean;
};

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
  /** `streamSeconds` is offset into this stream’s audio (from whisper-live segment `start`). */
  onCompleted: (text: string, streamSeconds: number) => void;
  onPending: (text: string | null) => void;
};

type Stream = { stop: () => Promise<void> };

/**
 * Without this, Ctrl+C sends SIGINT to the whole foreground process group, so
 * ffmpeg (and our whisper server) can die before the CLI’s handler runs — no
 * chance to drain the last transcript. Detached children stay out of that group
 * (Unix); Windows keeps default spawn behavior.
 */
function spawnIsolatedFromTerminal(): { detached?: boolean } {
  return process.platform === "win32" ? {} : { detached: true };
}

/** Map UI / faster-whisper size names to a HF id valid for WhisperLive `-fw` (must contain `/` if not a local path). */
function fasterWhisperServerFwModel(model: string): string {
  const m = model.trim();
  if (!m) return "Systran/faster-whisper-small";
  if (m.includes("/") || path.isAbsolute(m) || m.startsWith("~")) return m;
  const distil: Record<string, string> = {
    "distil-small.en": "Systran/faster-distil-whisper-small.en",
    "distil-medium.en": "Systran/faster-distil-whisper-medium.en",
    "distil-large-v2": "Systran/faster-distil-whisper-large-v2",
    "distil-large-v3": "Systran/faster-distil-whisper-large-v3",
  };
  if (distil[m] !== undefined) return distil[m]!;
  if (m === "turbo" || m === "large-v3-turbo") {
    return "Systran/faster-whisper-large-v3-turbo";
  }
  return `Systran/faster-whisper-${m}`;
}

// ── Module state ──────────────────────────────────────────────────────────────

let _ctx: { model: string; captureMode: CaptureMode } | null = null;

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

/** Whisper-live sends JSON text frames; Bun may deliver string, ArrayBuffer, or TypedArray. */
function wsMessageText(data: MessageEvent["data"]): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new TextDecoder().decode(
      v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
    );
  }
  return null;
}

function parseSegmentSeconds(seg: { start?: unknown }): number {
  const s = seg.start;
  if (typeof s === "number" && Number.isFinite(s)) return Math.max(0, s);
  if (typeof s === "string") {
    const n = parseFloat(s);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  return 0;
}

/** Offset into this capture stream, `[MM:SS:cc]` (minutes, seconds, centiseconds). */
function formatStreamTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const msTotal = Math.round(seconds * 1000);
  const mm = Math.floor(msTotal / 60_000);
  const msRemainder = msTotal - mm * 60_000;
  const ss = Math.floor(msRemainder / 1000);
  const ms = msRemainder - ss * 1000;
  const cs = Math.floor(ms / 10);
  return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}:${String(cs).padStart(2, "0")}]`;
}

async function startWhisperServer(
  chosenModel: string,
): Promise<Subprocess | null> {
  const alreadyUp = await pollPort(WHISPER_PORT, 500);
  if (alreadyUp) {
    p.log.info(
      `Whisper server already running on :${WHISPER_PORT} — will use it.`,
    );
    return null;
  }

  const spinner = p.spinner();
  spinner.start("Starting whisper-live server");

  if (!fs.existsSync(WHISPER_RUNNER)) {
    spinner.stop("Server failed to start");
    p.log.error(
      `Missing WhisperLive runner script:\n${WHISPER_RUNNER}\n` +
        "(expected vendored copy of upstream run_server.py — see scripts/ in this repo.)",
    );
    process.exit(1);
  }

  const fwModel = WHISPER_NO_FW
    ? null
    : WHISPER_FW_MODEL || fasterWhisperServerFwModel(chosenModel);

  const whisperServerCommand = [
    "uv",
    "run",
    "python",
    WHISPER_RUNNER,
    "--backend",
    "faster_whisper",
    "--port",
    String(WHISPER_PORT),
    "--max_connection_time",
    String(
      Number.isFinite(WHISPER_MAX_CONNECTION_TIME) &&
        WHISPER_MAX_CONNECTION_TIME > 0
        ? WHISPER_MAX_CONNECTION_TIME
        : 3600,
    ),
  ];
  if (WHISPER_MAX_CLIENTS !== "") {
    whisperServerCommand.push("--max_clients", WHISPER_MAX_CLIENTS);
  }
  if (fwModel !== null) {
    whisperServerCommand.push("-fw", fwModel);
  }
  if (WHISPER_OMP_THREADS !== "") {
    whisperServerCommand.push("-omp", WHISPER_OMP_THREADS);
  }
  //if (WHISPER_BATCH_INFERENCE) {
  whisperServerCommand.push("--batch_inference");
  //}
  const server = spawn(whisperServerCommand, {
    cwd: REPO_ROOT,
    stdout: "ignore",
    stderr: "ignore",
    ...spawnIsolatedFromTerminal(),
  });

  // Guaranteed cleanup regardless of how the process exits (cancel, crash, normal).
  // Only registered when we own the server, not when reusing an external one.
  process.on("exit", () => {
    try {
      server.kill();
    } catch {
      /* already dead */
    }
  });

  const ready = await pollPort(WHISPER_PORT, WHISPER_READY_MS);

  if (!ready) {
    spinner.stop("Server failed to start");
    server.kill();
    p.log.error(
      `whisper-live did not open :${WHISPER_PORT} within ${WHISPER_READY_MS / 1000}s.\n` +
        `Run manually from the repo root to debug:\n` +
        `  cd ${REPO_ROOT}\n` +
        `  ${whisperServerCommand.join(" ")}\n` +
        `(Increase wait with WHISPER_READY_TIMEOUT_MS if cold-start imports are slow.)`,
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
            message: "Microphone",
            options: devices
              .filter((d) => !labelLooksLikeBlackHole(d.label))
              .map((d) => ({ value: d.index, label: d.label })),
          }),
        );

  // Auto-detect BlackHole by name.
  const blackhole = devices.find((d) => labelLooksLikeBlackHole(d.label));

  if (blackhole) {
    p.log.info(`Auto-detected: ${blackhole.label} (index ${blackhole.index})`);
    return { kind: "dual", mic: micIndex, system: blackhole.index };
  }

  // BlackHole not found — prompt the user to pick or type a device.
  p.log.warn("BlackHole did not appear in the device list ffmpeg sees.");

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

const MODEL_SELECT_OPTIONS = [
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
] as const;

async function probeWhisperModelLoad(
  model: string,
): Promise<{ ok: true } | { ok: false; stderr: string }> {
  if (!fs.existsSync(WHISPER_MODEL_VERIFY_SCRIPT)) {
    return {
      ok: false,
      stderr: `Missing ${WHISPER_MODEL_VERIFY_SCRIPT}`,
    };
  }
  const proc = spawn(
    ["uv", "run", "python", WHISPER_MODEL_VERIFY_SCRIPT, model],
    { cwd: REPO_ROOT, stdout: "ignore", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code === 0) return { ok: true };
  return { ok: false, stderr };
}

async function promptModel(defaultModel: string = "small"): Promise<string> {
  const verifyOrExit = async (model: string, label: string): Promise<void> => {
    const spinner = p.spinner();
    spinner.start(
      `Verifying “${label}” (first run may download weights — can take a while)`,
    );
    const result = await probeWhisperModelLoad(model);
    if (result.ok) {
      spinner.stop(`Model “${label}” loads OK`);
      return;
    }
    spinner.stop("Model failed to load");
    p.log.error(
      result.stderr.trim() ||
        "Unknown error while loading the model (check disk and network).",
    );
    p.outro("Fix the issue above or choose a different model, then re-run.");
    process.exit(1);
  };

  if (defaultModel) {
    await verifyOrExit(defaultModel, defaultModel);
    return defaultModel;
  }

  for (;;) {
    const model = cancelOn(
      await p.select({
        message: "Whisper model",
        options: [...MODEL_SELECT_OPTIONS],
        initialValue: "small",
      }),
    );

    const spinner = p.spinner();
    spinner.start(
      `Verifying “${model}” (first run may download weights — can take a while)`,
    );
    const result = await probeWhisperModelLoad(model);
    if (result.ok) {
      spinner.stop(`Model “${model}” loads OK`);
      return model;
    }
    spinner.stop("That model did not load");
    p.log.warn(
      (result.stderr.trim() ||
        "Could not load this model (network, disk, or unsupported id).") +
        "\nPick another option.",
    );
  }
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
      const raw = wsMessageText(data);
      if (raw === null) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg["status"] === "ERROR") {
        socket.removeEventListener("message", onInit);
        socket.close();
        reject(
          new Error(
            `whisper-live: ${String(msg["message"] ?? "server error")}`,
          ),
        );
        return;
      }
      if (msg["status"] === "WAIT") return;

      if (msg["message"] === "SERVER_READY") {
        socket.removeEventListener("message", onInit);
        resolve(socket);
      } else if (msg["message"] === "DISCONNECT") {
        socket.removeEventListener("message", onInit);
        socket.close();
        reject(new Error("whisper-live: disconnected (server full or limit)"));
      }
    };

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          uid: nanoid(),
          language: LANGUAGE,
          task: "transcribe",
          model: opts.model,
          use_vad: WHISPER_USE_VAD,
          send_last_n_segments: 10,
          no_speech_thresh: 0.45,
          clip_audio: false,
          same_output_threshold: WHISPER_SAME_OUTPUT_THRESHOLD,
          enable_translation: false,
          target_language: LANGUAGE,
        }),
      );
    });

    socket.addEventListener("message", onInit);
    socket.addEventListener("error", () => {
      socket.close();
      reject(new Error(`Could not connect to ${SERVER_URL}`));
    });
  });

  let pendingText = "";
  let pendingStartSec = 0;
  /** Dedupe: whisper-live repeats completed rows while its segment window slides. */
  const emittedCompleted = new Set<string>();

  const onMessage = ({ data }: MessageEvent): void => {
    const raw = wsMessageText(data);
    if (raw === null) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Handle runtime server control messages (not only handshake-time events).
    if (msg["message"] === "DISCONNECT") {
      opts.onPending(null);
      p.log.warn("Transcription stream disconnected by whisper-live server.");
      ws.close();
      return;
    }
    if (msg["status"] === "ERROR") {
      // whisper-live can emit transient runtime errors that do not require
      // tearing down the socket; log and keep streaming.
      p.log.warn(
        `whisper-live stream warning: ${String(msg["message"] ?? "unknown error")}`,
      );
      return;
    }

    const segments = msg["segments"] as
      | Array<{ text?: string; completed?: boolean; start?: unknown }>
      | undefined;
    if (!segments?.length) return;

    const segText = (s: { text?: string }) => String(s.text ?? "").trim();

    for (const s of segments) {
      if (!s.completed) continue;
      const t = segText(s);
      if (!t) continue;
      const key = `${String(s.start ?? "")}|${t}`;
      if (emittedCompleted.has(key)) continue;
      emittedCompleted.add(key);
      opts.onCompleted(t, parseSegmentSeconds(s));
    }

    const open = segments.filter((s) => !s.completed);
    pendingText = open.map(segText).filter(Boolean).join(" ");
    if (open.length) {
      pendingStartSec = parseSegmentSeconds(open[open.length - 1]!);
    }

    opts.onPending(pendingText || null);
  };

  ws.addEventListener("message", onMessage);

  const ffmpeg = spawn(["ffmpeg", ...opts.audioArgs], {
    stdout: "pipe",
    stderr: "ignore",
    ...spawnIsolatedFromTerminal(),
  });
  let buf = new Uint8Array(0);
  let stdoutReader: { cancel: () => Promise<void> } | null = null;

  const captureLoop = (async () => {
    const reader = ffmpeg.stdout.getReader();
    stdoutReader = reader;
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
    } finally {
      stdoutReader = null;
    }
  })();

  const stop = async (): Promise<void> => {
    ffmpeg.kill();
    await Promise.race([
      Promise.allSettled([captureLoop, ffmpeg.exited]),
      Bun.sleep(2_000),
    ]);
    try {
      await stdoutReader?.cancel();
    } catch {
      /* reader already closed */
    }

    // Tail shorter than CHUNK_BYTES — send after capture so we don’t race the reader.
    try {
      if (buf.length > 0 && ws.readyState === WebSocket.OPEN) {
        ws.send(buf);
        buf = new Uint8Array(0);
      }
    } catch {
      /* ignore */
    }

    // Capture is already stopped; wait for whisper-live to finish open segments.
    if (SHUTDOWN_GRACE_MS > 0) {
      await Bun.sleep(SHUTDOWN_GRACE_MS);
    }

    const waitOpenPartialsSettled = async (maxMs: number): Promise<void> => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const deadline = Date.now() + maxMs;
      let stableStart: number | null = null;
      while (Date.now() < deadline) {
        if (pendingText === "") {
          if (stableStart === null) stableStart = Date.now();
          else if (Date.now() - stableStart >= FINALIZE_STABLE_MS) break;
        } else {
          stableStart = null;
        }
        await Bun.sleep(50);
      }
    };

    await waitOpenPartialsSettled(FINALIZE_MAX_MS);

    if (ws.readyState === WebSocket.OPEN && FINALIZE_TAIL_MS > 0) {
      await Bun.sleep(FINALIZE_TAIL_MS);
    }

    await waitOpenPartialsSettled(FINALIZE_TAIL_PASS2_MAX_MS);

    ws.removeEventListener("message", onMessage);
    // Flush any in-progress segment to the file before closing.
    if (pendingText) {
      opts.onCompleted(pendingText, pendingStartSec);
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
  const devices = await listDevices();
  const captureMode = await promptCaptureMode(devices);
  const model = await promptModel("small");
  const whisperServer = await startWhisperServer(model);

  _ctx = { model, captureMode };

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
 * Must be called after `start()`. Resolves only after each stream has received
 * `SERVER_READY` and ffmpeg capture has started (so audio is not lost to an early prompt).
 */
export async function listen({
  outputFile,
}: ListenOptions): Promise<ListenResult> {
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

  // Spinner must exist before any stream callbacks — whisper can send segments
  // while we are still awaiting the second WebSocket (dual mode), and redraw()
  // would otherwise hit the TDZ on `s`.
  const s = p.spinner();
  s.start("Connecting audio…");

  // ── Console: status line while streaming ────────────────────────────────────

  let hasPending = false;
  const pendingBySpeaker = new Map<string, boolean>();

  const redraw = (): void => {
    const status = hasPending ? "Transcribing..." : "Listening...";
    s.message(status);
  };

  const onCompleted = (
    text: string,
    streamSeconds: number,
    speaker: string,
  ): void => {
    if (!text) return;
    const ts = formatStreamTimestamp(streamSeconds);
    append(`${speaker}: ${ts} ${text}\n`);
    pendingBySpeaker.set(speaker, false);
    hasPending = Array.from(pendingBySpeaker.values()).some(Boolean);
    redraw();
  };

  const onPending = (speaker: string, text: string | null): void => {
    pendingBySpeaker.set(speaker, Boolean(text));
    hasPending = Array.from(pendingBySpeaker.values()).some(Boolean);
    redraw();
  };

  // ── Start one or two streams depending on capture mode ───────────────────
  // Dual mic + system: we connect the second socket only after the first is
  // SERVER_READY (sequential handshakes). The server must be started with `-fw`
  // (see startWhisperServer) so WhisperLive enables shared single-model mode;
  // otherwise each connection loads its own WhisperModel.

  let streams: Stream[];
  try {
    if (captureMode.kind === "single") {
      streams = [
        await createStream({
          audioArgs: captureArgs(captureMode.device),
          model,
          onCompleted: (text, sec) => onCompleted(text, sec, "Speaker"),
          onPending: (text) => onPending("Speaker", text),
        }),
      ];
    } else {
      const micStream = await createStream({
        audioArgs: captureArgs(captureMode.mic),
        model,
        onCompleted: (text, sec) => onCompleted(text, sec, "Microphone"),
        onPending: (text) => onPending("Microphone", text),
      });

      const systemStream = await createStream({
        audioArgs: captureArgs(captureMode.system),
        model,
        onCompleted: (text, sec) => onCompleted(text, sec, "Speakers"),
        onPending: (text) => onPending("Speakers", text),
      });

      streams = [micStream, systemStream];
    }
  } catch (err: unknown) {
    p.log.error(
      `Stream connection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    process.exit(1);
  }

  p.log.success(
    `Live transcript → ${outputFile}\nSpeak now — Ctrl-C to stop.\n`,
  );

  s.message("Listening…");

  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    s.stop();

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

  const isTranscribing = (): boolean => hasPending;

  return { stop, isTranscribing };
}
