# demo-webhook.mjs

Notification Alert Demo. Registers two server-side persistent webhooks with tier depth filters, submits audio to the H-ear classification API, and displays an alert box for each webhook the server fires.

The server fires each webhook **only when matching tier events exist in the job** — no client-side filtering.

Default audio: `https://www.h-ear.world/demo/demo-60s-fixture-1.mp3` — the live production demo clip.
Bundled local copy: `demos/demo-60s.mp3` (use with `--file`).

## Authentication

OAuth is required — persistent webhooks need an auth token.

| Method | Flag | How It Works |
|--------|------|-------------|
| OAuth | `--oauth` | Auto-acquires M2M token via Key Vault + Auth0 (zero touch) |

## Usage

Webhook callbacks require a publicly reachable HTTPS endpoint. For prod, expose port 9876 via [ngrok](https://ngrok.com):
```bash
ngrok http 9876   # copy the https hostname e.g. abc123.ngrok.io
```

```bash
# 1. URL mode — prod demo audio, expect BOTH alert boxes (Respiratory ~99%, Sounds of things)
node packages/demo/demos/webhook.mjs --oauth --callback-host <ngrok-host>

# 2. Local file mode — multipart upload, same dual alert result
node packages/demo/demos/webhook.mjs --oauth --callback-host <ngrok-host> --file packages/demo/demos/demo-60s.mp3

# 3. Respiratory alert only — tier-values2 set to a class not in the audio (server won't fire it)
node packages/demo/demos/webhook.mjs --oauth --callback-host <ngrok-host> --tier-values2 "Gunshot, gunfire"

# 4. Sounds of things alert only — tier-values1 set to a class not in the audio
node packages/demo/demos/webhook.mjs --oauth --callback-host <ngrok-host> --tier-values1 "Gunshot, gunfire" --tier-depth1 3

# 5. Management smoke — health check + list webhooks (no listener started, no ngrok needed)
node packages/demo/demos/webhook.mjs --oauth --health --list-webhooks

# 6. Local Docker stack — no ngrok needed (processor reaches host via host.docker.internal)
node packages/demo/demos/webhook.mjs --oauth --env local
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--env <env>` | `prod` | Target environment: local, dev, staging, prod |
| `--oauth` | | OAuth token (required) |
| `--callback-host <host>` | | Public hostname for webhook delivery — required for cloud envs (e.g. ngrok host) |
| `--url <url>` | prod demo URL | Audio URL to classify |
| `--file <path>` | | Local audio file — overrides `--url` (multipart upload) |
| `--tier-values1 <name>` | `Respiratory sounds` | Webhook 1 `notificationTierValues` |
| `--tier-depth1 <n>` | `2` | Webhook 1 `notificationTierDepth` |
| `--tier-values2 <name>` | `Sounds of things` | Webhook 2 `notificationTierValues` |
| `--tier-depth2 <n>` | `1` | Webhook 2 `notificationTierDepth` |
| `--port <n>` | `9876` | Webhook listener port |
| `--timeout <s>` | `300` | Max wait for webhooks |
| `--filterMinDuration <s>` | (none) | Min event duration filter in seconds |
| `--deregister <id>` | | Delete a webhook |
| `--list-webhooks` | | List registered webhooks |
| `--ping <id>` | | Send test.ping to a webhook |
| `--deliveries <id>` | | Show delivery log for a webhook |
| `--events <types>` | `job.completed,job.failed` | Comma-separated event types to subscribe to |
| `--health` | | Check API health (`/v1/health`) |

## How It Works

```
demo-webhook                    API / Processor                  demo-webhook
─────────────────               ──────────────────               ────────────
1. Register webhook 1  ──────►  /enterprise/webhooks
   (Respiratory, depth:2)       ◄──  { webhookId }

2. Register webhook 2  ──────►  /enterprise/webhooks
   (Sounds of things, depth:1)  ◄──  { webhookId }

3. Submit audio        ──────►  /v1/classify
                                Queue → Processor → ML

4. Server fires        ◄──────  POST /respiratory
   webhook 1 only if            (Respiratory events exist)
   tier2=Respiratory

5. Server fires        ◄──────  POST /sounds-of-things
   webhook 2 only if            (Sounds of things events exist)
   tier1=Sounds of things

6. Display alert box            Deregister both webhooks
   for each received
```

The server applies `notificationTierDepth` / `notificationTierValues` filtering before dispatching. If no events in the job match the filter, the webhook is not fired at all.

## Default Webhooks

| # | Path | notificationTierDepth | notificationTierValues | Fires when |
|---|------|-----------------------|------------------------|------------|
| 1 | `/respiratory` | `2` | `['Respiratory sounds']` | job contains tier2=Respiratory sounds |
| 2 | `/sounds-of-things` | `1` | `['Sounds of things']` | job contains tier1=Sounds of things |

The demo audio contains both — Breathing at ~99% confidence and multiple Sounds of things events — so both webhooks fire by default.

## Webhook Payload (job.completed)

Actual shape sent by the processor:

```json
{
    "event": "job.completed",
    "jobId": "job-...",
    "classifications": [
        { "class": "Breathing_3", "confidence": 0.9999, "category": "Human sounds" },
        { "class": "Aircraft_1",  "confidence": 0.8627, "category": "Sounds of things" },
        { "class": "Explosion_8", "confidence": 0.6342, "category": "Sounds of things" }
    ],
    "eventCount": 37,
    "duration": 60.0,
    "timestamp": "2026-04-03T..."
}
```

`class` = sourceId (e.g. `"Breathing_3"`), `category` = tier1, `confidence` = 0–1.

## Enterprise API Endpoints Used

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/v1/classify` | POST | Bearer | Submit audio URL or file for classification |
| `/v1/health` | GET | None | API health check |
| `/enterprise/webhooks` | GET | Bearer | List registered webhooks |
| `/enterprise/webhooks` | POST | Bearer | Register persistent webhook with tier filter |
| `/enterprise/webhooks/{id}` | DELETE | Bearer | Delete a webhook |
| `/enterprise/webhooks/{id}/ping` | POST | Bearer | Send test ping |
| `/enterprise/webhooks/{id}/deliveries` | GET | Bearer | Delivery history |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HEAR_API_KEY` | | Enterprise API key (management commands only) |
| `API_URL_LOCAL` | `http://localhost:7071/api` | Local API URL |
| `API_URL_DEV` | | Dev API URL |
| `API_URL_STAGING` | | Staging API URL |
| `API_URL_PROD` | | Production API URL |
| `TLS_CERT_PATH` | `.certs/demo-cert.pem` | TLS cert for local Docker mode |
| `TLS_KEY_PATH` | `.certs/demo-cert-key.pem` | TLS key for local Docker mode |

## Prerequisites

- OAuth — `az login` or VS Code Azure account
- ngrok on port 9876 for cloud envs (`ngrok http 9876`), or `--env local` for Docker stack
- TLS cert at `.certs/demo-cert.pem` for local Docker mode (bundled dev cert covers `localhost` + `host.docker.internal`)
