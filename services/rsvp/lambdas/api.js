
const { createApp, toLambdaHandler } = require('../../../shared');
const routers = require('..');

exports.handler = toLambdaHandler(createApp(routers));