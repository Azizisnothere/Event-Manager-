'use strict';
const { secrets, config, logger } = require('../../../../shared');

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const TIMEOUT_MS = 8000;

class EmailSendError extends Error {
  constructor(message, { status, permanent }) {
    super(message);
    this.name = 'EmailSendError';
    this.status = status;
    this.permanent = permanent;
  }
}

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
  const permanent = res.status === 400;
  logger.warn('brevo_rejected', { status: res.status, permanent });
  throw new EmailSendError(`Brevo responded ${res.status}`, { status: res.status, permanent });
}

module.exports = { sendEmail, EmailSendError };
