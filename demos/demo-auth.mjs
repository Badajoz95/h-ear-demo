/**
 * demo-auth.mjs — OAuth Authorization Code + PKCE for demos.
 *
 * Same flow as the H-ear SPA: browser login → localhost callback → token cached.
 * First run opens browser. Subsequent runs refresh silently (zero touch).
 *
 * Public SPA client with PKCE. No secrets. No Key Vault. No internal dependencies.
 *
 * Usage:
 *   import { acquireOAuthToken, resolveApiUrl } from './demo-auth.mjs';
 *   const token = await acquireOAuthToken('prod');
 *   const apiUrl = resolveApiUrl('prod');
 */

import http from 'http';
import crypto from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// --- Public configuration --------------------------------------------------------

const AUTH0_DOMAIN = 'auth.h-ear.world';
const CALLBACK_PORT = 8765;
const CALLBACK_PATH = '/callback';
const CALLBACK_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

const ENV_CONFIG = {
    local: {
        clientId: '3YBeV5PdOX4veQpJWYeOSNxMaSMAOyGU',
        audience: 'https://api.ncm.local',
        apiUrl:   'http://localhost:7071/api',
    },
    dev: {
        clientId: '3YBeV5PdOX4veQpJWYeOSNxMaSMAOyGU',
        audience: 'https://api.ncm.local',
        apiUrl:   'https://api-dev.h-ear.world/api',
    },
    staging: {
        clientId: 'iFW8yjp6ddXKyMH3UbkxoWZNXiMLJ3nS',
        audience: 'https://api.ncm.staging',
        apiUrl:   'https://api-staging.h-ear.world/api',
    },
    prod: {
        clientId: '1iNxYFcRc19G1e0B0TA9SJmcCTd0iJtG',
        audience: 'https://api.ncm.prod',
        apiUrl:   'https://api.h-ear.world/api',
    },
};

// --- Token cache on disk ---------------------------------------------------------

const TOKEN_DIR = join(process.env.HOME || process.env.USERPROFILE || '.', '.h-ear');

function tokenCachePath(env) {
    return join(TOKEN_DIR, `token-${env}.json`);
}

function readTokenCache(env) {
    const path = tokenCachePath(env);
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
        return null;
    }
}

function writeTokenCache(env, data) {
    if (!existsSync(TOKEN_DIR)) {
        mkdirSync(TOKEN_DIR, { recursive: true });
    }
    writeFileSync(tokenCachePath(env), JSON.stringify(data, null, 2), 'utf-8');
}

// --- PKCE helpers ----------------------------------------------------------------

function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// --- Token refresh (silent) ------------------------------------------------------

async function refreshAccessToken(env, refreshToken) {
    const { clientId } = ENV_CONFIG[env];

    const response = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
        return null; // refresh failed — need browser login
    }

    const data = await response.json();

    // Update cache with new tokens (rotating refresh token)
    writeTokenCache(env, {
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshToken,
        expires_at: Date.now() + (data.expires_in - 60) * 1000,
    });

    return data.access_token;
}

// --- Browser login (Authorization Code + PKCE) -----------------------------------

function openBrowser(url) {
    try {
        if (process.platform === 'win32') {
            execSync(`start "" "${url}"`, { stdio: 'ignore' });
        } else if (process.platform === 'darwin') {
            execSync(`open "${url}"`, { stdio: 'ignore' });
        } else {
            execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
        }
    } catch {
        // If auto-open fails, user can manually visit the URL
    }
}

async function browserLogin(env) {
    const { clientId, audience } = ENV_CONFIG[env];

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = crypto.randomBytes(16).toString('hex');

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: CALLBACK_URI,
        scope: 'openid profile email offline_access',
        audience,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
    });
    const authorizeUrl = `https://${AUTH0_DOMAIN}/authorize?${params}`;

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            server.close();
            reject(new Error('OAuth login timed out (60s). Try again.'));
        }, 60000);

        const server = http.createServer(async (req, res) => {
            if (!req.url?.startsWith(CALLBACK_PATH)) {
                res.writeHead(404);
                res.end();
                return;
            }

            const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
            const code = url.searchParams.get('code');
            const returnedState = url.searchParams.get('state');
            const error = url.searchParams.get('error');

            if (error) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html><body><h2>Login failed</h2><p>You can close this tab.</p></body></html>');
                clearTimeout(timeout);
                server.close();
                reject(new Error(`OAuth error: ${error} — ${url.searchParams.get('error_description')}`));
                return;
            }

            if (!code || returnedState !== state) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end('<html><body><h2>Invalid callback</h2></body></html>');
                return;
            }

            // Exchange code for tokens — public client, PKCE proves ownership
            try {
                const tokenResponse = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        grant_type: 'authorization_code',
                        client_id: clientId,
                        code,
                        redirect_uri: CALLBACK_URI,
                        code_verifier: codeVerifier,
                    }),
                    signal: AbortSignal.timeout(10000),
                });

                if (!tokenResponse.ok) {
                    const err = await tokenResponse.text();
                    throw new Error(`Token exchange failed (${tokenResponse.status}): ${err}`);
                }

                const data = await tokenResponse.json();

                writeTokenCache(env, {
                    access_token: data.access_token,
                    refresh_token: data.refresh_token,
                    expires_at: Date.now() + (data.expires_in - 60) * 1000,
                });

                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html><body><h2>Logged in</h2><p>You can close this tab and return to the terminal.</p></body></html>');
                clearTimeout(timeout);
                server.close();
                resolve(data.access_token);
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end(`<html><body><h2>Error</h2><p>${e.message}</p></body></html>`);
                clearTimeout(timeout);
                server.close();
                reject(e);
            }
        });

        server.listen(CALLBACK_PORT, () => {
            console.log(`  🌐 Opening browser for login...`);
            console.log(`  ⏱️  Waiting for login (60s timeout)...`);
            openBrowser(authorizeUrl);
        });
    });
}

// --- Public API ------------------------------------------------------------------

/**
 * Resolve the API base URL for an environment.
 */
export function resolveApiUrl(env) {
    const config = ENV_CONFIG[env];
    if (!config) {
        throw new Error(`Unknown environment: ${env}. Valid: ${Object.keys(ENV_CONFIG).join(', ')}`);
    }
    return config.apiUrl;
}

/**
 * Acquire an OAuth access token for the given environment.
 * Uses cached refresh token if available (zero touch).
 * Falls back to browser login (Authorization Code + PKCE).
 */
export async function acquireOAuthToken(env) {
    const config = ENV_CONFIG[env];
    if (!config) {
        throw new Error(`Unknown environment: ${env}. Valid: ${Object.keys(ENV_CONFIG).join(', ')}`);
    }

    // 1. Check disk cache
    const cached = readTokenCache(env);
    if (cached) {
        if (cached.access_token && cached.expires_at && Date.now() < cached.expires_at) {
            return cached.access_token;
        }
        if (cached.refresh_token) {
            const token = await refreshAccessToken(env, cached.refresh_token);
            if (token) return token;
        }
    }

    // 2. Browser login
    return browserLogin(env);
}
