const { importRoutes } = require('./src/routes/imports');
const { eventRoutes } = require('./src/routes/events');
const { eventStatusRoutes } = require('./src/routes/eventStatus');
const { invitationRoutes } = require('./src/routes/invitations');
const { plusOneRoutes } = require('./src/routes/plusOne');
const { staffRoutes } = require('./src/routes/staff');

module.exports = [importRoutes(), eventRoutes(), eventStatusRoutes(), invitationRoutes(), plusOneRoutes(), staffRoutes()];
