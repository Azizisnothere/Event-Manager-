'use strict';
/**
 * Middleware step 5: validation of body, query string and path parameters.
 * Unknown fields are rejected (Section 6.2). Cleaned values are placed in
 * req.valid.body / req.valid.query / req.valid.params; handlers read only those.
 */
const { validate } = require('../validation');

/**
 * @param {{ body?: object, query?: object, params?: object, bodyMinFields?: number }} schemas
 *   Omit a part to require it to be empty (no body / no query parameters).
 */
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
