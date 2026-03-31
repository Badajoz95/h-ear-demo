# H-ear Demos

Live demos for [H-ear World](https://h-ear.world) — AI-powered sound classification.

## Demos

| Demo | Description |
|------|-------------|
| [OpenClaw](demos/openclaw.md) | OpenClaw skill commands — simulates WhatsApp/Telegram/Slack/Discord/Teams usage |
| [Webcam](demos/webcam.md) | TP-Link Tapo C100 edge audio acquisition — RTSP capture + upload to classification API |
| [Webhook](demos/webhook.md) | Enterprise webhook alerts — submit audio, receive callback, check for target sounds |

## Quick Start

```bash
# OpenClaw skill demo
node demos/openclaw.mjs --key <api-key>

# Webcam capture + classify
node demos/webcam.mjs --full --key <api-key>

# Webhook alert flow
node demos/webhook.mjs --key <api-key>
```

Each demo has a companion `.md` doc with full usage, options, and architecture diagrams.

## Prerequisites

- Node.js >= 18
- Enterprise API key ([h-ear.world](https://h-ear.world))
- Demo-specific: see individual docs (ffmpeg for webcam, mkcert for webhook)

## Related

- [@h-ear/mcp-server](https://www.npmjs.com/package/@h-ear/mcp-server) — MCP server for Claude
- [@h-ear/openclaw](https://www.npmjs.com/package/@h-ear/openclaw) — OpenClaw skill
- [H-ear World](https://h-ear.world) — Web dashboard
