const { createApp, toLambdaHandler } = require('../../../shared');
const health = require('../../../shared/health');
const routers = require('..');

exports.handler = toLambdaHandler(createApp([health, ...routers]));
