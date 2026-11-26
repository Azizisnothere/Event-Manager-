# Team plan (application code only; cloud/Floci comes later)

Merge the pull requests in this order. Each person commits only their own files,
from their own laptop and GitHub account, on their own branch.

| # | Who | Branch | Files |
|-|-|-|-|
| 1 | Adham | db/schema | db/ (migrate.js, 001_schema.sql, [S] 002_app_role.sql) |
| 2 | Abdelaziz | shared/foundation | package.json, package-lock.json, .env.example, .gitignore, .gitattributes, shared/config, constants, utils, awsClients, lambdaHttp, errors, logger, db, appFactory, health, [S] secrets |
| 3 | Osama | shared/validation | shared/csv, [S] validation, [S] middleware/validate, [S] eventAccess, [S] middleware/authorize |
| 4 | Adham | shared/audit-messaging | [S] shared/audit, messaging, emailQueue, sqsHandler, [S] s3 |
| 5 | Abdelaziz | services/auth | [S] crypto, [S] requestGuard, [S] middleware/authenticate, invitationToken, rateLimit, shared/index.js, services/auth/, dev-server.js (with only health + auth routers) |
| 6 | Adham | events/staff | services/events/src/routes/staff.js, frontend/organizer/js/tabs/staff.js |
| 7 | Osama | services/events | rest of services/events/ (routes, lib, validators, importProcessor), frontend/index.html, frontend/js/, frontend/shared/, frontend/organizer/ (except the 5 tabs below); add the events + import-processor lines to dev-server.js |
| 8 | Abdelaziz | services/rsvp | services/rsvp/, frontend/guest/, frontend/organizer/js/tabs/rsvps.js + waitlist.js; add the rsvp + consumer lines to dev-server.js |
| 9 | Adham | services/checkin | services/checkin/, frontend/staff/, frontend/organizer/js/tabs/live.js + report.js, services/events/lambdas/notifier.js + scheduler.js, services/events/src/lib/emailTemplates.js; add checkin, report-generator, notifier and scheduler lines to dev-server.js |
| 10 | Adham | tests/postman | tests/postman/, README.md |

Step 6 must be merged BEFORE step 7 (services/events/index.js loads routes/staff.js).
[S] = security control: write it yourself; the included file is only a reference.
Later (cloud): infra/, spikes/, services/*/lambdas/api.js, IAM policies, Floci deploy.
