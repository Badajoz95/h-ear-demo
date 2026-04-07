# demo-openclaw.mjs

OpenClaw Skill Demo. Demonstrates the `@h-ear/openclaw` skill commands programmatically, simulating what a user would experience in WhatsApp, Telegram, Slack, Discord, or Teams via the OpenClaw gateway.

## Usage

```bash
# Quick demo: health + classes + usage (no audio classification)
node packages/demo/demos/openclaw.mjs --key <api-key>

# Full demo including audio classification
node packages/demo/demos/openclaw.mjs --key <key> --classify https://example.com/audio.mp3

# Against dev environment
node packages/demo/demos/openclaw.mjs --env dev --key <key>

# Show all available commands
node packages/demo/demos/openclaw.mjs --key <key> --all
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--env <env>` | `prod` | Target environment: dev, staging, prod |
| `--key <key>` | | Enterprise API key (required) |
| `--classify <url>` | (none) | URL to classify (triggers full classify demo) |
| `--all` | false | Run all commands including jobs and usage |

## Flow

```
                    +------------------+
                    | demo-openclaw    |
                    |    (this)        |
                    +---+---------+----+
                        |         |
         1. Import      |         |  6. Format results
      @h-ear/openclaw   |         |     as chat markdown
                        v         |
                    +---+---------+----+
                    | @h-ear/core      |
                    | HearApiClient    |
                    +---+---------+----+
                        |         ^
              2. REST   |         |  5. JSON response
                 calls  |         |
                        v         |
                    +---+---------+----+
                    |  Enterprise API  |
                    |  (via APIM)      |
                    +---------+--------+
                              |
                    3. Queue  |  (if classify)
                              v
                    +------------------+
                    |   Processor      |
                    |   (Docker)       |--- 4. ML Analysis
                    +------------------+
```

## Demo Storyline

### Act 1: Setup (instant)
```
  -- OPENCLAW DEMO -----------------------------------------------
  Env: prod | API: https://api.h-ear.world/api
  Skill: @h-ear/openclaw v0.1.0
```

### Act 2: Health + Discovery
```
  > health
  **H-ear API Status**
  Status: healthy
  Version: 1.0.0
  Deployed: 2026-03-28T00:13:13.857Z

  > sounds Animal (limit 5)
  **Sound Classes** (audioset-yamnet-521)
  59 of 521 classes

  | # | Class | Category |
  |---|-------|----------|
  | 67 | Animal | Animal |
  | 68 | Domestic animals, pets | Animal |
  | 69 | Dog | Animal |
  | 70 | Bark | Animal |
  | 71 | Yip | Animal |
```

### Act 3: Usage
```
  > usage
  **H-ear API Usage**
  Plan: enterprise
  Minutes: 5 / 90,000 (0%)
  Today: 0 / 50,000 calls (0%)
```

### Act 4: Classification (if --classify provided)
```
  > classify https://example.com/city-noise.mp3
  **Audio Classification Complete**
  Duration: 45.2s | 15 noise events detected

  | Sound | Confidence | Category |
  |-------|-----------|----------|
  | Car horn | 94% | Vehicle |
  | Speech | 87% | Human |
  | Dog bark | 72% | Animal |
```

## Related Demos

- [`openclaw-listen.md`](openclaw-listen.md) — Local audio monitoring: OpenClaw + RTSP camera + h-ear classification via Ollama.

## Architecture References

- ARCH-010: MCP / OpenClaw integration
- ARCH-012: Observer/Operator pattern (env resolution)
- `packages/openclaw/` — skill package source
- `packages/openclaw/src/cli.ts` — h-ear CLI (bin entry)
- `packages/core/` — shared API client
- `Badajoz95/h-ear-openclaw` — ClawHub publish repo
