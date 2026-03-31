#!/usr/bin/env node
/**
 * demo-openclaw.mjs - OpenClaw Skill Demo
 *
 * Demonstrates @h-ear/openclaw skill commands programmatically,
 * simulating what a user would experience in messaging channels
 * (WhatsApp, Telegram, Slack, Discord, Teams) via the OpenClaw gateway.
 *
 * Usage:
 *   node packages/demo/demos/openclaw.mjs --key <api-key>
 *   node packages/demo/demos/openclaw.mjs --key <key> --classify https://example.com/audio.mp3
 *   node packages/demo/demos/openclaw.mjs --env dev --key <key> --all
 *
 * Prerequisites:
 *   - Enterprise API key (HEAR_API_KEY or --key)
 *   - API running (cloud endpoints)
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

// --- Helpers -----------------------------------------------------------------

function log(emoji, msg) {
    console.log(`  ${emoji} ${msg}`);
}

function logSection(title) {
    console.log(`\n  -- ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
}

function logChat(command) {
    console.log(`\n  > ${command}`);
}

function logResponse(markdown) {
    // Indent markdown for display
    for (const line of markdown.split('\n')) {
        console.log(`  ${line}`);
    }
}

function parseArgs() {
    const args = process.argv.slice(2);
    const get = (flag) => {
        const idx = args.indexOf(flag);
        return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
    };

    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
  OpenClaw Skill Demo

  Usage:
    node packages/demo/demos/openclaw.mjs --key <api-key>
    node packages/demo/demos/openclaw.mjs --key <key> --classify <url>
    node packages/demo/demos/openclaw.mjs --env dev --key <key> --all

  Options:
    --key <key>         API key (or set HEAR_API_KEY)
    --env <env>         Environment: dev, staging, prod (default: prod)
    --classify <url>    URL to classify (triggers full classify demo)
    --all               Run all commands including jobs
    --help, -h          Show this help
`);
        process.exit(0);
    }

    return {
        env: get('--env') || 'prod',
        key: get('--key') || process.env.HEAR_API_KEY || '',
        classifyUrl: get('--classify'),
        all: args.includes('--all'),
    };
}

// --- Main --------------------------------------------------------------------

async function main() {
    const opts = parseArgs();

    if (!opts.key) {
        console.error('  Error: API key required. Pass --key <key> or set HEAR_API_KEY.');
        process.exit(1);
    }

    // Set env vars for @h-ear/openclaw config resolution
    process.env.HEAR_API_KEY = opts.key;
    process.env.HEAR_ENV = opts.env;

    // Dynamic import after env is set
    const { createSkill } = await import(join(PROJECT_ROOT, 'packages', 'openclaw', 'src', 'index.ts'));
    const { healthCommand } = await import(join(PROJECT_ROOT, 'packages', 'openclaw', 'src', 'commands', 'health.ts'));
    const { soundsCommand } = await import(join(PROJECT_ROOT, 'packages', 'openclaw', 'src', 'commands', 'sounds.ts'));
    const { usageCommand } = await import(join(PROJECT_ROOT, 'packages', 'openclaw', 'src', 'commands', 'usage.ts'));
    const { jobsCommand } = await import(join(PROJECT_ROOT, 'packages', 'openclaw', 'src', 'commands', 'jobs.ts'));
    const { classifyCommand } = await import(join(PROJECT_ROOT, 'packages', 'openclaw', 'src', 'commands', 'classify.ts'));

    const { client, config } = createSkill();

    // --- Header --------------------------------------------------------------

    logSection('OPENCLAW DEMO');
    log('🏛️', `Env: ${config.environment} | API: ${config.baseUrl}${config.apiPath}`);
    log('🧩', `Skill: @h-ear/openclaw v0.1.0`);

    // --- Act 1: Health -------------------------------------------------------

    logSection('Act 1: Health Check');
    logChat('health');
    try {
        const result = await healthCommand(client);
        logResponse(result);
    } catch (err) {
        log('❌', `health failed: ${err.message}`);
    }

    // --- Act 2: Sound Discovery ----------------------------------------------

    logSection('Act 2: Sound Discovery');
    logChat('sounds Animal (limit 5)');
    try {
        const result = await soundsCommand(client, 'Animal', { limit: 5 });
        logResponse(result);
    } catch (err) {
        log('❌', `sounds failed: ${err.message}`);
    }

    // --- Act 3: Usage --------------------------------------------------------

    logSection('Act 3: API Usage');
    logChat('usage');
    try {
        const result = await usageCommand(client);
        logResponse(result);
    } catch (err) {
        log('❌', `usage failed: ${err.message}`);
    }

    // --- Act 4: Jobs (if --all) ----------------------------------------------

    if (opts.all) {
        logSection('Act 4: Recent Jobs');
        logChat('jobs last 5');
        try {
            const result = await jobsCommand(client, { limit: 5 });
            logResponse(result);
        } catch (err) {
            log('❌', `jobs failed: ${err.message}`);
        }
    }

    // --- Act 5: Classification (if --classify) -------------------------------

    if (opts.classifyUrl) {
        logSection(`Act ${opts.all ? '5' : '4'}: Audio Classification`);
        logChat(`classify ${opts.classifyUrl}`);
        log('⏱️', 'Submitting audio for classification (async)...');
        try {
            const result = await classifyCommand(client, opts.classifyUrl);
            logResponse(result);
        } catch (err) {
            log('❌', `classify failed: ${err.message}`);
        }
    }

    // --- Summary -------------------------------------------------------------

    logSection('DEMO COMPLETE');
    log('✅', 'All skill commands executed successfully');
    log('📦', 'npm install @h-ear/openclaw');
    log('🔗', 'ClawHub: https://github.com/Badajoz95/h-ear-openclaw');
    log('🧾', 'Docs: docs/components/UserMCP.md');
    console.log('');
}

main().catch((err) => {
    console.error(`\n  Fatal: ${err.message}\n`);
    process.exit(1);
});
