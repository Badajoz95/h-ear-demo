#!/usr/bin/env node
/**
 * demo-webhook.mjs - Enterprise Webhook Alert Demo
 *
 * Demonstrates the webhook flow end-to-end:
 *   1. Starts a local HTTPS server (webhook receiver, mkcert)
 *   2. Submits a known audio file via Enterprise API with callbackUrl
 *   3. Processor analyses audio, fires webhook on job.completed
 *   4. Webhook receiver checks classifications for target sound
 *   5. Displays ALERT if target sound is detected
 *
 * Uses per-request callbackUrl (API key auth) for simplicity.
 *
 * Usage:
 *   node packages/demo/demos/webhook.mjs --key <api-key>                                    # Default: Vehicle detection
 *   node packages/demo/demos/webhook.mjs --key <key> --tier1 "Animal"                       # Alert on any Animal
 *   node packages/demo/demos/webhook.mjs --key <key> --tier1 "Sounds of things" --class Vehicle
 *   node packages/demo/demos/webhook.mjs --key <key> --file output/fixture-inspection/smoke-animal-dog-30m.mp3
 *   node packages/demo/demos/webhook.mjs --env dev --key <key>                              # Against dev environment
 *
 * Prerequisites:
 *   - API running (local or cloud)
 *   - Processor running (local: Docker)
 *   - Port 9876 available (webhook listener)
 *   - TLS cert for webhook listener (e.g. mkcert localhost)
 */

import https from 'https';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

// --- Defaults --------------------------------------------------------------------

const WEBHOOK_PORT = 9876;
const DEFAULT_AUDIO = join(PROJECT_ROOT, 'output', 'fixture-inspection', 'smoke-animal-dog-30m.mp3');
const DEFAULT_TIER1 = 'Sounds of things';
const DEFAULT_CLASS = 'Vehicle';
const VALID_ENVS = ['local', 'dev', 'staging', 'prod'];

// --- API Environment Configuration -----------------------------------------------
const API_URLS = {
    local:   process.env.API_URL_LOCAL   || 'http://localhost:7071/api',
    dev:     process.env.API_URL_DEV     || '',
    staging: process.env.API_URL_STAGING || '',
    prod:    process.env.API_URL_PROD    || '',
};

// --- TLS Certificate Paths -------------------------------------------------------
// Generate with: mkcert localhost 127.0.0.1 ::1
const TLS_CERT = process.env.TLS_CERT_PATH || join(PROJECT_ROOT, '.certs', 'localhost.pem');
const TLS_KEY  = process.env.TLS_KEY_PATH  || join(PROJECT_ROOT, '.certs', 'localhost-key.pem');

// --- State -----------------------------------------------------------------------

let API_BASE_URL = '';
let API_KEY = '';
let webhookReceived = null;
let webhookServer = null;

// --- Helpers ---------------------------------------------------------------------

function log(emoji, msg) {
    console.log(`  ${emoji} ${msg}`);
}

function logSection(title) {
    console.log(`\n  -- ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
}

function parseArgs() {
    const args = process.argv.slice(2);
    const get = (flag) => {
        const idx = args.indexOf(flag);
        return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
    };
    const env = get('--env') || 'local';
    if (!VALID_ENVS.includes(env)) {
        console.error(`  Invalid env: ${env}. Valid: ${VALID_ENVS.join(', ')}`);
        process.exit(1);
    }
    const filterMinDuration = get('--filterMinDuration');
    return {
        env,
        key: get('--key'),
        file: get('--file') || DEFAULT_AUDIO,
        tier1: get('--tier1') || DEFAULT_TIER1,
        class_: get('--class') || DEFAULT_CLASS,
        port: parseInt(get('--port') || String(WEBHOOK_PORT), 10),
        timeout: parseInt(get('--timeout') || '300', 10),
        filterMinDuration: filterMinDuration ? parseFloat(filterMinDuration) : undefined,
        help: args.includes('--help') || args.includes('-h') || args.length === 0,
    };
}

// --- Environment Bootstrap -------------------------------------------------------

function resolveEnvironment(env) {
    logSection(`Environment (${env})`);

    const apiUrl = API_URLS[env];
    if (!apiUrl) {
        log('❌', `No API URL configured for env: ${env}`);
        log('🔍', `Set API_URL_${env.toUpperCase()} environment variable`);
        process.exit(1);
    }

    log('🌐', `Target: ${env}`);
    log('🌐', `API: ${apiUrl}`);

    return { apiUrl };
}

// --- Webhook Listener ------------------------------------------------------------

function startWebhookListener(port) {
    return new Promise((resolve) => {
        if (!existsSync(TLS_CERT) || !existsSync(TLS_KEY)) {
            log('❌', `TLS cert not found: ${TLS_CERT}`);
            log('🔍', 'Generate with: mkcert localhost 127.0.0.1 ::1');
            log('🔍', 'Or set TLS_CERT_PATH and TLS_KEY_PATH environment variables');
            process.exit(1);
        }

        const tlsOptions = {
            cert: readFileSync(TLS_CERT),
            key: readFileSync(TLS_KEY),
        };

        webhookServer = https.createServer(tlsOptions, (req, res) => {
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => {
                    try {
                        const payload = JSON.parse(body);

                        logSection('WEBHOOK RECEIVED');
                        log('📨', `Event: ${payload.event}`);
                        log('🏷️', `Job ID: ${payload.jobId}`);
                        log('📡', `Delivery: ${req.headers['x-delivery-id'] || 'per-request'}`);
                        log('🔐', `Signature: ${req.headers['x-signature'] || 'none'}`);

                        if (payload.event === 'job.completed') {
                            log('⏱️', `Duration: ${(payload.duration || 0).toFixed(1)}s`);
                            log('📊', `Events: ${payload.eventCount || 0}`);
                            if (payload.filterApplied) {
                                log('🔍', `Duration filter: >= ${payload.filterMinDurationSeconds}s (${payload.unfilteredEventCount} total -> ${payload.eventCount} filtered)`);
                            }

                            if (payload.classifications?.length > 0) {
                                log('🤖', `Classifications (${payload.classifications.length}):`);
                                payload.classifications.slice(0, 15).forEach((c, i) => {
                                    const conf = c.confidence != null ? `${(c.confidence * 100).toFixed(0)}%` : '?';
                                    const cat = c.category ? ` [${c.category}]` : '';
                                    log('  ', `  ${i + 1}. ${c.class} (${conf})${cat}`);
                                });
                            }
                        }

                        if (payload.event === 'job.failed') {
                            log('🧨', `Error: ${payload.error}`);
                        }

                        webhookReceived = payload;
                    } catch (e) {
                        log('⚠️', `Failed to parse webhook: ${e.message}`);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ received: true }));
                });
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        webhookServer.listen(port, () => {
            log('📡', `Webhook HTTPS listener started on port ${port}`);
            resolve(webhookServer);
        });
    });
}

// --- Alert Engine ----------------------------------------------------------------

function checkAlert(payload, targetTier1, targetClass) {
    if (!payload || payload.event !== 'job.completed') return null;

    const matches = (payload.classifications || []).filter(c => {
        const tier1Match = !targetTier1 || (c.category || '').toLowerCase().includes(targetTier1.toLowerCase());
        const classMatch = !targetClass || (c.class || '').toLowerCase().includes(targetClass.toLowerCase());
        return tier1Match && classMatch;
    });

    return matches.length > 0 ? matches : null;
}

// --- Submit Audio ----------------------------------------------------------------

async function submitAudio(audioFile, callbackUrl, args = {}) {
    logSection('Submitting Audio to Enterprise API');

    const audioBuffer = readFileSync(audioFile);
    const base64Audio = audioBuffer.toString('base64');
    const fileName = basename(audioFile);
    const sizeMB = (audioBuffer.length / 1024 / 1024).toFixed(2);

    log('📤', `POST ${API_BASE_URL}/v1/classify`);
    log('🔐', `API Key: ${API_KEY.substring(0, 8)}...`);
    log('📥', `File: ${fileName} (${sizeMB} MB)`);
    log('📡', `Callback: ${callbackUrl}`);
    if (args.filterMinDuration) {
        log('🔍', `Duration filter: >= ${args.filterMinDuration}s`);
    }

    const payload = {
        base64: base64Audio,
        fileName,
        callbackUrl,
        ...(args.filterMinDuration && { filterMinDurationSeconds: args.filterMinDuration }),
    };

    const response = await fetch(`${API_BASE_URL}/v1/classify`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': API_KEY,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
    });

    const result = await response.json();

    if (!response.ok && response.status !== 202) {
        log('❌', `API returned ${response.status}: ${result.error || result.message}`);
        if (result.code === 'INVALID_API_KEY') {
            log('🔍', 'Check your --key value');
        }
        return null;
    }

    log('✅', `API accepted (${response.status})`);
    log('🏷️', `Request ID: ${result.requestId}`);
    log('📊', `Status: ${result.status}`);
    log('⏱️', 'Waiting for processor to complete and fire webhook...');

    return result;
}

// --- Main ------------------------------------------------------------------------

async function main() {
    const args = parseArgs();

    console.log('\n  Webhook Alert Demo');
    console.log('  ══════════════════════');
    log('🎯', `Alert target: ${args.tier1} > ${args.class_}`);
    log('🌐', `Target env: ${args.env}`);
    if (args.filterMinDuration) {
        log('🔍', `Duration filter: events >= ${args.filterMinDuration}s`);
    }

    if (args.help) {
        console.log(`
  Usage:
    node packages/demo/demos/webhook.mjs --key <api-key>                                     Vehicle detection (default)
    node packages/demo/demos/webhook.mjs --key <key> --tier1 "Animal"                         Alert on any Animal
    node packages/demo/demos/webhook.mjs --key <key> --tier1 "Sounds of things" --class Vehicle
    node packages/demo/demos/webhook.mjs --key <key> --file <audio.mp3>                       Custom audio file
    node packages/demo/demos/webhook.mjs --env dev --key <key>                                Against dev environment

  Options:
    --env <env>        Target environment: local, dev, staging, prod (default: local)
    --key <api-key>    Enterprise API key (REQUIRED)
    --file <path>      Audio file to submit (default: smoke-animal-dog-30m.mp3)
    --tier1 <name>     YAMNet tier1 category to alert on (default: "Sounds of things")
    --class <name>     YAMNet class name to alert on (default: "Vehicle")
    --port <n>         Webhook listener port (default: 9876)
    --timeout <s>      Max wait for webhook (default: 300s)
    --filterMinDuration <s>  Min event duration filter in seconds (default: none)

  Environment variables:
    API_URL_LOCAL        Local API URL (default: http://localhost:7071/api)
    API_URL_DEV          Dev API URL
    API_URL_STAGING      Staging API URL
    API_URL_PROD         Production API URL
    TLS_CERT_PATH        Path to TLS certificate PEM
    TLS_KEY_PATH         Path to TLS private key PEM

  Flow:
    1. Start local HTTPS listener on port 9876
    2. POST audio to /v1/classify with callbackUrl -> host.docker.internal:9876
    3. Processor analyses audio, fires webhook callback
    4. Receiver checks for target classification
    5. ALERT if target sound detected
`);
        process.exit(0);
    }

    if (!args.key) {
        log('❌', 'Enterprise API key required. Use --key <api-key>');
        process.exit(1);
    }

    if (!existsSync(args.file)) {
        log('❌', `Audio file not found: ${args.file}`);
        process.exit(1);
    }

    // Resolve API environment
    const { apiUrl } = resolveEnvironment(args.env);
    API_BASE_URL = apiUrl;
    API_KEY = args.key;

    // Start webhook listener
    logSection('Webhook Listener');
    await startWebhookListener(args.port);

    // Processor runs in Docker — use host.docker.internal to reach host listener
    // For cloud envs this would be a public URL (ngrok, etc.)
    const callbackHost = args.env === 'local' ? 'host.docker.internal' : 'localhost';
    const callbackUrl = `https://${callbackHost}:${args.port}/webhook`;

    // Submit audio
    const submitResult = await submitAudio(args.file, callbackUrl, args);
    if (!submitResult) {
        webhookServer?.close();
        process.exit(1);
    }

    // Wait for webhook
    logSection('Awaiting Webhook Callback');
    log('⏱️', `Timeout: ${args.timeout}s`);

    const startMs = Date.now();
    const timeoutMs = args.timeout * 1000;

    while (!webhookReceived && (Date.now() - startMs) < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
        if (elapsed % 10 === 0 && elapsed > 0) {
            process.stdout.write(`\r  ⏱️ Waiting... ${elapsed}s`);
        }
    }
    process.stdout.write('\r');

    if (!webhookReceived) {
        log('❌', `Timeout — no webhook received after ${args.timeout}s`);
        log('🔍', 'Check: processor running? Docker can reach host.docker.internal?');
        webhookServer?.close();
        process.exit(1);
    }

    // Check for target alert
    logSection('Alert Check');
    log('🎯', `Looking for: ${args.tier1} > ${args.class_}`);

    const alertMatches = checkAlert(webhookReceived, args.tier1, args.class_);

    if (alertMatches) {
        console.log('');
        console.log('  ╔══════════════════════════════════════════════╗');
        console.log('  ║          🚨  ALERT TRIGGERED  🚨            ║');
        console.log('  ╠══════════════════════════════════════════════╣');
        for (const m of alertMatches.slice(0, 5)) {
            const conf = (m.confidence * 100).toFixed(0);
            console.log(`  ║  ${m.class} (${conf}%) [${m.category}]`.padEnd(49) + '║');
        }
        console.log('  ╚══════════════════════════════════════════════╝');
        console.log('');
        log('📡', `${alertMatches.length} matching event(s) found`);
        log('📡', 'In production: this would trigger SMS/email/PagerDuty/Home Assistant');
    } else {
        log('✅', 'No matching events — target sound not detected in this audio');
        if (webhookReceived.classifications?.length > 0) {
            log('📊', `Detected instead:`);
            webhookReceived.classifications.slice(0, 5).forEach(c => {
                log('  ', `  ${c.class} (${(c.confidence * 100).toFixed(0)}%) [${c.category}]`);
            });
        }
    }

    // Summary
    logSection('Done');
    const totalMs = Date.now() - startMs;
    log('⏱️', `Total time: ${(totalMs / 1000).toFixed(1)}s`);
    log('🏷️', `Job: ${webhookReceived.jobId}`);
    log('✅', 'Live long and alert.');

    webhookServer?.close();
}

main().catch(err => {
    console.error('\n  Fatal:', err.message);
    webhookServer?.close();
    process.exit(1);
});
