# 🎙️ `listenin`

CLI to transcribe and summarize digital meetings without the use of bots

## How it works

Transcription and cleaning up of transcriptions + summarization happens using a combination of [WhisperLive](https://github.com/collabora/WhisperLive), [BlackHole](https://github.com/existentialaudio/blackhole), and a LLM of your choosing (Qwen 3 4B or Sonnet 4.6 based on if you want to do it locally or not).

## How to use

```bash
bun install -g @kvendrik/listen-in
```

```bash
# 1. Walks you through making sure you have all dependencies installed
# 2. Helps you set up the audio driver so the CLI can capture what others say when on
listenin doctor

# Change default mic, transcriptions location, etc
listenin config

# Transcribe your first meeting
listenin
```
