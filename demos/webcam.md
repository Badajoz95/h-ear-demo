# demo-webcam.mjs

TP-Link Tapo C100 -> Edge Audio Acquisition Demo.

Captures audio from a Wi-Fi camera's RTSP stream and uploads to the classification API (`v1/classify`).

## Usage

```bash
# Probe camera (local API)
node packages/demo/demos/webcam.mjs --probe

# Capture 10s audio only
node packages/demo/demos/webcam.mjs --capture --duration 10

# Capture + upload (fire-and-forget, async 202)
node packages/demo/demos/webcam.mjs --full --key <api-key>

# Capture + upload + show AI results (sync 200)
node packages/demo/demos/webcam.mjs --full --key <key> --await

# Capture all files first, then upload all (batch pattern)
node packages/demo/demos/webcam.mjs --full --key <key> --gather

# Multiple jobs with interval
node packages/demo/demos/webcam.mjs --full --key <key> --jobs 3 --duration 5 --interval 10

# Target a different environment
node packages/demo/demos/webcam.mjs --env dev --full --key <key>
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--env <env>` | `local` | Target environment: local, dev, staging, prod |
| `--probe` | | Test camera RTSP connectivity |
| `--capture` | | Capture audio from camera |
| `--upload` | | Upload captured audio |
| `--full` | | capture + upload (end-to-end) |
| `--key <key>` | | Enterprise API key (required for upload) |
| `--duration <s>` | `30` | Capture duration per job in seconds |
| `--jobs <n>` | `3` | Number of jobs to send |
| `--interval <s>` | `20` | Seconds between jobs |
| `--await` | | Wait for AI results (sync mode) instead of fire-and-forget |
| `--gather` | | Capture all files first, then upload all (edge batch pattern) |

## Modes

### Default (interleaved, async)
Captures audio then immediately uploads with `callbackUrl` (202 fire-and-forget). Generates data for Dashboard demo. Each job is capture -> upload in sequence.

### --await (sync)
Drops `callbackUrl` -> API polls internally -> returns 200 with full classification results: duration, noise events, classifications, event count, processing time.

### --gather (batch)
Edge device pattern: captures all N audio files first, then uploads all sequentially. Useful for scenarios where acquisition and upload are decoupled.

## Camera

- **Model**: TP-Link Tapo C100 (Home Security Wi-Fi Camera)
- **RTSP**: `rtsp://<user>:<pass>@<camera-ip>/stream1`
- **Audio**: pcm_alaw 8000Hz 1ch (resampled to 16kHz mono PCM WAV for classification)
- **Video**: h264 640x360

## Architecture

- **Edge Device -> Enterprise API**: Camera captures audio, script uploads via REST
- **Output**: `output/demo-webcam/`
- **GPS**: Randomised within 10km of a configurable centre point per upload

## Prerequisites

- ffmpeg + ffprobe in PATH
- Camera RTSP enabled (Tapo app -> Advanced Settings -> Camera Account)
- API key for the target environment
