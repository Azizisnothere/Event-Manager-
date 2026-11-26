// services/checkin/index.js  Routers of the Check-in service (owner: Adham).
// Mounted by dev-server.js on the PC and by lambdas/api.js on Lambda.
const { doorListRoutes } = require('./src/routes/doorList');
const { checkInRoutes } = require('./src/routes/checkIns');
const { attendanceRoutes } = require('./src/routes/attendance');

module.exports = [doorListRoutes(), checkInRoutes(), attendanceRoutes()];
