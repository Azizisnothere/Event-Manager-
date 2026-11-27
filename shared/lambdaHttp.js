'use strict';
/**
 * Adapts an Express app to an API Gateway Lambda handler with serverless-http,
 * so the same app runs locally (app.listen) and in Lambda.
 * The raw event/context are attached to req so requestContext can read the
 * source IP and request id from API Gateway instead of trusting headers.
 */
const serverless = require('serverless-http');

/** @param {import('express').Express} app */
function toLambdaHandler(app) {
  const handler = serverless(app, {
    request(req, event, context) {
      req.lambdaEvent = event;
      req.lambdaContext = context;
    },
  });
  return async function lambdaHandler(event, context) {
    // The pg pool keeps sockets open between invocations; do not wait for them.
    if (context) context.callbackWaitsForEmptyEventLoop = false;
    return handler(event, context);
  };
}

module.exports = { toLambdaHandler };
