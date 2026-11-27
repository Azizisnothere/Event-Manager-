// shared/index.js  One import for the services:
//   const { db, errors, logger, middleware: { authenticate, requireRole } } = require('../../../shared');
const config = require('./config');
const constants = require('./constants');
const { logger } = require('./logger');
const errors = require('./errors');
const secrets = require('./secrets');
const db = require('./db');
const utils = require('./utils');
const cryptoUtils = require('./crypto');
const validation = require('./validation');
const csv = require('./csv');
const aws = require('./awsClients');
const s3 = require('./s3');
const requestGuard = require('./requestGuard');
const audit = require('./audit');
const messaging = require('./messaging');
const emailQueue = require('./emailQueue');
const eventAccess = require('./eventAccess');
const sqsHandler = require('./sqsHandler');
const { createApp } = require('./appFactory');
const { toLambdaHandler } = require('./lambdaHttp');

const middleware = {
  ...require('./middleware/authenticate'),
  ...require('./middleware/invitationToken'),
  ...require('./middleware/authorize'),
  ...require('./middleware/validate'),
  ...require('./middleware/rateLimit')
};

module.exports = {
  config, constants, logger, errors, secrets, db, utils, crypto: cryptoUtils, validation, csv, aws, s3,
  requestGuard, audit, messaging, emailQueue, eventAccess, sqsHandler, middleware, createApp, toLambdaHandler
};
