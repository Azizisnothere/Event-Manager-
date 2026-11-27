# Event Manager

Invitation-only guest lists, RSVP and door check-in.
BUE 26CSCN29H Cloud Computing and Cloud Security, Group 6.

## Run it on your PC

Needs Node.js 20+ and a Postgres database (Neon, or a local Docker Postgres).

```bash
npm install
cp .env.example .env          # then fill in DATABASE_URL, MIGRATION_DATABASE_URL, EM_APP_DB_PASSWORD, JWT_SECRET, GEOAPIFY_API_KEY
npm run migrate               # creates the tables and the restricted em_app role
npm run dev                   # API on http://localhost:3000, pages on http://localhost:8080
```

- Organizer: http://localhost:8080/organizer/
- Staff: http://localhost:8080/staff/
- Health: http://localhost:3000/api/health
- Emails are written to `dev/outbox/*.html` (set `DEV_SEND_REAL_EMAIL=true` and `BREVO_API_KEY` to send real ones).
- Without Floci, rate limits and idempotency keys are kept in memory and SNS/SQS messages are delivered in-process.

Local Docker Postgres instead of Neon:

```bash
docker run -d --name em-postgres -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16
# .env:
# MIGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres
# DATABASE_URL=postgresql://em_app:<EM_APP_DB_PASSWORD>@localhost:5433/postgres
# DB_SSL=disable
```

## Tests

```bash
npm run dev      # in one terminal
npm test         # in another: runs the four Postman collections in tests/postman with newman
```

## Layout

| Folder | What | Owner |
|-|-|-|
| `shared/` | app factory (middleware order), errors, logger, db pool, validation, secrets, audit log, messaging | all |
| `shared/middleware/` | authenticate (JWT), invitation token, authorize (ownership), validate, rate limit | all |
| `services/auth` | register, login, staff setup, `/api/auth/me` | Abdelaziz |
| `services/events` | events, guest list (manual, pasted CSV, S3 CSV), plus-ones, staff, emails, scheduler | Osama |
| `services/rsvp` | guest RSVP, waitlist, capacity, organizer RSVP views | Abdelaziz |
| `services/checkin` | door list, check-in/undo, live attendance, report | Adham |
| `db/` | migrations (`001_schema.sql`, `002_app_role.sql`) and `migrate.js` | Adham |
| `frontend/` | organizer, staff and guest pages (vanilla HTML/CSS/JS) | Osama, Adham |
| `infra/` | Floci, IAM | all |

Each service has `index.js` (its routers, mounted by `dev-server.js`) and `lambdas/` (the Lambda handlers: `api.js` through serverless-http, plus the background functions).
