/*
 * Frontend configuration (public values only - never put secrets here).
 * API_BASE_URL: the API. On the PC dev-server.js serves the API on :3000 and these pages on :8080.
 *   For the S3 website set it to the API Gateway stage URL.
 * TURNSTILE_SITE_KEY: the default is Cloudflare's documented always-pass TEST site key;
 *   replace it with the real site key (public by design, Section 6.2).
 */
window.EM_CONFIG = Object.freeze({
  API_BASE_URL: 'http://localhost:3000',
  TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  POLL_INTERVAL_MS: 10000,
});
