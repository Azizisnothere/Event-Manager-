const { createApp, toLambdaHandler } = require('../../../shared');
const { LARGE_BODY_PATHS } = require('../../../shared/constants');
const routers = require('..');

exports.handler = toLambdaHandler(createApp(routers, { largeBodyPaths: LARGE_BODY_PATHS }));
