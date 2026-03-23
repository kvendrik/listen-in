import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";
import { Ollama } from "ollama";

export function getModelFromId(model: string): Model<Api> {
  const [provider, modelId] = model.split(":");

  if (!provider || !modelId) {
    throw new Error(
      `Invalid model: ${model}. Expected format: <provider>:<modelId>. E.g. ollama:qwen3:4b or anthropic:claude-sonnet-4-6`,
    );
  }

  const authStorage = AuthStorage.inMemory();
  const modelRegistry = new ModelRegistry(authStorage);

  if (provider === "ollama") {
    const model = getOllamaModel(modelId);
    if (!model) {
      throw new Error(`Ollama model not found: ${modelId}`);
    }
    modelRegistry.registerProvider("ollama", {
      baseUrl: "http://127.0.0.1:11434/v1",
      api: "openai-completions",
      apiKey: "ollama",
      models: [
        {
          id: modelId,
          name: `${modelId} (Ollama)`,
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

  const foundModel = modelRegistry.find(provider, modelId);

  if (!foundModel) {
    throw new Error(`Model not found: ${modelId}`);
  }

  return foundModel;
}

async function getOllamaModel(modelId: string) {
  const client = new Ollama();
  const listed = await client.list();
  return listed.models?.find((m) => m.name === modelId);
}
