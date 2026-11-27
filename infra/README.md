# Deploying to Floci (design 3.5 and 4)

## 1. Deploy

Needs Docker Desktop running and a filled-in `.env` (same file as `npm run dev`).

```bash
npm install
npm run floci:up      # starts Floci (infra/floci/docker-compose.yml)
npm run deploy        # = infra/deploy.sh: creates/updates everything, prints the URLs
```

Run `npm run deploy` again after every merge:
each step is "create if missing, otherwise update". The URLs are also written to `infra/deploy-output.json`.

| What | Address on this PC |
|-|-|
| Website (S3) | `http://em-frontend.s3-website-us-east-1.localhost:4566/` |
| API (API Gateway, stage prod) | `http://localhost:4566/restapis/<api-id>/prod/_user_request_` |
| Health | `<API>/api/health` should say `"runtime":"lambda"` and every check `ok` |
| Floci console | `http://localhost:4566/_floci/ui` |

**Database.** The real deployment uses Neon: put the Neon `em_app` URL in `DATABASE_URL`.
If `DATABASE_URL` points at `localhost` (the Docker Postgres), deploy.js routes the Lambdas to
`host.docker.internal` without TLS and prints a warning. That mode is only for testing the deploy.

**IAM.** Each function has its own role. The policies are a security control written by the team:
see `infra/iam/PERMISSIONS.md`.

## 2. Public HTTPS link for the demo (Cloudflare quick tunnel)

Install `cloudflared` (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/),
then open two terminals:

```bash
# API
cloudflared tunnel --url http://localhost:4566
# Website (Floci picks the website bucket from the host name)
cloudflared tunnel --url http://localhost:4566 --http-host-header em-frontend.s3-website-us-east-1.localhost
```

Each prints an address like `https://random-words.trycloudflare.com`. Put them in `.env`:

```dotenv
PUBLIC_API_URL=https://<api-tunnel>.trycloudflare.com
PUBLIC_WEB_URL=https://<website-tunnel>.trycloudflare.com
```

Then `npm run deploy` again. It points the website at the public API, allows the public website in CORS,
and puts the public website address in the invitation emails.

For real bot protection, create a Turnstile widget for the website tunnel's hostname in the Cloudflare
dashboard, put its site key in `TURNSTILE_SITE_KEY` and its secret in `TURNSTILE_SECRET_KEY`, and deploy again.

Quick-tunnel addresses change every time cloudflared restarts, so update `.env` and deploy again after a restart.

## 3. Remove everything

```bash
npm run teardown      # = infra/teardown.sh; Neon is not touched
npm run floci:down
```
