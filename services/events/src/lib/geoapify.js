'use strict';
const { secrets, config, logger } = require('../../../../shared');

const DEFAULT_URL = 'https://api.geoapify.com/v1/geocode/search';
const TIMEOUT_MS = 4000;
const MIN_CONFIDENCE = 0.3;

function apiUrl() {
  if (!config.isProduction && process.env.GEOAPIFY_API_URL) return process.env.GEOAPIFY_API_URL;
  return DEFAULT_URL;
}

async function geocodeAddress(address) {
  if (!secrets.isSecretConfigured('geoapifyApiKey')) {
    logger.warn('geoapify_not_configured');
    return { status: 'unavailable' };
  }
  let apiKey;
  try {
    apiKey = await secrets.getSecret('geoapifyApiKey');
  } catch (err) {
    logger.error('geoapify_key_unavailable', { error: err });
    return { status: 'unavailable' };
  }

  const url = new URL(apiUrl());
  url.searchParams.set('text', address);
  url.searchParams.set('limit', '1');
  url.searchParams.set('format', 'json');
  url.searchParams.set('apiKey', apiKey);

  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    logger.warn('geoapify_request_failed', { error_name: err.name });
    return { status: 'unavailable' };
  }
  if (!res.ok) {
    logger.warn('geoapify_bad_status', { status: res.status });
    return { status: 'unavailable' };
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { status: 'unavailable' };
  }
  const first = body && Array.isArray(body.results) ? body.results[0] : null;
  if (!first || typeof first.lat !== 'number' || typeof first.lon !== 'number') return { status: 'not_found' };
  const confidence = first.rank && typeof first.rank.confidence === 'number' ? first.rank.confidence : 1;
  if (confidence < MIN_CONFIDENCE) return { status: 'not_found' };
  if (first.lat < -90 || first.lat > 90 || first.lon < -180 || first.lon > 180) return { status: 'not_found' };
  return {
    status: 'found',
    lat: first.lat,
    lng: first.lon,
    formatted: typeof first.formatted === 'string' ? first.formatted.slice(0, 300) : null,
  };
}

module.exports = { geocodeAddress };
