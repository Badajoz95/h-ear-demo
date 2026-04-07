# OpenClaw + H-ear Listen Demo

Local audio monitoring via OpenClaw agent, RTSP camera, and h-ear classification API.

## Architecture

```
Phone / CLI ──→ OpenClaw Gateway ──→ LLM (Ollama) ──→ h-ear CLI
                  (ws://0.0.0.0:18789)                    │
                                                    ┌─────┴─────┐
                                                    │  ffmpeg    │
                                                    │  RTSP ──→ WAV
                                                    └─────┬─────┘
                                                          │
                                                    ┌─────┴─────┐
                                                    │  h-ear API │
                                                    │  classify  │
                                                    └─────┬─────┘
                                                          │
                                              classification results
```

## Prerequisites

- **Node.js** 22.14+ (`node --version`)
- **ffmpeg** in PATH (`ffmpeg -version`)
- **RTSP camera** on the local network
- **H-ear API key** (`ncm_sk_...`) from [h-ear.world](https://h-ear.world)

## 1. Install OpenClaw

```bash
npm install -g openclaw@latest
openclaw --version
```

## 2. Configure Gateway

```bash
# Set gateway to local mode, bind to LAN
openclaw config set gateway.mode local
openclaw config set gateway.bind lan
openclaw config set gateway.auth.mode token
openclaw config set gateway.auth.token "$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
```

## 3. Install Ollama (Free Local LLM)

```bash
# Windows
winget install -e --id Ollama.Ollama

# Pull a model (llama3.1:8b recommended for tool use)
ollama pull llama3.1:8b
```

Configure OpenClaw to use Ollama — add to `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "ollama": {
        "baseUrl": "http://localhost:11434",
        "api": "ollama",
        "models": [{
          "id": "llama3.1:8b",
          "name": "Llama 3.1 8B",
          "api": "ollama",
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 8192
        }]
      }
    }
  }
}
```

> **Alternative**: Use Anthropic API (`anthropic-messages`) with a funded API key for better skill comprehension. Ollama is free but requires explicit prompting.

## 4. Build & Link h-ear CLI

From the NCM monorepo root:

```bash
cd packages/openclaw
npm run build
npm link
h-ear help
```

Verify:

```bash
HEAR_API_KEY=ncm_sk_... HEAR_ENV=dev h-ear health
# → Status: healthy
```

## 5. Install h-ear Skill

```bash
openclaw skills install h-ear
openclaw config set skills.entries.h-ear.apiKey "ncm_sk_..."
openclaw config set skills.entries.h-ear.env.HEAR_ENV dev
```

Create the listener skill:

```bash
mkdir -p ~/.openclaw/workspace/skills/h-ear-listen
```

Write `~/.openclaw/workspace/skills/h-ear-listen/SKILL.md` — see [SKILL.md template](#skill-template) below.

## 6. Set Environment Variables

```bash
openclaw config set env.vars.HEAR_API_KEY "ncm_sk_..."
openclaw config set env.vars.HEAR_ENV dev
openclaw config set env.vars.LISTEN_RTSP_URL "rtsp://user:pass@192.168.0.13/stream1"
```

## 7. Configure Exec Timeout

The capture + classify pipeline takes 30-60 seconds. Increase the exec timeout:

```bash
openclaw config set tools.exec.timeoutSec 180
openclaw config set tools.exec.backgroundMs 120000
```

## 8. Add h-ear to TOOLS.md

Append to `~/.openclaw/workspace/TOOLS.md`:

```markdown
## H-ear — Sound Intelligence

The `h-ear` CLI classifies audio from files, URLs, or the RTSP camera.

### Commands

- `h-ear health` — Check API status
- `h-ear capture --duration 15` — Capture from camera and classify
- `h-ear classify <file-or-url>` — Classify audio file or URL
- `h-ear sounds [search]` — List sound classes
- `h-ear usage` — Show API usage

When the user says "listen", "what can you hear", or "capture audio", run: `h-ear capture --duration 15`
```

> **Why TOOLS.md?** Skills loaded from `workspace/skills/` may not always appear in the agent prompt (depends on allowlist configuration). TOOLS.md is always injected.

## 9. Start Gateway

```bash
openclaw gateway install    # auto-start on login
openclaw gateway            # or start manually
```

## 10. Pair Mobile (Optional)

```bash
# For LAN access (same Wi-Fi)
openclaw qr

# For external access (port forward 18789 first)
openclaw qr --url "ws://YOUR_PUBLIC_IP:18789"
```

Approve the device:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

**Windows Firewall**: Add inbound rule for TCP 18789.

## 11. Test

### Headless (CLI)

```bash
# Health check
openclaw agent --to "+61400000000" -m "run: h-ear health" --json --timeout 60

# Capture and classify
openclaw agent --to "+61400000000" -m "run: h-ear capture --duration 5" --json --timeout 300
```

### From Phone

Send: "what can you hear from the camera?"

## SKILL.md Template

```yaml
---
name: h-ear-listen
description: "Listen to what's happening via RTSP camera audio — capture and classify sounds using h-ear."
metadata: {"openclaw": {"requires": {"env": ["HEAR_API_KEY", "HEAR_ENV", "LISTEN_RTSP_URL"]}, "primaryEnv": "HEAR_API_KEY"}}
---

# H-ear Listen — Camera Audio Monitor

When the user asks "what can you hear?", run:

\`\`\`bash
h-ear capture --duration 15
\`\`\`

This captures audio from the RTSP camera, classifies it, and returns detected sounds.
```

## h-ear CLI Reference

| Command | Description |
|---------|-------------|
| `h-ear health` | API status |
| `h-ear capture --duration <s>` | Capture RTSP audio + classify |
| `h-ear classify <file>` | Classify local audio file |
| `h-ear classify <url>` | Classify audio URL |
| `h-ear sounds [search]` | List sound classes (521+) |
| `h-ear usage` | API usage stats |
| `h-ear jobs --limit <n>` | Recent classification jobs |

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Gateway won't start | Check Ollama is running (`curl localhost:11434`) |
| h-ear not found | Run `npm link` in `packages/openclaw` |
| Capture timeout | Increase `tools.exec.timeoutSec` to 180+ |
| Model ignores h-ear | Add commands to `TOOLS.md` (always injected) |
| Phone can't connect | Check Windows Firewall rule for port 18789 |
| NAT hairpin fails | Use mobile data (not Wi-Fi) for external QR |
| Skills not in prompt | Use TOOLS.md instead of relying on skill injection |
