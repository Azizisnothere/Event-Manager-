// checkin-fn: API Gateway routes /api/events/:eventId/{door-list,check-ins,attendance}.
const { createApp, toLambdaHandler } = require('../../../shared');
const routers = require('..');

exports.handler = toLambdaHandler(createApp(routers));
