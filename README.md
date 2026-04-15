# H-ear Demos

Live demos for [H-ear World](https://h-ear.world) — AI-powered sound classification.

## Demos

| Demo | Description |
|------|-------------|
| [OpenClaw](demos/openclaw.md) | OpenClaw skill commands — simulates WhatsApp/Telegram/Slack/Discord/Teams usage |
| [Webcam](demos/webcam.md) | TP-Link Tapo C100 edge audio acquisition — RTSP capture, classify (base64/multipart), poll jobs, usage, classes |
| [Webhook](demos/webhook.md) | Notification alert demo — submits prod demo audio via URL or local file, dual alert rules (Respiratory sounds >= 50%, Sounds of things >= 60%), per-request callbacks + persistent webhooks with HMAC signature verification |

## Quick Start

```bash
# OpenClaw skill demo
node demos/openclaw.mjs --key <api-key>

# Webcam capture + classify
node demos/webcam.mjs --full --key <api-key>

# Notification alert — URL mode (default, uses prod demo audio)
node demos/webhook.mjs --oauth --callback-host <ngrok-host>

# Or with local bundled file
node demos/webhook.mjs --oauth --callback-host <ngrok-host> --file demos/demo-60s.mp3
```

Each demo has a companion `.md` doc with full usage, options, and architecture diagrams.

## Prerequisites

- Node.js >= 18
- Enterprise API key ([h-ear.world](https://h-ear.world)) or OAuth via `--oauth` (browser login)
- Demo-specific: see individual docs (ffmpeg for webcam, ngrok + OAuth for webhook)

## Related

- [@h-ear/mcp-server](https://www.npmjs.com/package/@h-ear/mcp-server) — MCP server for Claude
- [@h-ear/openclaw](https://www.npmjs.com/package/@h-ear/openclaw) — OpenClaw skill
- [H-ear World](https://h-ear.world) — Web dashboard
