// services/auth/index.js  Routers of the Auth service (owner: Abdelaziz).
// Mounted by dev-server.js on the PC and by lambdas/api.js on Lambda.
const { authRoutes } = require('./src/authRoutes');

module.exports = [authRoutes()];
