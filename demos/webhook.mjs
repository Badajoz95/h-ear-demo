#!/usr/bin/env node
/**
 * demo-webhook.mjs - Notification Alert Demo
 *
 * Demonstrates server-side webhook tier filtering:
 *   1. Registers two persistent webhooks with notificationTierDepth/Values
 *   2. Submits audio to the Enterprise API
 *   3. Server fires each webhook only when matching tier events exist in the job
 *   4. Displays alert box for each webhook the server fires
 *
 * Default registered webhooks:
 *   Webhook 1: Respiratory sounds (notificationTierDepth:2, tierValues:['Respiratory sounds'])
 *   Webhook 2: Sounds of things  (notificationTierDepth:1, tierValues:['Sounds of things'])
 *
 * Default audio: https://www.h-ear.world/demo/demo-60s-fixture-1.mp3
 * Local bundled:  demos/demo-60s.mp3
 *
 * Usage:
 *   node packages/demo/demos/webhook.mjs --oauth --callback-host <ngrok-host>
 *   node packages/demo/demos/webhook.mjs --oauth --callback-host <host> --file demos/demo-60s.mp3
 *   node packages/demo/demos/webhook.mjs --oauth --env local
 *
 * Prerequisites:
 *   - OAuth (--oauth) — persistent webhooks require auth token
 *   - ngrok on port 9876 for prod (or --env local for Docker stack)
 */

import https from 'https';
import http from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { acquireOAuthToken, resolveApiUrl } from './demo-auth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Defaults --------------------------------------------------------------------

const WEBHOOK_PORT = 9876;
const DEFAULT_AUDIO_URL = 'https://www.h-ear.world/demo/demo-60s-fixture-1.mp3';
const VALID_ENVS = ['local', 'dev', 'staging', 'prod'];

// --- API Environment Configuration -----------------------------------------------
const API_URLS = {
    local:   process.env.API_URL_LOCAL   || 'http://localhost:7071/api',
    dev:     process.env.API_URL_DEV     || '',
    staging: process.env.API_URL_STAGING || '',
    prod:    process.env.API_URL_PROD    || '',
};

// --- TLS Certificate Paths (local Docker mode only) ------------------------------
const TLS_CERT = process.env.TLS_CERT_PATH || join(__dirname, '..', '..', '..', '.certs', 'demo-cert.pem');
const TLS_KEY  = process.env.TLS_KEY_PATH  || join(__dirname, '..', '..', '..', '.certs', 'demo-cert-key.pem');

// --- State -----------------------------------------------------------------------

let API_BASE_URL = '';
let BEARER_TOKEN = '';
let API_KEY = '';
let webhookServer = null;
const receivedAlerts = {};      // path → payload
const registeredWebhooks = [];  // { webhookId, path, label } for cleanup

// --- Auth Helpers ----------------------------------------------------------------

function buildAuthHeaders(contentType = 'application/json') {
    const h = {};
    if (contentType) h['Content-Type'] = contentType;
    if (BEARER_TOKEN) {
        h['Authorization'] = `Bearer ${BEARER_TOKEN}`;
    } else if (API_KEY) {
        h['X-NCM-Api-Key'] = API_KEY;
    }
    return h;
}

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
    const env = get('--env') || 'prod';
    if (!VALID_ENVS.includes(env)) {
        console.error(`  Invalid env: ${env}. Valid: ${VALID_ENVS.join(', ')}`);
        process.exit(1);
    }
    const filterMinDuration = get('--filterMinDuration');
    return {
        env,
        key:          get('--key'),
        oauth:        args.includes('--oauth'),
        // Audio source — --file takes precedence over --url
        file:         get('--file'),
        url:          get('--url') || DEFAULT_AUDIO_URL,
        // Webhook options
        callbackHost: get('--callback-host'),
        port:         parseInt(get('--port') || String(WEBHOOK_PORT), 10),
        timeout:      parseInt(get('--timeout') || '300', 10),
        filterMinDuration: filterMinDuration ? parseFloat(filterMinDuration) : undefined,
        // Webhook 1 — Respiratory sounds
        tierValues1:  get('--tier-values1') || 'Respiratory sounds',
        tierDepth1:   parseInt(get('--tier-depth1') || '2'),
        // Webhook 2 — Sounds of things
        tierValues2:  get('--tier-values2') || 'Sounds of things',
        tierDepth2:   parseInt(get('--tier-depth2') || '1'),
        // Management commands
        deregister:   get('--deregister'),
        listWebhooks: args.includes('--list-webhooks'),
        ping:         get('--ping'),
        deliveries:   get('--deliveries'),
        events:       get('--events') || 'job.completed,job.failed',
        health:       args.includes('--health'),
        help:         args.includes('--help') || args.includes('-h') || args.length === 0,
    };
}

// --- Environment Bootstrap -------------------------------------------------------

function resolveEnvironment(env) {
    logSection(`Environment (${env})`);
    const apiUrl = API_URLS[env] || resolveApiUrl(env);
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

function handleWebhookRequest(req, res, path) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        try {
            logSection(`WEBHOOK RECEIVED → ${path}`);
            log('📨', `Event: ${req.headers['x-ncm-event'] || 'unknown'}`);
            log('🏷️', `Delivery ID: ${req.headers['x-ncm-delivery-id'] || 'N/A'}`);
            log('⏱️', `Timestamp: ${req.headers['x-ncm-timestamp'] || 'N/A'}`);

            const payload = JSON.parse(body);

            if (payload.event === 'job.completed') {
                log('🏷️', `Job ID: ${payload.jobId}`);
                log('📊', `Events: ${payload.eventCount || 0}`);
                if (payload.classifications?.length > 0) {
                    log('🤖', `Classifications (${payload.classifications.length}):`);
                    payload.classifications.slice(0, 10).forEach((c, i) => {
                        const conf = c.confidence != null ? `${(c.confidence * 100).toFixed(0)}%` : '?';
                        const cat  = c.category ? ` [${c.category}]` : '';
                        log('  ', `  ${i + 1}. ${c.class} (${conf})${cat}`);
                    });
                }
                receivedAlerts[path] = payload;
            } else if (payload.event === 'job.failed') {
                log('🧨', `Job failed: ${payload.error}`);
                receivedAlerts[path] = payload;
            }
        } catch (e) {
            log('⚠️', `Failed to parse webhook: ${e.message}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
    });
}

function startWebhookListener(port, useExternalHost = false) {
    return new Promise((resolve) => {
        const handler = (req, res) => {
            if (req.method === 'POST') {
                handleWebhookRequest(req, res, req.url);
            } else {
                res.writeHead(404);
                res.end();
            }
        };

        if (useExternalHost) {
            // ngrok terminates TLS externally — plain HTTP listener
            webhookServer = http.createServer(handler);
            webhookServer.listen(port, () => {
                log('📡', `Webhook HTTP listener on port ${port} (TLS via ngrok)`);
                resolve(webhookServer);
            });
        } else {
            // Local Docker mode — HTTPS (processor reaches via host.docker.internal)
            if (!existsSync(TLS_CERT) || !existsSync(TLS_KEY)) {
                log('❌', `TLS cert not found: ${TLS_CERT}`);
                log('🔍', 'Run: openssl req -x509 -newkey rsa:2048 -keyout .certs/demo-cert-key.pem -out .certs/demo-cert.pem -days 3650 -nodes -subj "//CN=localhost"');
                process.exit(1);
            }
            webhookServer = https.createServer({ cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) }, handler);
            webhookServer.listen(port, () => {
                log('📡', `Webhook HTTPS listener on port ${port}`);
                resolve(webhookServer);
            });
        }
    });
}

// --- Webhook Registration --------------------------------------------------------

async function registerWebhook(url, events, tierDepth, tierValues, description) {
    const endpoint = `${API_BASE_URL}/enterprise/webhooks`;
    log('📡', `POST ${endpoint}`);
    log('📡', `URL: ${url}`);
    log('📡', `Tier filter: depth=${tierDepth} values=${JSON.stringify([tierValues])}`);

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: buildAuthHeaders(),
        body: JSON.stringify({
            url,
            events,
            notificationTierDepth: tierDepth,
            notificationTierValues: [tierValues],
            description,
        }),
        signal: AbortSignal.timeout(15000),
    });

    const result = await response.json();
    if (!response.ok) {
        log('❌', `Registration failed (${response.status}): ${result.error || response.statusText}`);
        return null;
    }

    log('✅', `Registered: ${result.webhook?.id || result.webhookId}`);
    return result;
}

async function deregisterWebhook(webhookId) {
    const endpoint = `${API_BASE_URL}/enterprise/webhooks/${webhookId}`;
    try {
        const response = await fetch(endpoint, {
            method: 'DELETE',
            headers: buildAuthHeaders(),
            signal: AbortSignal.timeout(10000),
        });
        if (response.ok) {
            log('🧹', `Deregistered: ${webhookId}`);
        }
    } catch (e) {
        log('⚠️', `Deregister failed: ${e.message}`);
    }
}

async function cleanupWebhooks() {
    for (const wh of registeredWebhooks) {
        await deregisterWebhook(wh.webhookId);
    }
    registeredWebhooks.length = 0;
}

// --- Management commands ---------------------------------------------------------

async function checkHealth() {
    logSection('API Health Check');
    const endpoint = `${API_BASE_URL}/v1/health`;
    log('📡', `GET ${endpoint}`);
    try {
        const response = await fetch(endpoint, { method: 'GET', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000) });
        const result = await response.json();
        if (!response.ok) { log('❌', `Health check failed (${response.status}): ${result.error}`); return; }
        log('✅', `Status: ${result.status}`);
        if (result.version) log('📊', `Version: ${result.version}`);
    } catch (e) { log('❌', `Health check failed: ${e.message}`); }
}

async function listWebhooks() {
    logSection('Registered Webhooks');
    const endpoint = `${API_BASE_URL}/enterprise/webhooks`;
    log('📡', `GET ${endpoint}`);
    try {
        const response = await fetch(endpoint, { method: 'GET', headers: buildAuthHeaders(), signal: AbortSignal.timeout(10000) });
        const result = await response.json();
        if (!response.ok) { log('❌', `List failed (${response.status}): ${result.error}`); return; }
        const webhooks = result.webhooks || [];
        if (webhooks.length === 0) { log('📊', 'No webhooks registered'); return; }
        log('📊', `${webhooks.length} webhook(s):`);
        for (const wh of webhooks) {
            log('  ', `  ${wh.id} | ${wh.status} | depth:${wh.notificationTierDepth || '-'} | ${wh.url}`);
        }
    } catch (e) { log('❌', `List failed: ${e.message}`); }
}

async function listDeliveries(webhookId) {
    logSection(`Deliveries: ${webhookId}`);
    const endpoint = `${API_BASE_URL}/enterprise/webhooks/${webhookId}/deliveries`;
    try {
        const response = await fetch(endpoint, { method: 'GET', headers: buildAuthHeaders(), signal: AbortSignal.timeout(10000) });
        const result = await response.json();
        if (!response.ok) { log('❌', `Deliveries failed (${response.status}): ${result.error}`); return; }
        const deliveries = result.deliveries || [];
        if (deliveries.length === 0) { log('📊', 'No deliveries found'); return; }
        log('📊', `${deliveries.length} delivery(ies):`);
        for (const d of deliveries.slice(0, 20)) {
            log('  ', `  ${d.success ? '✅' : '❌'} ${d.id} | ${d.event} | ${d.responseStatus || 'N/A'} | ${d.createdAt || ''}`);
        }
    } catch (e) { log('❌', `Deliveries failed: ${e.message}`); }
}

async function pingWebhook(webhookId) {
    logSection(`Ping: ${webhookId}`);
    const endpoint = `${API_BASE_URL}/enterprise/webhooks/${webhookId}/ping`;
    try {
        const response = await fetch(endpoint, { method: 'POST', headers: buildAuthHeaders(), signal: AbortSignal.timeout(10000) });
        const result = await response.json();
        if (!response.ok) { log('❌', `Ping failed (${response.status}): ${result.error}`); return; }
        log('✅', `Ping sent — delivery ID: ${result.deliveryId || 'N/A'}`);
    } catch (e) { log('❌', `Ping failed: ${e.message}`); }
}

// --- Submit Audio ----------------------------------------------------------------

async function submitAudioUrl(audioUrl, args = {}) {
    logSection('Submitting Audio URL to Enterprise API');
    log('📤', `POST ${API_BASE_URL}/v1/classify`);
    log('🔗', `URL: ${audioUrl}`);
    if (args.filterMinDuration) log('🔍', `Duration filter: >= ${args.filterMinDuration}s`);

    const payload = {
        url: audioUrl,
        ...(args.filterMinDuration && { filterMinDurationSeconds: args.filterMinDuration }),
    };

    const response = await fetch(`${API_BASE_URL}/v1/classify`, {
        method: 'POST',
        headers: buildAuthHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
    });

    const result = await response.json();
    if (!response.ok && response.status !== 202) {
        log('❌', `API returned ${response.status}: ${result.error || result.message}`);
        return null;
    }
    log('✅', `API accepted (${response.status})`);
    log('🏷️', `Request ID: ${result.requestId}`);
    if (result.status) log('📊', `Status: ${result.status}`);
    return result;
}

async function submitAudio(audioFile, args = {}) {
    logSection('Uploading Audio to Enterprise API');
    const audioBuffer = readFileSync(audioFile);
    const fileName    = basename(audioFile);
    const sizeMB      = (audioBuffer.length / 1024 / 1024).toFixed(2);
    log('📤', `POST ${API_BASE_URL}/v1/classify (multipart)`);
    log('📥', `File: ${fileName} (${sizeMB} MB)`);
    if (args.filterMinDuration) log('🔍', `Duration filter: >= ${args.filterMinDuration}s`);

    const formData = new FormData();
    formData.append('audio', new Blob([audioBuffer]), fileName);
    // multipart endpoint requires callbackUrl — use noop if not provided
    formData.append('callbackUrl', 'https://mcp.h-ear.world/noop');
    if (args.filterMinDuration) formData.append('filterMinDurationSeconds', String(args.filterMinDuration));

    const headers = {};
    if (BEARER_TOKEN) headers['Authorization'] = `Bearer ${BEARER_TOKEN}`;
    else if (API_KEY) headers['X-NCM-Api-Key'] = API_KEY;

    const response = await fetch(`${API_BASE_URL}/v1/classify`, {
        method: 'POST',
        headers,
        body: formData,
        signal: AbortSignal.timeout(60000),
    });

    const result = await response.json();
    if (!response.ok && response.status !== 202) {
        log('❌', `API returned ${response.status}: ${result.error || result.message}`);
        return null;
    }
    log('✅', `API accepted (${response.status})`);
    log('🏷️', `Request ID: ${result.requestId}`);
    if (result.status) log('📊', `Status: ${result.status}`);
    return result;
}

// --- Alert Display ---------------------------------------------------------------

function renderAlertBox(emoji, title, payload) {
    const classifications = payload.classifications || [];
    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log(`  ║  ${(emoji + '  ' + title + '  ' + emoji).padEnd(45)}║`);
    console.log('  ╠══════════════════════════════════════════════╣');
    if (classifications.length === 0) {
        console.log('  ║  (no classifications in payload)             ║');
    } else {
        for (const c of classifications.slice(0, 5)) {
            const conf = c.confidence != null ? `${(c.confidence * 100).toFixed(0)}%` : '?';
            const cat  = c.category ? ` [${c.category}]` : '';
            const line = `  ${c.class} (${conf})${cat}`;
            console.log(`  ║${line.padEnd(47)}║`);
        }
        if (classifications.length > 5) {
            console.log(`  ║  ... and ${classifications.length - 5} more`.padEnd(48) + '║');
        }
    }
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');
}

// --- Main ------------------------------------------------------------------------

async function main() {
    const args = parseArgs();

    console.log('\n  Notification Alert Demo');
    console.log('  ══════════════════════════');

    const useFile = !!args.file;
    log(useFile ? '🧾' : '🔗', `Audio: ${useFile ? args.file : args.url}`);
    log('🎯', `Webhook 1: ${args.tierValues1} (tier depth ${args.tierDepth1})`);
    log('🎯', `Webhook 2: ${args.tierValues2} (tier depth ${args.tierDepth2})`);
    log('🌐', `Target env: ${args.env}`);

    if (args.help) {
        console.log(`
  Usage:
    node packages/demo/demos/webhook.mjs --oauth --callback-host <ngrok-host>              Prod, dual webhooks
    node packages/demo/demos/webhook.mjs --oauth --callback-host <host> --file demos/demo-60s.mp3  Local file
    node packages/demo/demos/webhook.mjs --oauth --env local                               Local Docker stack
    node packages/demo/demos/webhook.mjs --oauth --list-webhooks                           List registered webhooks
    node packages/demo/demos/webhook.mjs --oauth --deliveries <id>                         Delivery log
    node packages/demo/demos/webhook.mjs --oauth --deregister <id>                         Delete a webhook

  Options:
    --env <env>               Target environment: local, dev, staging, prod (default: prod)
    --oauth                   OAuth token (required — persistent webhooks need auth)
    --key <api-key>           API key (for audio submit only — no webhook registration)
    --callback-host <host>    Public hostname for webhook delivery (required for cloud, e.g. ngrok host)
    --url <url>               Audio URL (default: ${DEFAULT_AUDIO_URL})
    --file <path>             Local audio file — overrides --url (multipart upload)
    --port <n>                Webhook listener port (default: 9876)
    --timeout <s>             Max wait for webhooks (default: 300s)
    --filterMinDuration <s>   Min event duration filter in seconds
    --tier-values1 <name>     Webhook 1 notificationTierValues (default: "Respiratory sounds")
    --tier-depth1 <n>         Webhook 1 notificationTierDepth (default: 2)
    --tier-values2 <name>     Webhook 2 notificationTierValues (default: "Sounds of things")
    --tier-depth2 <n>         Webhook 2 notificationTierDepth (default: 1)
    --list-webhooks           List registered webhooks
    --deregister <id>         Delete a webhook
    --deliveries <id>         Show delivery log
    --ping <id>               Send test.ping
    --health                  API health check

  How it works:
    Registers two persistent webhooks with notificationTierDepth/Values before submitting audio.
    The server fires each webhook only when matching tier events exist in the job result.
    No client-side filtering — the server decides what gets alerted.

  Environment variables:
    HEAR_API_KEY, API_URL_LOCAL/DEV/STAGING/PROD, TLS_CERT_PATH, TLS_KEY_PATH
`);
        process.exit(0);
    }

    if (!args.oauth && !args.key && !process.env.HEAR_API_KEY) {
        log('❌', 'Authentication required. Use --oauth');
        process.exit(1);
    }

    const { apiUrl } = resolveEnvironment(args.env);
    API_BASE_URL = apiUrl;

    if (args.oauth) {
        log('🔐', `Acquiring OAuth token for ${args.env}...`);
        try {
            BEARER_TOKEN = await acquireOAuthToken(args.env);
            log('✅', 'OAuth token acquired');
        } catch (e) {
            log('❌', `OAuth failed: ${e.message}`);
            process.exit(1);
        }
    } else {
        API_KEY = args.key || process.env.HEAR_API_KEY || '';
        if (API_KEY) log('🔐', `Auth: API key (${API_KEY.substring(0, 8)}...)`);
    }

    // --- Management commands (run and exit) --------------------------------------

    if (args.health) { await checkHealth(); }

    if (args.listWebhooks) {
        await listWebhooks();
        process.exit(0);
    }
    if (args.deregister) {
        await deregisterWebhook(args.deregister);
        process.exit(0);
    }
    if (args.ping) {
        await pingWebhook(args.ping);
        process.exit(0);
    }
    if (args.deliveries) {
        await listDeliveries(args.deliveries);
        process.exit(0);
    }

    if (!BEARER_TOKEN) {
        log('❌', 'Persistent webhooks require --oauth');
        process.exit(1);
    }

    // --- Resolve callback URL ----------------------------------------------------

    let callbackHost = args.callbackHost;
    if (!callbackHost) {
        if (args.env === 'local') {
            callbackHost = 'host.docker.internal';
        } else {
            log('❌', `--callback-host required for --env ${args.env}`);
            log('🔍', 'Expose port 9876 with ngrok: ngrok http 9876');
            log('🔍', 'Then: --callback-host <ngrok-hostname>');
            process.exit(1);
        }
    }

    const useExternalHost = !!args.callbackHost;
    const baseUrl = useExternalHost
        ? `https://${callbackHost}`
        : `https://${callbackHost}:${args.port}`;

    // --- Register two webhooks ---------------------------------------------------

    logSection('Registering Webhooks');

    const events = args.events.split(',').map(e => e.trim());

    const reg1 = await registerWebhook(
        `${baseUrl}/respiratory`, events,
        args.tierDepth1, args.tierValues1,
        `demo — ${args.tierValues1} alert`
    );
    if (!reg1) { process.exit(1); }
    registeredWebhooks.push({ webhookId: reg1.webhook?.id || reg1.webhookId, path: '/respiratory', label: args.tierValues1 });

    const reg2 = await registerWebhook(
        `${baseUrl}/sounds-of-things`, events,
        args.tierDepth2, args.tierValues2,
        `demo — ${args.tierValues2} alert`
    );
    if (!reg2) { await cleanupWebhooks(); process.exit(1); }
    registeredWebhooks.push({ webhookId: reg2.webhook?.id || reg2.webhookId, path: '/sounds-of-things', label: args.tierValues2 });

    // Cleanup on exit
    const cleanup = async () => {
        logSection('Cleanup');
        await cleanupWebhooks();
        webhookServer?.close();
        process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // --- Start listener ----------------------------------------------------------

    await startWebhookListener(args.port, useExternalHost);

    // --- Submit audio ------------------------------------------------------------

    if (useFile && !existsSync(args.file)) {
        log('❌', `Audio file not found: ${args.file}`);
        await cleanup();
    }

    const submitResult = useFile
        ? await submitAudio(args.file, args)
        : await submitAudioUrl(args.url, args);

    if (!submitResult) { await cleanup(); }

    // --- Wait for webhooks -------------------------------------------------------

    logSection('Awaiting Webhook Deliveries');
    log('⏱️', `Timeout: ${args.timeout}s`);
    log('📡', 'Server fires each webhook only when matching tier events exist in the job');

    const startMs   = Date.now();
    const timeoutMs = args.timeout * 1000;
    const allPaths  = registeredWebhooks.map(w => w.path);

    let jobCompletedAt = null;
    const GRACE_MS = 10000; // wait 10s after first job.completed for remaining webhooks

    while (Date.now() - startMs < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
        if (elapsed % 10 === 0 && elapsed > 0) {
            process.stdout.write(`\r  ⏱️ Waiting... ${elapsed}s`);
        }
        // All webhooks received — done immediately
        if (allPaths.every(p => receivedAlerts[p])) break;
        // First job.completed received — start grace period for remaining webhooks
        const anyCompleted = allPaths.some(p => receivedAlerts[p]?.event === 'job.completed');
        if (anyCompleted && !jobCompletedAt) jobCompletedAt = Date.now();
        if (jobCompletedAt && (Date.now() - jobCompletedAt) >= GRACE_MS) break;
    }
    process.stdout.write('\r');

    // --- Display alerts ----------------------------------------------------------

    logSection('Alert Results');

    for (const wh of registeredWebhooks) {
        const payload = receivedAlerts[wh.path];
        if (payload && payload.event === 'job.completed') {
            const emoji = wh.path === '/respiratory' ? '🔬' : '📡';
            log('🚨', `${wh.label} — server fired this webhook`);
            renderAlertBox(emoji, wh.label.toUpperCase(), payload);
            log('📡', `In production: trigger SMS/email/PagerDuty/Home Assistant`);
        } else {
            log('✅', `${wh.label} — server did not fire (no matching events in this audio)`);
        }
    }

    // --- Summary -----------------------------------------------------------------

    logSection('Done');
    const totalMs = Date.now() - startMs;
    log('⏱️', `Total time: ${(totalMs / 1000).toFixed(1)}s`);
    if (submitResult.requestId) log('🏷️', `Job: ${submitResult.requestId}`);

    await cleanupWebhooks();
    log('✅', 'Live long and alert.');
    webhookServer?.close();
}

main().catch(async err => {
    console.error('\n  Fatal:', err.message);
    await cleanupWebhooks();
    webhookServer?.close();
    process.exit(1);
});
