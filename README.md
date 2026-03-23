# 🎧 Listen in

CLI to make it easy to locally transcribe digital meetings to MD files without the use of bots.

## How it works

Transcription and cleaning up of transcriptions + summarization happens entirely locally using a combination of [WhisperLive](https://github.com/collabora/WhisperLive), [BlackHole](https://github.com/existentialaudio/blackhole), and [Qwen2.5 14B](https://huggingface.co/Qwen/Qwen2.5-14B) (Ollama).

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

## Example Transcript
