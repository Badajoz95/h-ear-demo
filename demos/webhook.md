# demo-webhook.mjs

Enterprise Webhook Alert Demo. Submits audio to the classification API, receives webhook callback, checks for target sound classification.

## Usage

```bash
# Default: detect "Sounds of things > Vehicle" in the 30m dog/animal fixture
node packages/demo/demos/webhook.mjs --key <api-key>

# Alert on any Animal sound
node packages/demo/demos/webhook.mjs --key <key> --tier1 "Animal"

# Specific tier1 + class combination
node packages/demo/demos/webhook.mjs --key <key> --tier1 "Sounds of things" --class Vehicle

# Custom audio file
node packages/demo/demos/webhook.mjs --key <key> --file path/to/audio.mp3

# Only alert on events lasting >= 10 seconds
node packages/demo/demos/webhook.mjs --key <key> --filterMinDuration 10

# Against dev environment
node packages/demo/demos/webhook.mjs --env dev --key <key>
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--env <env>` | `local` | Target environment: local, dev, staging, prod |
| `--key <key>` | | Enterprise API key (required) |
| `--file <path>` | `output/fixture-inspection/smoke-animal-dog-30m.mp3` | Audio file to submit |
| `--tier1 <name>` | `Sounds of things` | YAMNet tier1 category to alert on |
| `--class <name>` | `Vehicle` | YAMNet class name to alert on |
| `--port <n>` | `9876` | Webhook listener port |
| `--timeout <s>` | `300` | Max wait for webhook callback |
| `--filterMinDuration <s>` | (none) | Min event duration filter in seconds |

## Flow

```
                    +----------------+
                    |  demo-webhook  |
                    |    (this)      |
                    +---+--------+---+
                        |        ^
             1. POST    |        |  4. POST callback
           /v1/classify |        |     (job.completed)
                        v        |
                    +------------+---+
                    |      API       |
                    |  (v1/classify) |
                    +------+---------+
                           |
                  2. Queue |
                           v
                    +----------------+
                    |   Processor    |
                    |   (Docker)     |---- 3. ML Analysis
                    +----------------+
```

1. Script starts HTTPS listener on port 9876
2. Submits audio to `/v1/classify` with `callbackUrl=https://host.docker.internal:9876/webhook`
3. API queues job, processor picks up and runs ML analysis
4. Processor fires webhook callback with `job.completed` payload
5. Listener receives payload, checks classifications against target tier1/class
6. Displays ALERT box if target sound detected

## Webhook Payload (job.completed)

```json
{
    "event": "job.completed",
    "jobId": "ent-...",
    "classifications": [
        { "class": "Vehicle", "confidence": 0.87, "category": "Sounds of things" },
        { "class": "Dog", "confidence": 0.95, "category": "Animal" }
    ],
    "eventCount": 42,
    "duration": 1800.0,
    "timestamp": "2026-03-07T..."
}
```

`category` = YAMNet tier1, `class` = specific sound class.

When `filterMinDurationSeconds` is set on the request, only events where `(endTime - startTime) >= filterMinDurationSeconds` are included in `classifications`. The payload includes `filterApplied: true`, the filter value, and `unfilteredEventCount` showing pre-filter totals. Audio must be >= 5s and filter must not exceed audio duration.

## Alert Matching

Matching is case-insensitive substring on both `category` (tier1) and `class`:
- `--tier1 "Sounds of things" --class Vehicle` matches `{ class: "Vehicle", category: "Sounds of things" }`
- `--tier1 "Animal"` matches any classification under the Animal tier1

## Networking (Local)

Processor runs in Docker. For the webhook callback to reach the host:
- Local: `callbackUrl=https://host.docker.internal:9876/webhook`
- Cloud: requires a public endpoint (ngrok, etc.)

## Prerequisites

- API running (local or cloud environment)
- Processor running (Docker)
- Port 9876 available
- TLS certificate for the webhook listener (e.g. mkcert for localhost)
- Valid Enterprise API key for target environment
