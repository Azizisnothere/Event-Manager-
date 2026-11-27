# Cloud evidence: Event Manager on Floci (Group 6)

Every file is a command and its real output, collected by `bash infra/evidence.sh`
on the deployment that `bash infra/run-floci.sh` built. Secret values are never shown.

| File | Evidence | Report section |
|-|-|-|
| 00-check.txt | 70 automated checks of every service, incl. end-to-end health | 3.5 / 4 Deployment, 13 Testing |
| 01-s3.txt | 4 buckets, private data buckets, PUT-only CORS, public read-only website, CSV trigger | 2.2, Threat 7 |
| 02-dynamodb.txt | em-request-guard, on-demand, TTL | 2.2 (Abdelaziz), rate limiting |
| 03-sqs.txt | 3 queues + DLQs (5 tries, 14 days), queue policies | 2.2, reliability |
| 04-sns.txt | em-domain-events fan-out with filter policies | 2.2 (Osama), 2.3 flows |
| 05-secrets.txt | 5 secrets (names only); Lambdas get only names | Threat 8 |
| 06-eventbridge.txt | 5-minute schedule -> scheduler-fn | 2.2 (Osama) |
| 07-iam.txt | one role per function, trust policy, attached policies | least privilege, 12 |
| 08-cloudwatch.txt | log groups, security metrics, alarms | 11 Logging and monitoring (Adham) |
| 09-lambda.txt | 9 functions, runtime, handler, role | 2.2, 4 |
| 10-triggers.txt | SQS/S3/EventBridge triggers and resource policies | 2.3 flows |
| 11-api-gateway.txt | REST API em-api, stage prod, 18 routes, health, unknown path rejected, 401 without login | 2.2, Threats 1-3 |
| 12-website.txt | website on S3, config.js -> API, public link | 4 Deployment |
| 13-scripts.txt | the per-service scripts (like Lab 8) | Appendix |

## Screenshots (folder screenshots/, taken from Floci Dash and the public site)

| File | Shows | Report section |
|-|-|-|
| s02-floci-home.jpg | Floci Dash home: all services running, resource counts | 4 Deployment |
| s03-lambda.jpg | the em-...-fn Lambda functions: runtime, handler, memory, timeout, Active | 2.2, 4 |
| s04-s3-buckets.jpg | the 4 em- buckets | 2.2 |
| s05-sqs.jpg | 3 queues + 3 dead-letter queues | 2.2 |
| s06-sns-topics.jpg | em-domain-events and em-security-alerts | 2.2, 11 |
| s07-sns-subscriptions.jpg | em-domain-events -> em-rsvp-events and em-checkin-events (confirmed) | 2.3 flows |
| s08-dynamodb.jpg | table em-request-guard | 2.2 |
| s09-secrets-names.jpg | 5 secrets (names only, values not opened) | Threat 8 |
| s10-api-gateway.jpg | REST API em-api | 2.2 |
| s11-eventbridge.jpg | rule em-scheduler-every-5-min, rate(5 minutes), enabled | 2.2 |
| s12-cloudwatch-logs.jpg | /aws/lambda/em-... log groups, 14-day retention | 11 |
| s13-api-gateway-routes.jpg | em-api resources (paths -> ANY) | 2.2 |
| s14-api-gateway-stage-prod.jpg | stage prod deployed | 4 |
| s15-iam-roles.jpg | 9 roles, one per function | least privilege, 12 |
| s16-s3-guest-imports-public-access.jpg | all 4 public-access blocks ON | Threat 7 |
| s17-s3-guest-imports-cors.jpg | CORS: PUT only, from our website origins | Threat 7 |
| s18-s3-trigger-import-fn.jpg | S3 ObjectCreated -> em-import-fn | 2.3 flows |
| s19-cloudwatch-alarms.jpg | alarms: repeated failed logins (5), access denied (10) | 11, Threats 1 and 3 |
| s20-public-website-login.jpg | the website served from S3 through the public HTTPS link | 4 Deployment |
| s21-api-health-public.jpg | /api/health through the public link: api, database (Neon), secrets ok, runtime lambda | 4, 13 |

Still worth adding yourself (need your login/email): the event page with a verified venue,
the invitation email with the public link, the guest RSVP page, and Neon console > Tables.
