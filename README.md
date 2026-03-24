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

## Example

```
> listenin transcribe
◇  Microphone
│  Default Microphone
│
◇  Model “small” loads OK
│
◇  Whisper server ready
│
◆  Live transcript → .transcripts/2026-03-23_18-25-07.md
│  Speak now — Ctrl-C to stop.


> listenin clean last
|
◇  Ready at .transcripts/2026-03-23_18-25-07.clean.md
```

Send the transcript to your AI agent for analysis and to take action. The `clean` task also asks the LLM to extract action items which will help your AI agent figure out what might need to be done. In my case I'd be sending it to [Greg](https://github.com/kvendrik/greg/):

```bash
cat .transcripts/2026-03-23_18-25-07.clean.md | greg tui -p "Analyze this transcript and tell me what you can take off my plate"
```

### `.transcripts/2026-03-23_18-25-07.clean.md`

```md
# Q4 Priorities, Vendor Renewal & Analytics Rollout — March 23, 2026, 6:25 PM

## Summary

The team reviewed Q4 priorities across product, vendor, and analytics workstreams. The self-serve export beta is on track but scoped narrowly to avoid slipping; the Acme vendor renewal requires a counter-proposal on SLA penalty caps; and the analytics warehouse cutover hinges on marketing finalizing their event taxonomy by EOD the following day. Action owners were assigned and a follow-up check-in was scheduled for Thursday.

## Action items

- **Sarah:** Update the permissions spec and ping legal on data-retention wording
- **James:** Send counter-proposal on SLA credits (50% of monthly fee) by Wednesday
- **Priya:** Chase marketing to sign off on event taxonomy freeze by EOD Tuesday; backfill after launch if needed
- **You:** Check in with HR on the two outstanding platform team offers

---

## Transcript

[00:00:00] **You:** Thanks everyone for joining. Quick agenda: Q4 priorities, the vendor renewal, and blockers on the analytics rollout. I'll keep us to forty minutes. Sarah, want to start with product?

[00:00:24] **Them:** Sure. We're on track for the self-serve export beta next sprint. The main risk is still the permissions model — engineering flagged edge cases for shared workspaces. We can scope those to admin-only for v1 if we document it clearly. I'd rather ship something narrow than slip another two weeks. Agreed. I'll update the spec and ping legal on the data-retention wording they asked for.

[00:01:05] **Them:** On the renewal: Acme sent revised terms Friday. Net is five percent higher if we commit to twenty-four months instead of twelve.

[00:01:18] **You:** Did we get the SLA appendix they promised?

[00:01:22] **Them:** Yes — uptime language is tighter, but the penalty caps are still low. I'd push for credits at fifty percent of monthly fee instead of twenty-five. Let's do that. Finance is fine with multi-year if we lock in the price band. I'll own the counter by Wednesday.

[00:01:51] **Them:** Analytics: the warehouse sync is stable in staging. The blocker is the marketing team's event taxonomy — they're still renaming three events.

[00:02:08] **You:** Can we freeze the schema this week and version anything new?

[00:02:14] **Them:** That's the proposal. If marketing signs off by EOD tomorrow, we can keep the March 30 cutover. I'll chase them. Worst case we backfill after launch; not ideal but we've done it before.

[00:02:35] **You:** Any other risks before we close?

[00:02:39] **Them:** Hiring — two offers out for the platform team. If both accept we're staffed for the compliance workstream.

[00:02:50] **You:** Good. Recap: Sarah updates permissions spec and legal; James counters on SLA; Priya freezes taxonomy; I'll check in with HR on offers. Same time Thursday for a fifteen-minute status.

[00:03:08] **Them:** Sounds good. Thanks, everyone.
```
