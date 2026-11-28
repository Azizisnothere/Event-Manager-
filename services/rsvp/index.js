const { guestRsvpRoutes } = require('./src/routes/guestRsvp');
const { organizerRsvpRoutes } = require('./src/routes/organizerRsvp');

module.exports = [guestRsvpRoutes(), organizerRsvpRoutes()];
