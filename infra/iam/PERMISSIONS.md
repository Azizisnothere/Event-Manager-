# IAM: what each Lambda function needs (least privilege, design 4.4 / 6.2)

Each function has its own role, `<function>-role`, created by `infra/deploy.js`.
The **policy documents are a security control**, so the team writes them:
one file per function in `infra/iam/policies/<function>.json` (e.g. `infra/iam/policies/em-auth-fn.json`).
`deploy.js` attaches the file if it exists and prints a warning if it does not.

Account on Floci: `000000000000`, region `us-east-1`. Allow only the actions and resources listed for that
function, nothing with `*` except the CloudWatch Logs line.

Every function also needs CloudWatch Logs for its own log group:
`logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` on `arn:aws:logs:us-east-1:000000000000:log-group:/aws/lambda/<function>:*`

| Function | Secrets Manager `GetSecretValue` | Other permissions |
|-|-|-|
| `em-auth-fn` | `em/db-url`, `em/jwt-secret` | `secretsmanager:DescribeSecret` on `em/jwt-secret` (health check); DynamoDB `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem` on table `em-request-guard` (login lockout) |
| `em-events-fn` | `em/db-url`, `em/jwt-secret`, `em/geoapify-api-key` | `sns:Publish` on topic `em-domain-events`; `sqs:SendMessage` on queue `em-notifications`; `s3:PutObject` on `em-guest-imports/imports/*` (signs the upload link); DynamoDB `GetItem`, `PutItem`, `UpdateItem` on `em-request-guard` (resend limit, guest rate limit) |
| `em-rsvp-fn` | `em/db-url`, `em/jwt-secret`, `em/turnstile-secret` | `sqs:SendMessage` on `em-notifications`; DynamoDB `GetItem`, `PutItem`, `UpdateItem` on `em-request-guard` (rate limits) |
| `em-checkin-fn` | `em/db-url`, `em/jwt-secret` | `s3:GetObject` on `em-reports/reports/*` (signs the download link) |
| `em-import-fn` | `em/db-url`, `em/jwt-secret` | `s3:GetObject` on `em-guest-imports/imports/*`; `sqs:SendMessage` on `em-notifications` |
| `em-scheduler-fn` | `em/db-url`, `em/jwt-secret` | `sns:Publish` on `em-domain-events` |
| `em-notifier-fn` | `em/brevo-api-key` **only** | `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on `em-notifications`; DynamoDB `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem` on `em-request-guard` (idempotency keys) |
| `em-rsvp-consumer-fn` | `em/db-url`, `em/jwt-secret` | `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on `em-rsvp-events`; `sqs:SendMessage` on `em-notifications`; DynamoDB `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem` on `em-request-guard` |
| `em-report-fn` | `em/db-url`, `em/jwt-secret` | `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on `em-checkin-events`; `s3:PutObject` on `em-reports/reports/*`; DynamoDB `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem` on `em-request-guard` |

`em/jwt-secret` is in every list because the audit log stores the client IP as an HMAC keyed with it.

ARN shapes:
- secret: `arn:aws:secretsmanager:us-east-1:000000000000:secret:em/db-url*` (the `*` covers the random suffix AWS adds)
- table: `arn:aws:dynamodb:us-east-1:000000000000:table/em-request-guard`
- topic: `arn:aws:sns:us-east-1:000000000000:em-domain-events`
- queue: `arn:aws:sqs:us-east-1:000000000000:em-notifications`
- object: `arn:aws:s3:::em-reports/reports/*`

Floci does not evaluate IAM policies unless `FLOCI_SERVICES_IAM_ENFORCEMENT_ENABLED=true`. Turn that on in
`infra/floci/docker-compose.yml` once all nine files exist, redeploy, and run the Postman tests: anything your
policies forgot will then fail with AccessDenied.
