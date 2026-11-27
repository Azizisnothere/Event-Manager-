// services/events/index.js  Routers of the Event service (owner: Osama).
// Mounted by dev-server.js on the PC and by lambdas/api.js on Lambda.
const { importRoutes } = require('./src/routes/imports');
const { eventRoutes } = require('./src/routes/events');
const { eventStatusRoutes } = require('./src/routes/eventStatus');
const { invitationRoutes } = require('./src/routes/invitations');
const { plusOneRoutes } = require('./src/routes/plusOne');
const { staffRoutes } = require('./src/routes/staff');

// imports first, so /invitations/imports and /invitations/bulk are not read as an invitation id
module.exports = [importRoutes(), eventRoutes(), eventStatusRoutes(), invitationRoutes(), plusOneRoutes(), staffRoutes()];
