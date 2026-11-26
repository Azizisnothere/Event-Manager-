Adham - your application files (36 files, about 3111 lines of code)

1. Unzip OUTSIDE your repo clone.
2. Copy these files into your clone, same folders.
3. Commit from YOUR OWN GitHub account on your own branch, in the order in TEAM-PLAN.md.
4. Never commit .env.

SECURITY FILES - write these yourself (course rule); the included version is only a reference:
  - db/migrations/002_app_role.sql
  - shared/audit.js
  - shared/s3.js
  - services/checkin/ (check-in window and staff-assignment checks)
  - services/events/src/routes/staff.js (organizer-only + ownership checks)

YOUR FILES:
  README.md
  db/migrate.js
  db/migrations/001_schema.sql
  db/migrations/002_app_role.sql
  frontend/organizer/js/tabs/live.js
  frontend/organizer/js/tabs/report.js
  frontend/organizer/js/tabs/staff.js
  frontend/staff/door.html
  frontend/staff/events.html
  frontend/staff/index.html
  frontend/staff/js/door.js
  frontend/staff/js/events.js
  frontend/staff/js/setup.js
  frontend/staff/setup.html
  services/checkin/index.js
  services/checkin/lambdas/reportGenerator.js
  services/checkin/src/lib/checkinWindow.js
  services/checkin/src/lib/reportBuilder.js
  services/checkin/src/routes/attendance.js
  services/checkin/src/routes/checkIns.js
  services/checkin/src/routes/doorList.js
  services/checkin/src/validators.js
  services/events/lambdas/notifier.js
  services/events/lambdas/scheduler.js
  services/events/src/lib/emailTemplates.js
  services/events/src/routes/staff.js
  shared/audit.js
  shared/emailQueue.js
  shared/messaging.js
  shared/s3.js
  shared/sqsHandler.js
  tests/postman/auth.postman_collection.json
  tests/postman/checkin.postman_collection.json
  tests/postman/event-manager.postman_environment.json
  tests/postman/events.postman_collection.json
  tests/postman/rsvp.postman_collection.json
