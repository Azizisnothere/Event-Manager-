'use strict';
const serverless = require('serverless-http');

function toLambdaHandler(app) {
  const handler = serverless(app, {
    request(req, event, context) {
      req.lambdaEvent = event;
      req.lambdaContext = context;
    },
  });
  return async function lambdaHandler(event, context) {
    if (context) context.callbackWaitsForEmptyEventLoop = false;
    return handler(event, context);
  };
}

module.exports = { toLambdaHandler };
