# Feasibility Checks



|Spike|Date|Who|Result|
|-|-|-|-|
|S1 Lambda on Floci reaches the internet (HTTPS)|2026-11-20|Abdelaziz , Osama , Adham|PASS: Turnstile siteverify 200, success=true, 331 ms, Node v24.22.3, runtime nodejs24.x|
|S2 Row lock held across statements, Lambda on Floci -> Neon|2026-11-20|Abdelaziz, Osama, Adham|PASS: connection B waited 2.9 s for A's SELECT ... FOR UPDATE lock; Neon PostgreSQL 18.7, Frankfurt, driver pg|



Environment: Floci 2.5.0 community edition, image pinned by digest in infra/floci/docker-compose.yml.






## S2 output



Decision D-01: use the `pg` driver (not the Lab 5 `neon()` HTTP driver), because the capacity rule needs this lock across statements.

