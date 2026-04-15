# demo-webcam.mjs

TP-Link Tapo C100 -> Edge Audio Acquisition Demo.

Captures audio from a Wi-Fi camera's RTSP stream and uploads to the classification API (`v1/classify`).

## Authentication

| Method | Flag | How It Works |
|--------|------|-------------|
| OAuth | `--oauth` | OAuth 2.1 Authorization Code + PKCE via Auth0 (browser login, then cached) |
| API Key | `--key <key>` | Enterprise API key (`X-NCM-Api-Key` header) |

OAuth opens a browser for Auth0 login on first run. Token is cached at `~/.h-ear/token-{env}.json` and silently refreshed on subsequent runs (zero touch).

## Usage

```bash
# Probe camera (local API)
node packages/demo/demos/webcam.mjs --probe

# Capture 10s audio only
node packages/demo/demos/webcam.mjs --capture --duration 10

# Capture + upload (fire-and-forget, async 202)
node packages/demo/demos/webcam.mjs --full --key <api-key>

# Capture + upload + poll for results
node packages/demo/demos/webcam.mjs --full --key <key> --poll

# OAuth (zero touch — browser login, then cached)
node packages/demo/demos/webcam.mjs --full --oauth

# OAuth against prod
node packages/demo/demos/webcam.mjs --env prod --full --oauth

# Capture all files first, then upload all (batch pattern)
node packages/demo/demos/webcam.mjs --full --key <key> --gather

# Multiple jobs with interval
node packages/demo/demos/webcam.mjs --full --key <key> --jobs 3 --duration 5 --interval 10

# Target a different environment
node packages/demo/demos/webcam.mjs --env dev --full --key <key>

# API health check (no auth required)
node packages/demo/demos/webcam.mjs --health --env dev

# List available sound classes (no auth required)
node packages/demo/demos/webcam.mjs --classes

# Show API usage/quota
node packages/demo/demos/webcam.mjs --usage --key <key>

# Retrieve results for an existing job
node packages/demo/demos/webcam.mjs --job <jobId> --key <key>

# Retrieve classification events for a job
node packages/demo/demos/webcam.mjs --events <jobId> --key <key>
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--env <env>` | `local` | Target environment: local, dev, staging, prod |
| `--probe` | | Test camera RTSP connectivity |
| `--capture` | | Capture audio from camera |
| `--upload` | | Upload captured audio |
| `--full` | | capture + upload (end-to-end) |
| `--key <key>` | | Enterprise API key (`X-NCM-Api-Key` header) |
| `--oauth` | | OAuth 2.1 + PKCE via Auth0 (browser login, cached) |
| `--duration <s>` | `30` | Capture duration per job in seconds |
| `--jobs <n>` | `3` | Number of jobs to send |
| `--interval <s>` | `20` | Seconds between jobs |
| `--poll` | | Poll `/v1/jobs/{id}` for results after async submit |
| `--await` | | Alias for `--poll` (backward compat) |
| `--gather` | | Capture all files first, then upload all (edge batch pattern) |
| `--health` | | Check API health (`/v1/health`) before pipeline |
| `--usage` | | Show API usage/quota (`/v1/usage`) after pipeline |
| `--classes` | | List available sound classes (`/v1/classes`) and exit |
| `--job <jobId>` | | Retrieve results for an existing job and exit |
| `--events <jobId>` | | Retrieve classification events for a job and exit |

## Modes

### Default (interleaved, async)
Captures audio then immediately uploads with `callbackUrl` (202 fire-and-forget). Generates data for Dashboard demo. Each job is capture -> upload in sequence.

### --poll (async submit + poll)
Submits audio async (202), then polls `GET /v1/jobs/{id}` with exponential backoff until job completes. Displays full classification results. Replaces the legacy `--await` mode.

### --gather (batch)
Edge device pattern: captures all N audio files first, then uploads all sequentially. Useful for scenarios where acquisition and upload are decoupled.

### --classes / --job / --events (standalone queries)
Query API endpoints directly without capturing audio. Useful for inspecting available classes, checking job status, or reviewing classification events.

## Enterprise API Endpoints Used

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/v1/classify` | POST | Required | Submit audio for classification (multipart/form-data) |
| `/v1/health` | GET | None | API health check |
| `/v1/classes` | GET | None | List available sound classes by taxonomy |
| `/v1/usage` | GET | Required | Account usage and quota statistics |
| `/v1/jobs/{id}` | GET | Required | Job status and results (used by --poll) |
| `/v1/jobs/{id}/events` | GET | Required | Classification events for a completed job |

## Camera

- **Model**: TP-Link Tapo C100 (Home Security Wi-Fi Camera)
- **RTSP**: `rtsp://<user>:<pass>@<camera-ip>/stream1`
- **Audio**: pcm_alaw 8000Hz 1ch (resampled to 16kHz mono PCM WAV for classification)
- **Video**: h264 640x360

## Architecture

- **Edge Device -> Enterprise API**: Camera captures audio, script uploads via REST
- **Upload method**: multipart/form-data
- **Async pattern**: POST returns 202, poll `/v1/jobs/{id}` for results (`--poll`)
- **Output**: `output/demo-webcam/`
- **GPS**: Randomised within 10km of a configurable centre point per upload

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CAMERA_HOST` | `192.168.0.100` | Camera IP address |
| `CAMERA_USER` | `admin` | Camera RTSP username |
| `CAMERA_PASS` | `changeme` | Camera RTSP password |
| `HEAR_API_KEY` | | Enterprise API key |
| `ENTERPRISE_API_KEY` | | Enterprise API key (legacy) |
| `API_URL_LOCAL` | `http://localhost:7071/api` | Local API URL |
| `API_URL_DEV` | | Dev API URL |
| `API_URL_STAGING` | | Staging API URL |
| `API_URL_PROD` | | Production API URL |

## Prerequisites

- ffmpeg + ffprobe in PATH
- Camera RTSP enabled (Tapo app -> Advanced Settings -> Camera Account)
- `--oauth` (browser login via Auth0, cached after first run) or `--key <api-key>` for the target environment
