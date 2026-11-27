// events-fn: API Gateway routes /api/events/* (except the RSVP and check-in sub-paths),
// /api/staff* and POST /api/invitations/:token/plus-one-requests.
const { createApp, toLambdaHandler } = require('../../../shared');
const { LARGE_BODY_PATHS } = require('../../../shared/constants');
const routers = require('..');

exports.handler = toLambdaHandler(createApp(routers, { largeBodyPaths: LARGE_BODY_PATHS }));
