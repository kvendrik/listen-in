# 🎙️ `listenin`

CLI to transcribe and summarize digital meetings without the use of bots

## How it works

1. `listenin transcribe` transcribes meetings by recording your microphone, capturing speaker sound using [BlackHole](https://github.com/existentialaudio/blackhole), and transcribing using [WhisperLive](https://github.com/collabora/WhisperLive)
2. `listenin clean` cleans up and summarizes transcripts using a LLM (supports most popular LLM providers through [pi-mono](https://github.com/badlogic/pi-mono) + [Ollama](https://ollama.com/) for local models)

## How to use

```bash
bun install -g @kvendrik/listen-in
```

```bash
# 1. Walks you through making sure you have all dependencies installed
# 2. Helps you set up the audio driver so the CLI can capture what others say when on
listenin doctor

# Change transcriptions location & LLM preference
# `./.transcriptions/` & Sonnet 4.6 by default
listenin config

# Transcribe a meeting
listenin transcribe

# Clean and summarize the last transcription
listenin clean last

# examples of using different LLMs
listenin config set llm ollama:qwen3:4b
listenin config set llm openai:gpt-4.6
```
