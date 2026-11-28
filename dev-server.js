require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const express = require('express');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'dev-server';
if (process.env.NODE_ENV === 'production') {
  console.error('dev-server.js is a development tool and refuses to run with NODE_ENV=production.');
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 3000;
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT) || 8080;
process.env.FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || `http://localhost:${FRONTEND_PORT}`;

const { createApp, messaging, db, s3, config, logger } = require('./shared');
const { LARGE_BODY_PATHS } = require('./shared/constants');
const health = require('./shared/health');

const routers = [
  health,
  ...require('./services/auth'),
  ...require('./services/events'),
  ...require('./services/rsvp'),
  ...require('./services/checkin')
];

const rsvpConsumer = require('./services/rsvp/lambdas/consumer');
const reportGenerator = require('./services/checkin/lambdas/reportGenerator');
const notifier = require('./services/events/lambdas/notifier');
const scheduler = require('./services/events/lambdas/scheduler');
const importProcessor = require('./services/events/lambdas/importProcessor');

const OUTBOX_DIR = path.join(__dirname, 'dev', 'outbox');
const outbox = [];
const realEmail = process.env.DEV_SEND_REAL_EMAIL === 'true';

if (!config.domainEventsTopicArn) {
  messaging.registerLocalHandler('domain', (envelope) => rsvpConsumer.processEnvelope(envelope));
  messaging.registerLocalHandler('domain', (envelope) => reportGenerator.processEnvelope(envelope));
}

const fileTransport = {
  async send({ to, subject, html, template }) {
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    const safeTo = String(to.email).replace(/[^A-Za-z0-9@._-]/g, '_');
    const file = path.join(OUTBOX_DIR, `${Date.now()}-${template}-${safeTo}.html`);
    fs.writeFileSync(file, `<!-- To: ${safeTo} | Subject: ${subject.replace(/--/g, '- -')} -->\n${html}`);
    console.log(`[dev-email] ${template} -> ${safeTo}: ${path.relative(__dirname, file)}`);
  }
};

if (!config.notificationsQueueUrl) {
  messaging.registerLocalHandler('email', async (job) => {
    outbox.push({ at: new Date().toISOString(), to: job.to.email.toLowerCase(), template: job.template, params: job.params });
    if (outbox.length > 200) outbox.shift();
    await notifier.processJob(job, realEmail ? {} : { transport: fileTransport });
  });
}

const app = createApp(routers, { largeBodyPaths: LARGE_BODY_PATHS });

const devApp = express();
devApp.disable('x-powered-by');
if (process.env.DEV_OUTBOX_API !== 'false') {
  devApp.get('/__dev/outbox', (req, res) => {
    const email = String(req.query.email || '').toLowerCase();
    const template = req.query.template ? String(req.query.template) : null;
    const items = outbox
      .filter((o) => (!email || o.to === email) && (!template || o.template === template))
      .slice(-20)
      .reverse()
      .map((o) => {
        const link = o.params.invitation_url || o.params.setup_url || null;
        const m = link ? /#t=([A-Za-z0-9_-]{43})/.exec(link) : null;
        return { at: o.at, to: o.to, template: o.template, link, token: m ? m[1] : null, check_in_code: o.params.check_in_code || null };
      });
    res.set('Cache-Control', 'no-store').json({ items });
  });
}
devApp.use(app);

devApp.listen(PORT, () => {
  console.log(`Event Manager API listening on http://localhost:${PORT}`);
  console.log(`  Emails: ${realEmail ? 'sent with Brevo' : `written to ${path.relative(__dirname, OUTBOX_DIR)}/`}`);
});

if (process.env.SERVE_FRONTEND !== 'false') {
  const web = express();
  web.disable('x-powered-by');
  web.use(express.static(path.join(__dirname, 'frontend'), {
    extensions: ['html'],
    setHeaders(res) {
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Referrer-Policy', 'no-referrer');
      res.set('X-Frame-Options', 'DENY');
    }
  }));
  web.listen(FRONTEND_PORT, () => {
    console.log(`Frontend on http://localhost:${FRONTEND_PORT}`);
    console.log(`  Organizer: http://localhost:${FRONTEND_PORT}/organizer/   Staff: http://localhost:${FRONTEND_PORT}/staff/`);
  });
}

const schedulerSeconds = Number(process.env.DEV_SCHEDULER_SECONDS) || 60;
setInterval(() => {
  scheduler.runScheduler().catch((error) => logger.error('dev scheduler failed', { error }));
}, Math.max(5, schedulerSeconds) * 1000);

if (config.importsBucket) {
  setInterval(async () => {
    try {
      const { rows } = await db.query(
        `SELECT s3_key FROM guest_list_imports WHERE status = 'pending' AND created_at > now() - interval '15 minutes'`
      );
      for (const r of rows) {
        try {
          await s3.headObject({ bucket: config.importsBucket, key: r.s3_key });
        } catch {
          continue;
        }
        await importProcessor.processImportObject(config.importsBucket, r.s3_key);
      }
    } catch (error) {
      logger.error('dev import poll failed', { error });
    }
  }, 5000);
}
