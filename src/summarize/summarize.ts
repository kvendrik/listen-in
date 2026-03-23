import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { getModelFromId } from "./model";
import * as fs from "node:fs";
import path from "node:path";

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

export async function summarize(
  transcriptMdPath: string,
  model: string,
): Promise<string> {
  const resolvedTranscript = path.resolve(transcriptMdPath);
  if (!fs.existsSync(resolvedTranscript)) {
    throw new Error(`Transcript not found: ${resolvedTranscript}`);
  }

  const template = fs.readFileSync(SUMMARIZE_PROMPT_PATH, "utf8");
  const transcript = fs.readFileSync(resolvedTranscript, "utf8");
  const promptText = buildPrompt(template, transcript);

  return prompt(promptText, model);
}

export async function prompt(
  promptText: string,
  model: string,
): Promise<string> {
  const session = await createSession(model);

  try {
    await session.prompt(promptText);
    return assistantTextFromSession(session);
  } finally {
    session.dispose();
  }
}

async function createSession(modelId: string): Promise<AgentSession> {
  const model = getModelFromId(modelId);
  const auth = AuthStorage.inMemory();

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    thinkingLevel: "off",
    tools: [],
    model,
    authStorage: auth,
    modelRegistry: new ModelRegistry(auth),
  });

  return session;
}
