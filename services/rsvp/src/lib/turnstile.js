'use strict';
/**
 * Cloudflare Turnstile server-side verification (Section 1.5, Threat 6).
 * Returns { success: true } or { success: false, unavailable: boolean, codes: string[] }.
 * "unavailable" means Cloudflare could not be reached (the caller answers 503, not 403).
 * The secret key and the client token are never logged.
 */
const { secrets, config, logger } = require('../../../../shared');

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;

function verifyUrl() {
  // Override only for local testing against a stub; ignored in production.
  if (!config.isProduction && process.env.TURNSTILE_VERIFY_URL) return process.env.TURNSTILE_VERIFY_URL;
  return SITEVERIFY_URL;
}

/**
 * @param {string} token value produced by the Turnstile widget (cf-turnstile-response)
 * @param {string|null} remoteIp client IP from API Gateway
 */
async function verifyTurnstile(token, remoteIp) {
  let secret;
  try {
    secret = await secrets.getSecret('turnstileSecret');
  } catch (err) {
    logger.error('turnstile_secret_unavailable', { error: err });
    return { success: false, unavailable: true, codes: ['secret-unavailable'] };
  }
  const form = new URLSearchParams();
  form.set('secret', secret);
  form.set('response', token);
  if (remoteIp) form.set('remoteip', remoteIp);

  let res;
  try {
    res = await fetch(verifyUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn('turnstile_unreachable', { error_name: err.name });
    return { success: false, unavailable: true, codes: ['network-error'] };
  }
  if (!res.ok) {
    logger.warn('turnstile_bad_status', { status: res.status });
    return { success: false, unavailable: true, codes: [`http-${res.status}`] };
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { success: false, unavailable: true, codes: ['bad-response'] };
  }
  const codes = Array.isArray(body['error-codes']) ? body['error-codes'].map(String).slice(0, 5) : [];
  if (body.success !== true) return { success: false, unavailable: false, codes };
  const expectedHost = config.turnstileExpectedHostname;
  if (expectedHost && body.hostname && body.hostname !== expectedHost) {
    return { success: false, unavailable: false, codes: ['hostname-mismatch'] };
  }
  return { success: true, codes: [] };
}

module.exports = { verifyTurnstile };
