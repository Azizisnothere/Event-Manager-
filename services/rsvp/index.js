// services/rsvp/index.js  Routers of the RSVP service (owner: Abdelaziz).
// Mounted by dev-server.js on the PC and by lambdas/api.js on Lambda.
const { guestRsvpRoutes } = require('./src/routes/guestRsvp');
const { organizerRsvpRoutes } = require('./src/routes/organizerRsvp');

module.exports = [guestRsvpRoutes(), organizerRsvpRoutes()];
