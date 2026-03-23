import * as fs from "node:fs";
import { join } from "node:path";

interface Config {
  llm: string;
  outputDir: string;
}

interface Tools {
  get(): Config;
  set(key: keyof Config, value: Config[keyof Config]): void;
}

export function getConfig(): Tools {
  const configPath = join(process.cwd(), ".config.json");

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          llm: "anthropic:claude-sonnet-4-6",
          outputDir: join(process.cwd(), ".transcripts"),
        },
        null,
        2,
      ),
    );
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  return {
    get() {
      return config;
    },
    set(key: string, value: string) {
      config[key] = value;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    },
  };
}
