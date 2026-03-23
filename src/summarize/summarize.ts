/**
 * Local summarization via Ollama (OpenAI-compatible API) and Pi’s agent SDK.
 *
 * Pi documents Ollama as a custom provider (`openai-completions`, `/v1` base URL, dummy API key).
 * We register that provider in-memory so ~/.pi/agent/models.json is not required.
 *
 * Default model `qwen2.5:14b`: strong instruction-following and a practical speed/quality
 * tradeoff for long transcript cleanup on typical consumer GPUs/Apple Silicon. Override with
 * `LISTENIN_OLLAMA_MODEL` (e.g. `llama3.1:8b` for lower latency/VRAM; default in `ollama-local.ts`).
 *
 * @see https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md
 */
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import path from "node:path";
import {
  assertOllamaModelPresent,
  ensureOllamaServe,
  type ManagedOllama,
} from "./ollama-local.ts";

const SUMMARIZE_PROMPT_PATH = path.join(import.meta.dir, "SUMMARIZE_PROMPT.md");
const TRANSCRIPT_PLACEHOLDER = "[TRANSCRIPT HERE]";

function buildPrompt(template: string, transcript: string): string {
  if (template.includes(TRANSCRIPT_PLACEHOLDER)) {
    return template.replaceAll(TRANSCRIPT_PLACEHOLDER, transcript);
  }
  return `${template.trimEnd()}\n\n${transcript}`;
}

function assistantTextFromSession(session: AgentSession): string {
  const messages = session.state.messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") {
    throw new Error("No assistant response received.");
  }
  if (last.stopReason === "error" || last.stopReason === "aborted") {
    throw new Error(last.errorMessage ?? `Request ${last.stopReason}`);
  }
  const parts: string[] = [];
  for (const block of last.content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

export async function summarize(transcriptMdPath: string): Promise<string> {
  const resolvedTranscript = path.resolve(transcriptMdPath);
  if (!fs.existsSync(resolvedTranscript)) {
    throw new Error(`Transcript not found: ${resolvedTranscript}`);
  }

  const template = fs.readFileSync(SUMMARIZE_PROMPT_PATH, "utf8");
  const transcript = fs.readFileSync(resolvedTranscript, "utf8");
  const promptText = buildPrompt(template, transcript);

  return prompt(promptText);
}

export async function prompt(promptText: string): Promise<string> {
  const { session, managed } = await createSession();

  try {
    await session.prompt(promptText);
    return assistantTextFromSession(session);
  } finally {
    session.dispose();
    await managed.stopIfWeStarted();
  }
}

async function createSession(): Promise<{
  session: AgentSession;
  managed: ManagedOllama;
}> {
  const managed = await ensureOllamaServe();
  const ollama = await assertOllamaModelPresent(
    managed.origin,
    managed.openAiBaseUrl,
  );

  const auth = AuthStorage.inMemory();

  const { session, modelFallbackMessage } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    thinkingLevel: "off",
    tools: [],
    model: getModel("anthropic", "claude-sonnet-4-6"),
    authStorage: auth,
    modelRegistry: new ModelRegistry(auth),
  });

  if (!session.model) {
    await managed.stopIfWeStarted();
    throw new Error(
      modelFallbackMessage ??
        "No model selected for summarization (unexpected).",
    );
  }

  return { session, managed };
}
