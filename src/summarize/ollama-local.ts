import { spawn, type Subprocess } from "bun";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { Ollama } from "ollama";
import path from "node:path";

const DEFAULT_ORIGIN = "http://127.0.0.1:11434";
const READY_POLL_MS = 250;
const STOP_KILL_WAIT_MS = 8_000;

/** Default summarization model; override with `LISTENIN_OLLAMA_MODEL`. */
export const OLLAMA_MODEL = process.env["LISTENIN_OLLAMA_MODEL"] ?? "qwen3:4b";

export function ollamaOrigin(): string {
  const raw = (process.env["LISTENIN_OLLAMA_ORIGIN"] ?? DEFAULT_ORIGIN).replace(
    /\/$/,
    "",
  );
  return raw.startsWith("http") ? raw : `http://${raw}`;
}

async function ollamaTagsReachable(origin: string): Promise<boolean> {
  const client = new Ollama({ host: origin });
  try {
    const listed = await Promise.race([
      client.list(),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 2_000),
      ),
    ]);
    return listed !== "timeout";
  } catch {
    return false;
  }
}

async function waitUntilOllamaReady(
  origin: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      if (await ollamaTagsReachable(origin)) {
        return;
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  throw new Error(
    `Ollama did not become ready at ${origin} within ${timeoutMs}ms.` +
      (lastErr instanceof Error ? ` Last error: ${lastErr.message}` : ""),
  );
}

function registerOllamaModel(
  modelRegistry: ModelRegistry,
  openAiBaseUrl: string,
) {
  modelRegistry.registerProvider("ollama", {
    baseUrl: openAiBaseUrl,
    api: "openai-completions",
    apiKey: "ollama",
    models: [
      {
        id: OLLAMA_MODEL,
        name: `${OLLAMA_MODEL} (Ollama)`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131_072,
        maxTokens: 32_768,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
      },
    ],
  });
}

export type OllamaSummarizeModelContext = {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  model: NonNullable<ReturnType<ModelRegistry["find"]>>;
};

/**
 * Ensures the model exists locally (Ollama `/api/tags`) and is registered with Pi’s
 * `ModelRegistry` the same way as summarization (in-memory auth + noop models.json path).
 */
export async function assertOllamaModelPresent(
  origin: string,
  openAiBaseUrl: string,
): Promise<OllamaSummarizeModelContext> {
  const client = new Ollama({ host: origin });
  const listed = await Promise.race([
    client.list(),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 15_000),
    ),
  ]);
  if (listed === "timeout") {
    throw new Error(`Ollama list() timed out after 15000ms at ${origin}.`);
  }
  const names = new Set((listed.models ?? []).map((m) => m.name));
  const ok =
    names.has(OLLAMA_MODEL) ||
    [...names].some(
      (n) => n === OLLAMA_MODEL || n.startsWith(`${OLLAMA_MODEL}:`),
    );
  if (!ok) {
    throw new Error(
      `Ollama does not have model "${OLLAMA_MODEL}". Pull it first, e.g. ollama pull ${OLLAMA_MODEL}`,
    );
  }

  const authStorage = AuthStorage.inMemory();
  const modelRegistry = new ModelRegistry(authStorage);
  registerOllamaModel(modelRegistry, openAiBaseUrl);

  const model = modelRegistry.find("ollama", OLLAMA_MODEL);
  if (!model) {
    throw new Error(`Failed to register Ollama model "${OLLAMA_MODEL}".`);
  }

  return { authStorage, modelRegistry, model };
}

export type ManagedOllama = {
  origin: string;
  openAiBaseUrl: string;
  /** Call when done if we started `ollama serve` (no-op if the server was already up). */
  stopIfWeStarted: () => Promise<void>;
};

/**
 * If Ollama is already serving, returns immediately. Otherwise runs `ollama serve` and waits
 * until `ollama.list()` responds, then returns a function that terminates only that child process.
 */
export async function ensureOllamaServe(): Promise<ManagedOllama> {
  const origin = ollamaOrigin();
  const openAiBaseUrl = `${origin}/v1`;
  const readyMs = Number(process.env["LISTENIN_OLLAMA_READY_MS"] ?? 90_000);

  if (await ollamaTagsReachable(origin)) {
    return {
      origin,
      openAiBaseUrl,
      stopIfWeStarted: async () => {
        /* server was already running */
      },
    };
  }

  let subprocess: Subprocess | undefined;
  try {
    subprocess = spawn(["ollama", "serve"], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
  } catch (e) {
    throw new Error(
      `Failed to start "ollama serve". Is Ollama installed and on PATH? (${e instanceof Error ? e.message : String(e)})`,
    );
  }

  const exitPromise = subprocess.exited;
  exitPromise.then((code) => {
    if (code !== 0 && code !== null) {
      console.error(`listen-in: ollama serve exited with code ${code}`);
    }
  });

  try {
    await waitUntilOllamaReady(origin, readyMs);
  } catch (e) {
    subprocess.kill();
    await subprocess.exited.catch(() => undefined);
    throw e;
  }

  return {
    origin,
    openAiBaseUrl,
    stopIfWeStarted: async () => {
      if (!subprocess || subprocess.killed) {
        return;
      }
      subprocess.kill("SIGTERM");
      const done = await Promise.race([
        subprocess.exited,
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), STOP_KILL_WAIT_MS),
        ),
      ]);
      if (done === "timeout" && !subprocess.killed) {
        subprocess.kill("SIGKILL");
        await subprocess.exited.catch(() => undefined);
      }
    },
  };
}

/** Avoid loading the user’s ~/.pi/agent/models.json into this flow. */
export function noopModelsJsonPath(): string {
  return path.join(import.meta.dir, "__no_listen_in_models__.json");
}
