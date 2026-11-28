const { doorListRoutes } = require('./src/routes/doorList');
const { checkInRoutes } = require('./src/routes/checkIns');
const { attendanceRoutes } = require('./src/routes/attendance');

module.exports = [doorListRoutes(), checkInRoutes(), attendanceRoutes()];
