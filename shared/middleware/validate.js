'use strict';
const { validate } = require('../validation');

function validateRequest(schemas = {}) {
  return function validateMiddleware(req, res, next) {
    try {
      req.valid = req.valid || {};
      req.valid.params = schemas.params ? validate(schemas.params, req.params, { allowUnknown: true }) : {};
      req.valid.query = validate(schemas.query || {}, req.query, { coerce: true });
      if (req.method === 'GET' || req.method === 'DELETE') {
        req.valid.body = validate(schemas.body || {}, req.body || {}, {});
      } else {
        req.valid.body = validate(schemas.body || {}, req.body, { minFields: schemas.bodyMinFields });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { validateRequest };
