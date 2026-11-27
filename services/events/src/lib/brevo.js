'use strict';
/**
 * Brevo transactional email client (Section 1.5). Only the notifier Lambda loads the
 * Brevo API key (Section 6.2 "Least privilege", Threat 8). Recipient addresses and the
 * response body are never logged.
 */
const { secrets, config, logger } = require('../../../../shared');

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const TIMEOUT_MS = 8000;

class EmailSendError extends Error {
  constructor(message, { status, permanent }) {
    super(message);
    this.name = 'EmailSendError';
    this.status = status;
    this.permanent = permanent; // true -> retrying cannot help (e.g. rejected recipient)
  }
}

/**
 * @param {{ to: { email: string, name?: string }, subject: string, html: string, text: string }} msg
 * @returns {Promise<{ messageId: string|null }>}
 */
async function sendEmail({ to, subject, html, text }) {
  if (!config.brevoSenderEmail) {
    throw new EmailSendError('BREVO_SENDER_EMAIL is not configured', { status: 0, permanent: false });
  }
  const apiKey = await secrets.getSecret('brevoApiKey');
  let res;
  try {
    res = await fetch(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: config.brevoSenderEmail, name: config.brevoSenderName },
        to: [{ email: to.email, ...(to.name ? { name: to.name } : {}) }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new EmailSendError(`Brevo request failed: ${err.name}`, { status: 0, permanent: false });
  }
  if (res.ok) {
    let messageId = null;
    try {
      const body = await res.json();
      messageId = body && body.messageId ? String(body.messageId) : null;
    } catch (e) {
      messageId = null;
    }
    return { messageId };
  }
  // 400 = request rejected (e.g. invalid recipient): permanent. 401/403 = key problem, 429/5xx = transient.
  const permanent = res.status === 400;
  logger.warn('brevo_rejected', { status: res.status, permanent });
  throw new EmailSendError(`Brevo responded ${res.status}`, { status: res.status, permanent });
}

module.exports = { sendEmail, EmailSendError };
