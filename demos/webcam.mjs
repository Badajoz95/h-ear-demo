#!/usr/bin/env node
/**
 * demo-webcam.mjs - TP-Link Tapo C100 Edge Audio Acquisition Demo
 *
 * Captures audio from a Wi-Fi camera's RTSP stream and uploads
 * via the Enterprise API (v1/classify). Supports multiple environments.
 * Auth: --oauth (auto M2M token via Key Vault + Auth0) or --key <api-key>
 *
 * Usage:
 *   node packages/demo/demos/webcam.mjs --probe                          # Probe camera (local API)
 *   node packages/demo/demos/webcam.mjs --env dev --probe                # Probe camera (dev API)
 *   node packages/demo/demos/webcam.mjs --capture --duration 10          # Capture 10s audio
 *   node packages/demo/demos/webcam.mjs --full --oauth                   # capture + upload (OAuth, fire-and-forget)
 *   node packages/demo/demos/webcam.mjs --full --key <api-key>           # capture + upload (API key)
 *   node packages/demo/demos/webcam.mjs --full --oauth --poll            # capture + upload + poll for results
 *   node packages/demo/demos/webcam.mjs --full --oauth --gather          # capture all, then upload all
 *   node packages/demo/demos/webcam.mjs --env prod --full --oauth        # Full pipeline against prod
 *
 * Camera: TP-Link Tapo C100 (Home Security Wi-Fi Camera)
 *   Model: Tapo C100 | Power: 5V 0.6A | Audio: Built-in mic + speaker
 *   RTSP: rtsp://<user>:<pass>@<ip>/stream1
 *
 * Prerequisites:
 *   - ffmpeg + ffprobe in PATH (or winget-installed)
 *   - Camera RTSP enabled via Tapo app (Advanced Settings -> Camera Account)
 *   - For upload: target API running
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { acquireOAuthToken, resolveApiUrl } from './demo-auth.mjs';

// --- Camera Configuration --------------------------------------------------------
// Set these via environment variables or edit directly for your camera
const CAMERA = {
    host: process.env.CAMERA_HOST || '192.168.0.100',
    user: process.env.CAMERA_USER || 'admin',
    pass: process.env.CAMERA_PASS || 'changeme',
    get rtspHigh() { return `rtsp://${this.user}:${this.pass}@${this.host}/stream1`; },
    get rtspLow()  { return `rtsp://${this.user}:${this.pass}@${this.host}/stream2`; },
    name: 'Tapo C100',
};

// --- API Environment Configuration -----------------------------------------------
const API_URLS = {
    local:   process.env.API_URL_LOCAL   || 'http://localhost:7071/api',
    dev:     process.env.API_URL_DEV     || '',
    staging: process.env.API_URL_STAGING || '',
    prod:    process.env.API_URL_PROD    || '',
};

// --- Output paths ----------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', '..', '..', 'output', 'demo-webcam');

// --- Resolved state (set in main) ------------------------------------------------
let FFMPEG = 'ffmpeg';
let FFPROBE = 'ffprobe';
let API_BASE_URL = '';
let API_KEY = '';
let BEARER_TOKEN = '';

// --- Auth Helpers ----------------------------------------------------------------

/** Build auth headers — bearer token takes precedence over API key */
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

/** Resolve ffmpeg/ffprobe — winget installs to a Links dir not always in Git Bash PATH */
function resolveFFmpeg() {
    const wingetLinks = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links');
    const searchPaths = [
        '',  // bare (already in PATH)
        wingetLinks,
        'C:\\ffmpeg\\bin',
        join(process.env.ProgramFiles || '', 'ffmpeg', 'bin'),
    ];
    let ffmpeg = null, ffprobe = null;
    for (const dir of searchPaths) {
        const ff = dir ? join(dir, 'ffmpeg.exe') : 'ffmpeg';
        try {
            execSync(`"${ff}" -version`, { stdio: 'pipe' });
            ffmpeg = ffmpeg || ff;
        } catch { /* skip */ }
        const fp = dir ? join(dir, 'ffprobe.exe') : 'ffprobe';
        try {
            execSync(`"${fp}" -version`, { stdio: 'pipe' });
            ffprobe = ffprobe || fp;
        } catch { /* skip */ }
        if (ffmpeg && ffprobe) break;
    }
    return { ffmpeg, ffprobe };
}

const VALID_ENVS = ['local', 'dev', 'staging', 'prod'];

function parseArgs() {
    const args = process.argv.slice(2);
    const envIdx = args.indexOf('--env');
    const env = envIdx >= 0 && args[envIdx + 1] ? args[envIdx + 1] : 'local';
    if (!VALID_ENVS.includes(env)) {
        console.error(`  Invalid env: ${env}. Valid: ${VALID_ENVS.join(', ')}`);
        process.exit(1);
    }
    const get = (flag) => {
        const idx = args.indexOf(flag);
        return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
    };
    return {
        env,
        probe:    args.includes('--probe'),
        capture:  args.includes('--capture') || args.includes('--full'),
        upload:   args.includes('--upload') || args.includes('--full'),
        full:     args.includes('--full'),
        key:          get('--key'),
        oauth:        args.includes('--oauth'),
        duration: (() => {
            const idx = args.indexOf('--duration');
            return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 30;
        })(),
        jobs: (() => {
            const idx = args.indexOf('--jobs');
            return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 3;
        })(),
        interval: (() => {
            const idx = args.indexOf('--interval');
            return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 20;
        })(),
        await_:   args.includes('--await'),
        poll:     args.includes('--poll') || args.includes('--await'),
        gather:   args.includes('--gather'),
        health:   args.includes('--health'),
        usage:    args.includes('--usage'),
        classes:  args.includes('--classes'),
        job:      get('--job'),
        events:   get('--events'),
        cameraIp:   get('--camera-ip'),
        cameraUser: get('--camera-user'),
        cameraPass: get('--camera-pass'),
        help:     args.includes('--help') || args.includes('-h') || args.length === 0,
    };
}

// --- Environment Bootstrap -------------------------------------------------------

/**
 * Resolve API URL for the target environment.
 * Returns { apiUrl }.
 */
function resolveEnvironment(env) {
    logSection(`Environment (${env})`);

    // Env var override > derived from demo-auth config
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

// --- Probe: Test RTSP Connectivity -----------------------------------------------

function probeCamera() {
    logSection(`Probing ${CAMERA.name} @ ${CAMERA.host}`);

    // 1. Network ping — validate reply is FROM the camera, not a router "unreachable" bounce
    log('📡', `Pinging ${CAMERA.host}...`);
    const ping = spawnSync('ping', ['-n', '1', '-w', '3000', CAMERA.host], { stdio: 'pipe', encoding: 'utf-8' });
    const pingOut = ping.stdout || '';
    const replyFromCamera = pingOut.includes(`Reply from ${CAMERA.host}:`);
    if (ping.status !== 0 || !replyFromCamera) {
        log('❌', `Camera unreachable at ${CAMERA.host}`);
        if (pingOut.includes('Destination host unreachable')) {
            log('🔍', 'Router says host unreachable — camera is likely powered off');
        } else {
            log('🔍', 'Check: camera powered on, same Wi-Fi network, correct IP');
        }
        return false;
    }
    log('✅', `Camera responding at ${CAMERA.host}`);

    // 2. RTSP stream probe via ffprobe
    log('📡', 'Probing RTSP stream...');
    const probe = spawnSync(FFPROBE, [
        '-rtsp_transport', 'tcp',
        '-v', 'error',
        '-show_streams',
        '-show_format',
        '-print_format', 'json',
        '-timeout', '5000000',   // 5s timeout (in microseconds)
        CAMERA.rtspHigh,
    ], { stdio: 'pipe', encoding: 'utf-8', timeout: 15000 });

    if (probe.status !== 0) {
        log('❌', `RTSP probe failed: ${(probe.stderr || '').trim().split('\n')[0]}`);
        log('🔍', 'Check: Tapo app -> Advanced Settings -> Camera Account enabled');
        log('🔍', `Verify credentials: ${CAMERA.user}:****`);
        return false;
    }

    try {
        const info = JSON.parse(probe.stdout);
        const streams = info.streams || [];
        const video = streams.find(s => s.codec_type === 'video');
        const audio = streams.find(s => s.codec_type === 'audio');

        log('✅', `RTSP connected — ${streams.length} stream(s)`);
        if (video) {
            log('📡', `Video: ${video.codec_name} ${video.width}x${video.height} @ ${video.r_frame_rate}`);
        }
        if (audio) {
            log('🎤', `Audio: ${audio.codec_name} ${audio.sample_rate}Hz ${audio.channels}ch`);
        } else {
            log('⚠️', 'No audio stream detected — check microphone settings in Tapo app');
        }

        return { video, audio, streams };
    } catch (e) {
        // ffprobe worked but output wasn't JSON — still connected
        log('✅', 'RTSP connected (raw output)');
        log('📊', (probe.stdout || '').substring(0, 200));
        return true;
    }
}

// --- Capture: Extract Audio from RTSP --------------------------------------------

function captureAudio(durationSec) {
    logSection(`Capturing ${durationSec}s audio from ${CAMERA.name}`);

    if (!existsSync(OUTPUT_DIR)) {
        mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const outFile = join(OUTPUT_DIR, `tapo-c100_${timestamp}_${durationSec}s.wav`);

    log('🎤', `Recording ${durationSec}s -> ${outFile}`);
    log('⏱️', 'Connecting to RTSP stream (TCP transport)...');

    // Extract audio only, convert to mono 16kHz PCM WAV (classifier native format)
    const ffmpeg = spawnSync(FFMPEG, [
        '-y',                           // Overwrite
        '-rtsp_transport', 'tcp',       // Reliable transport (UDP causes corruption)
        '-i', CAMERA.rtspHigh,          // RTSP input
        '-vn',                          // Discard video — audio only
        '-ac', '1',                     // Mono
        '-ar', '16000',                 // 16kHz (matches YAMNet/ESC-50 model input)
        '-acodec', 'pcm_s16le',         // 16-bit PCM (lossless)
        '-t', String(durationSec),      // Duration
        '-f', 'wav',                    // WAV container
        outFile,
    ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: (durationSec + 30) * 1000,  // Duration + 30s connection buffer
    });

    if (ffmpeg.status !== 0) {
        const err = (ffmpeg.stderr || '').trim().split('\n').slice(-3).join('\n');
        log('❌', `FFmpeg capture failed (exit ${ffmpeg.status})`);
        log('📊', err);
        return null;
    }

    if (!existsSync(outFile)) {
        log('❌', 'Output file not created');
        return null;
    }

    const stat = statSync(outFile);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
    const expectedSize = durationSec * 16000 * 2; // 16kHz x 16-bit = 32KB/s
    const ratio = stat.size / expectedSize;

    log('✅', `Captured: ${outFile}`);
    log('📊', `Size: ${sizeMB} MB (${ratio > 0.8 ? 'good' : '⚠️ low'} — expected ~${(expectedSize / 1024 / 1024).toFixed(2)} MB)`);

    return outFile;
}

/** Randomise GPS within radiusKm of a centre point (default 10km) */
function randomGpsWithin10km(centreLat, centreLng, radiusKm = 10) {
    const r = radiusKm * Math.sqrt(Math.random()); // uniform distribution within circle
    const theta = Math.random() * 2 * Math.PI;
    // 1 degree latitude ~ 111.32 km
    const dLat = (r * Math.cos(theta)) / 111.32;
    // 1 degree longitude ~ 111.32 * cos(lat) km
    const dLng = (r * Math.sin(theta)) / (111.32 * Math.cos(centreLat * Math.PI / 180));
    const latitude = +(centreLat + dLat).toFixed(6);
    const longitude = +(centreLng + dLng).toFixed(6);
    return { latitude, longitude };
}

// --- Display: Render AI Classification Results -----------------------------------

function displayResults(result) {
    if (!result || result.status === 'processing') return;

    logSection('Classification Results');
    log('🏷️', `Request ID: ${result.requestId}`);

    if (result.duration != null) {
        log('⏱️', `Duration: ${result.duration.toFixed(1)}s`);
    }
    if (result.processingTimeMs != null) {
        log('⚡', `Processing: ${(result.processingTimeMs / 1000).toFixed(1)}s`);
    }
    if (result.eventCount != null) {
        log('📊', `Events detected: ${result.eventCount}`);
    }
    if (result.reportUrl) {
        log('🧾', `Report: ${result.reportUrl}`);
    }

    // Display classifications (sync mode returns these)
    if (result.classifications?.length > 0) {
        log('🤖', `Top classifications:`);
        result.classifications.slice(0, 10).forEach((c, i) => {
            const conf = c.confidence != null ? `${(c.confidence * 100).toFixed(0)}%` : '?';
            const cat = c.category ? ` [${c.category}]` : '';
            log('  ', `  ${i + 1}. ${c.class} (${conf})${cat}`);
        });
    }

    // Display noise events (if present in response)
    if (result.noiseEvents?.length > 0) {
        log('📈', `Noise events:`);
        result.noiseEvents.slice(0, 10).forEach((evt) => {
            const t = evt.startTime != null ? `${evt.startTime.toFixed(1)}s` : '?';
            const conf = evt.confidence != null ? `${(evt.confidence * 100).toFixed(0)}%` : '?';
            log('  ', `  [${t}] ${evt.label || evt.class} (${conf})`);
        });
    }
}

// --- Health: Check API Status ----------------------------------------------------

async function checkHealth() {
    logSection('API Health Check');
    const endpoint = `${API_BASE_URL}/v1/health`;
    log('📡', `GET ${endpoint}`);

    try {
        const response = await fetch(endpoint, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(10000),
        });

        const result = await response.json();
        if (!response.ok) {
            log('❌', `Health check failed (${response.status}): ${result.error || response.statusText}`);
            return null;
        }

        log('✅', `Status: ${result.status}`);
        if (result.version) log('📊', `Version: ${result.version}`);
        if (result.deployedTimestamp) log('📊', `Deployed: ${result.deployedTimestamp}`);
        return result;
    } catch (e) {
        log('❌', `Health check failed: ${e.message}`);
        return null;
    }
}

// --- Usage: Show API Quota -------------------------------------------------------

async function showUsage() {
    logSection('API Usage / Quota');
    const endpoint = `${API_BASE_URL}/v1/usage`;
    log('📡', `GET ${endpoint}`);

    try {
        const response = await fetch(endpoint, {
            method: 'GET',
            headers: buildAuthHeaders(),
            signal: AbortSignal.timeout(10000),
        });

        const result = await response.json();
        if (!response.ok) {
            log('❌', `Usage check failed (${response.status}): ${result.error || response.statusText}`);
            return null;
        }

        log('📊', `Plan: ${result.tier || result.plan}`);
        log('📊', `Minutes: ${result.period?.minutesUsed?.toFixed(1) ?? result.minutesUsed ?? '?'} / ${result.period?.minutesLimit ?? result.minutesTotal ?? '?'}`);
        log('📊', `Calls today: ${result.daily?.used ?? result.callsToday ?? '?'} / ${result.daily?.limit ?? result.callsLimit ?? '?'}`);
        log('📊', `Period: ${result.period?.start ?? result.periodStart ?? '?'} → ${result.period?.end ?? result.periodEnd ?? '?'}`);
        return result;
    } catch (e) {
        log('❌', `Usage check failed: ${e.message}`);
        return null;
    }
}

// --- Classes: List Sound Classes -------------------------------------------------

async function listClasses() {
    logSection('Sound Classes');
    const endpoint = `${API_BASE_URL}/v1/classes`;
    log('📡', `GET ${endpoint}`);

    try {
        const response = await fetch(endpoint, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(15000),
        });

        const result = await response.json();
        if (!response.ok) {
            log('❌', `Classes failed (${response.status}): ${result.error || response.statusText}`);
            return null;
        }

        log('📊', `Taxonomy: ${result.taxonomy}`);
        log('📊', `Total classes: ${result.total} (filtered: ${result.totalFiltered})`);
        if (result.availableTaxonomies?.length > 0) {
            log('📊', `Available taxonomies: ${result.availableTaxonomies.join(', ')}`);
        }
        if (result.categories?.length > 0) {
            log('📊', `Categories (${result.categories.length}):`);
            result.categories.forEach(cat => log('  ', `  ${cat}`));
        }
        if (result.classes?.length > 0) {
            const preview = result.classes.slice(0, 10);
            log('🤖', `First ${preview.length} classes:`);
            preview.forEach((c, i) => {
                log('  ', `  ${i + 1}. ${c.name} [${c.category}]`);
            });
            if (result.classes.length > 10) {
                log('  ', `  ... and ${result.classes.length - 10} more`);
            }
        }
        return result;
    } catch (e) {
        log('❌', `Classes failed: ${e.message}`);
        return null;
    }
}

// --- Job: Retrieve Existing Job --------------------------------------------------

async function getJob(jobId) {
    logSection(`Job: ${jobId}`);
    const endpoint = `${API_BASE_URL}/v1/jobs/${jobId}`;
    log('📡', `GET ${endpoint}`);

    try {
        const response = await fetch(endpoint, {
            method: 'GET',
            headers: buildAuthHeaders(),
            signal: AbortSignal.timeout(10000),
        });

        const result = await response.json();
        if (!response.ok) {
            log('❌', `Job fetch failed (${response.status}): ${result.error || response.statusText}`);
            return null;
        }

        log('🏷️', `Job ID: ${result.jobId}`);
        log('📊', `Status: ${result.status}`);
        if (result.fileName) log('📊', `File: ${result.fileName}`);
        if (result.duration != null) log('⏱️', `Duration: ${result.duration.toFixed(1)}s`);
        if (result.eventCount != null) log('📊', `Events: ${result.eventCount}`);
        log('📊', `Created: ${result.createdAt}`);
        if (result.completedAt) log('📊', `Completed: ${result.completedAt}`);
        if (result.reportUrl) log('🧾', `Report: ${result.reportUrl}`);

        if (result.classifications?.length > 0) {
            displayResults(result);
        }
        return result;
    } catch (e) {
        log('❌', `Job fetch failed: ${e.message}`);
        return null;
    }
}

// --- Events: Retrieve Classification Events for a Job ----------------------------

async function getJobEvents(jobId) {
    logSection(`Events: ${jobId}`);
    const endpoint = `${API_BASE_URL}/v1/jobs/${jobId}/events`;
    log('📡', `GET ${endpoint}`);

    try {
        const response = await fetch(endpoint, {
            method: 'GET',
            headers: buildAuthHeaders(),
            signal: AbortSignal.timeout(15000),
        });

        const result = await response.json();
        if (!response.ok) {
            log('❌', `Events fetch failed (${response.status}): ${result.error || response.statusText}`);
            return null;
        }

        const events = result.events || result.classifications || [];
        log('📊', `Events: ${events.length}`);
        events.slice(0, 20).forEach((evt, i) => {
            const t = evt.startTime != null ? `${evt.startTime.toFixed(1)}s` : '?';
            const conf = evt.confidence != null ? `${(evt.confidence * 100).toFixed(0)}%` : '?';
            const cls = evt.class || evt.className || evt.label || '?';
            const cat = evt.category ? ` [${evt.category}]` : '';
            log('  ', `  ${i + 1}. [${t}] ${cls} (${conf})${cat}`);
        });
        if (events.length > 20) {
            log('  ', `  ... and ${events.length - 20} more`);
        }
        return result;
    } catch (e) {
        log('❌', `Events fetch failed: ${e.message}`);
        return null;
    }
}

// --- Poll: Wait for Job Completion -----------------------------------------------

async function pollJobResult(jobId) {
    logSection(`Polling Job: ${jobId}`);
    const endpoint = `${API_BASE_URL}/v1/jobs/${jobId}`;
    const startMs = Date.now();
    const timeoutMs = 5 * 60 * 1000; // 5 minutes
    let attempts = 0;

    while (Date.now() - startMs < timeoutMs) {
        const interval = attempts >= 20 ? 10000 : attempts >= 10 ? 5000 : 3000;
        await new Promise(resolve => setTimeout(resolve, interval));
        attempts++;

        const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(0);
        process.stdout.write(`\r  ⏱️ Polling... ${elapsedSec}s (attempt ${attempts})`);

        try {
            const response = await fetch(endpoint, {
                method: 'GET',
                headers: buildAuthHeaders(),
                signal: AbortSignal.timeout(10000),
            });

            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After');
                const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
                await new Promise(resolve => setTimeout(resolve, delayMs));
                continue;
            }

            if (response.status === 404) continue; // eventual consistency

            const result = await response.json();

            if (result.status === 'completed' || (result.classifications && result.classifications.length > 0)) {
                process.stdout.write('\r');
                log('✅', `Job completed in ${elapsedSec}s`);
                displayResults(result);
                return result;
            }

            if (result.status === 'failed') {
                process.stdout.write('\r');
                log('❌', `Job failed: ${result.error || 'unknown'}`);
                return result;
            }
        } catch (e) {
            if (e.status === 404) continue;
            // transient errors — keep polling
        }
    }

    process.stdout.write('\r');
    log('❌', `Poll timeout — job ${jobId} did not complete within 5 minutes`);
    return null;
}

// --- Upload: Send Audio to Enterprise API (multipart/form-data) ------------------

async function uploadAudio(audioFile) {
    logSection('Uploading to Enterprise API');

    const endpoint = `${API_BASE_URL}/v1/classify`;
    log('📤', `POST ${endpoint} (multipart)`);

    const audioBuffer = readFileSync(audioFile);
    const fileName = audioFile.split(/[\\/]/).pop();
    const sizeMB = (audioBuffer.length / 1024 / 1024).toFixed(2);

    log('📊', `Payload: ${fileName} (${sizeMB} MB)`);

    const { latitude, longitude } = randomGpsWithin10km(-35.2802, 149.1310);

    const formData = new FormData();
    formData.append('audio', new Blob([audioBuffer]), fileName);
    formData.append('latitude', String(latitude));
    formData.append('longitude', String(longitude));

    // Build auth headers without Content-Type (fetch sets boundary automatically for FormData)
    const headers = {};
    if (BEARER_TOKEN) {
        headers['Authorization'] = `Bearer ${BEARER_TOKEN}`;
    } else if (API_KEY) {
        headers['X-NCM-Api-Key'] = API_KEY;
    }

    try {
        const response = await fetch(endpoint, {
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
        log('🏷️', `Request ID: ${result.requestId || 'N/A'}`);
        log('📊', `Status: ${result.status || 'N/A'}`);
        log('🔗', `Poll URL: ${result.pollUrl || 'N/A'}`);

        return result;
    } catch (e) {
        log('❌', `Upload failed: ${e.message}`);
        return null;
    }
}


// --- Main ------------------------------------------------------------------------

async function main() {
    const args = parseArgs();

    // CLI overrides for camera config
    if (args.cameraIp)   CAMERA.host = args.cameraIp;
    if (args.cameraUser) CAMERA.user = args.cameraUser;
    if (args.cameraPass) CAMERA.pass = args.cameraPass;

    console.log('\n  TP-Link Tapo C100 Edge Audio Acquisition Demo');
    console.log('  ══════════════════════════════════════════════');
    log('📡', `Camera: ${CAMERA.name} @ ${CAMERA.host}`);
    log('🌐', `Target env: ${args.env}`);

    if (args.help) {
        console.log(`
  Usage:
    node packages/demo/demos/webcam.mjs --probe                                    Probe camera
    node packages/demo/demos/webcam.mjs --capture --duration 10                    Capture 10s audio
    node packages/demo/demos/webcam.mjs --full --key <api-key>                     Capture + upload (fire-and-forget)
    node packages/demo/demos/webcam.mjs --full --key <key> --poll                  Capture + upload + poll for results
    node packages/demo/demos/webcam.mjs --full --key <key> --gather                Capture all, then upload all
    node packages/demo/demos/webcam.mjs --full --oauth                             OAuth (auto M2M token)
    node packages/demo/demos/webcam.mjs --env prod --full --oauth                  Full pipeline against prod
    node packages/demo/demos/webcam.mjs --health --env dev                         API health check
    node packages/demo/demos/webcam.mjs --classes                                  List sound classes
    node packages/demo/demos/webcam.mjs --usage --key <key>                        Show API usage/quota
    node packages/demo/demos/webcam.mjs --job <id> --key <key>                     Retrieve job results
    node packages/demo/demos/webcam.mjs --events <id> --key <key>                  Retrieve job events

  Options:
    --env <env>            Target environment: local, dev, staging, prod (default: local)
    --probe                Test camera RTSP connectivity
    --capture              Capture audio from camera
    --upload               Upload captured audio to Enterprise API
    --full                 capture + upload (end-to-end)
    --key <api-key>        Enterprise API key (X-NCM-Api-Key header)
    --oauth                OAuth (auto M2M token via Key Vault + Auth0)
    --duration <sec>       Capture duration per job in seconds (default: 30)
    --jobs <n>             Number of jobs to send (default: 3)
    --interval <sec>       Seconds between jobs (default: 20)
    --poll                 Poll /v1/jobs/{id} for results after async submit
    --await                Alias for --poll (backward compat)
    --gather               Capture all files first, then upload all (batch pattern)
    --health               Check API health (/v1/health) before pipeline
    --usage                Show API usage/quota (/v1/usage) after pipeline
    --classes              List available sound classes (/v1/classes) and exit
    --job <jobId>          Retrieve results for an existing job and exit
    --events <jobId>       Retrieve classification events for a job and exit
    --camera-ip <ip>       Camera IP address (default: 192.168.0.100 / CAMERA_HOST)
    --camera-user <user>   Camera RTSP username (default: admin / CAMERA_USER)
    --camera-pass <pass>   Camera RTSP password (default: changeme / CAMERA_PASS)

  Camera:  ${CAMERA.name} — rtsp://${CAMERA.user}:****@${CAMERA.host}/stream1
  Output:  output/demo-webcam/

  Environment variables:
    CAMERA_HOST            Camera IP address (default: 192.168.0.100)
    CAMERA_USER            Camera RTSP username (default: admin)
    CAMERA_PASS            Camera RTSP password (default: changeme)
    HEAR_API_KEY           Enterprise API key
    ENTERPRISE_API_KEY     Enterprise API key (legacy, prefer HEAR_API_KEY)
    API_URL_LOCAL          Local API URL (default: http://localhost:7071/api)
    API_URL_DEV            Dev API URL
    API_URL_STAGING        Staging API URL
    API_URL_PROD           Production API URL
`);
        process.exit(0);
    }

    // Resolve API environment
    const { apiUrl } = resolveEnvironment(args.env);
    API_BASE_URL = apiUrl;

    // Auth — OAuth (auto M2M) or API key
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
        API_KEY = args.key || process.env.HEAR_API_KEY || process.env.ENTERPRISE_API_KEY || '';
        if (API_KEY) {
            log('🔐', `Auth: API key (${API_KEY.substring(0, 8)}...)`);
        }
    }

    // --- Standalone modes (run and exit) ------------------------------------------

    // --classes: list sound classes and exit (no auth required)
    if (args.classes) {
        await listClasses();
        process.exit(0);
    }

    // --job: retrieve a specific job and exit
    if (args.job) {
        if (!API_KEY && !BEARER_TOKEN) {
            log('❌', 'Authentication required. Use --key or --oauth');
            process.exit(1);
        }
        await getJob(args.job);
        process.exit(0);
    }

    // --events: retrieve classification events for a job and exit
    if (args.events) {
        if (!API_KEY && !BEARER_TOKEN) {
            log('❌', 'Authentication required. Use --key or --oauth');
            process.exit(1);
        }
        await getJobEvents(args.events);
        process.exit(0);
    }

    // --- Pipeline modes ----------------------------------------------------------

    // --health: check API health before pipeline
    if (args.health) {
        await checkHealth();
    }

    // Prerequisites — resolve ffmpeg (winget PATH not always in Git Bash)
    if (args.probe || args.capture) {
        logSection('Prerequisites');
        const resolved = resolveFFmpeg();
        if (!resolved.ffmpeg || !resolved.ffprobe) {
            log('❌', `ffmpeg: ${resolved.ffmpeg || 'NOT FOUND'}`);
            log('❌', `ffprobe: ${resolved.ffprobe || 'NOT FOUND'}`);
            log('🔍', 'Install ffmpeg: winget install Gyan.FFmpeg');
            process.exit(1);
        }
        FFMPEG = resolved.ffmpeg;
        FFPROBE = resolved.ffprobe;
        log('✅', `ffmpeg: ${FFMPEG}`);
        log('✅', `ffprobe: ${FFPROBE}`);
    }

    // Probe camera
    if (args.probe || args.capture) {
        const probeResult = probeCamera();
        if (!probeResult) {
            process.exit(1);
        }
        if (args.probe && !args.capture) {
            log('✅', 'Probe complete — camera ready for acquisition');
            process.exit(0);
        }
    }

    // --usage standalone (no capture/upload) — show usage and exit
    if (args.usage && !args.capture && !args.upload) {
        if (!API_KEY && !BEARER_TOKEN) {
            log('❌', '--usage requires authentication. Use --oauth or --key');
            process.exit(1);
        }
        await showUsage();
        process.exit(0);
    }

    // --health only (no capture/upload) — exit after health check
    if (args.health && !args.capture && !args.upload) {
        process.exit(0);
    }

    if (args.upload && !API_KEY && !BEARER_TOKEN) {
        log('❌', 'Authentication required for upload. Use --key <api-key> or --oauth');
        process.exit(1);
    }

    // Capture + Upload loop (--jobs controls iterations, requires --full)
    if (!args.full && args.jobs > 1) {
        log('⚠️', '--jobs requires --full (capture + upload loop). Use --full --key <key> --jobs N');
        process.exit(1);
    }
    const totalJobs = args.full ? args.jobs : 1;
    const results = [];


    if (args.gather && args.capture && args.upload) {
        // --gather mode: capture all files first, then upload all
        logSection(`Gather mode: capturing ${totalJobs} file(s)`);
        const audioFiles = [];
        for (let i = 0; i < totalJobs; i++) {
            if (i > 0 && args.interval > 0) {
                logSection(`Waiting ${args.interval}s before capture ${i + 1}/${totalJobs}`);
                await new Promise(resolve => setTimeout(resolve, args.interval * 1000));
            }
            if (totalJobs > 1) log('🎤', `Capture ${i + 1}/${totalJobs}`);
            const audioFile = captureAudio(args.duration);
            if (audioFile) {
                audioFiles.push(audioFile);
            } else {
                log('❌', `Capture ${i + 1} failed — skipping`);
            }
        }

        logSection(`Uploading ${audioFiles.length} file(s)`);
        for (let i = 0; i < audioFiles.length; i++) {
            if (audioFiles.length > 1) log('📤', `Upload ${i + 1}/${audioFiles.length}`);
            const result = await uploadAudio(audioFiles[i]);
            if (result) {
                results.push(result);
            } else {
                log('❌', `Upload ${i + 1} failed — continuing`);
            }
        }
    } else {
        // Default: interleaved capture -> upload per job
        for (let i = 0; i < totalJobs; i++) {
            if (i > 0 && args.interval > 0) {
                logSection(`Waiting ${args.interval}s before job ${i + 1}/${totalJobs}`);
                await new Promise(resolve => setTimeout(resolve, args.interval * 1000));
            }

            if (totalJobs > 1) {
                logSection(`Job ${i + 1}/${totalJobs}`);
            }

            // Capture audio from camera
            let audioFile = null;
            if (args.capture) {
                audioFile = captureAudio(args.duration);
                if (!audioFile) {
                    log('❌', `Job ${i + 1} capture failed — skipping`);
                    continue;
                }
            }

            // Upload to Enterprise API
            if (args.upload && audioFile) {
                if (!API_KEY && !BEARER_TOKEN) {
                    log('❌', 'No authentication available. Use --key or --oauth');
                    process.exit(1);
                }
                const result = await uploadAudio(audioFile);
                if (result) {
                    results.push(result);
                } else {
                    log('❌', `Job ${i + 1} upload failed — continuing`);
                }
            }

            if (audioFile && !args.upload) {
                log('🔍', `To classify: node packages/demo/demos/webcam.mjs --env ${args.env} --capture --upload`);
            }
        }
    }

    // --poll: poll each submitted job to completion
    if (args.poll && results.length > 0) {
        logSection('Polling for Results');
        for (const r of results) {
            if (r.requestId) {
                await pollJobResult(r.requestId);
            }
        }
    }

    // --usage: show API usage after pipeline
    if (args.usage) {
        if (!API_KEY && !BEARER_TOKEN) {
            log('⚠️', '--usage requires authentication. Use --key or --oauth');
        } else {
            await showUsage();
        }
    }

    logSection('Done');
    if (results.length > 0) {
        const mode = args.poll ? 'classified' : 'accepted';
        log('📊', `${results.length}/${totalJobs} jobs ${mode}`);
        if (args.poll && results.some(r => r.classifications?.length > 0)) {
            const totalEvents = results.reduce((sum, r) => sum + (r.eventCount || 0), 0);
            log('🤖', `Total events detected: ${totalEvents}`);
        }
    }
    log('✅', 'Live long and classify.');
}

main().catch(err => {
    console.error('\n  Fatal:', err.message);
    process.exit(1);
});
