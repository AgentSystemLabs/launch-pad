# Postgres API + Migration Task

This example verifies Launch Pad managed Postgres with:

- `api`: a public Express API at `api.lp-db-test.webdevcody.com`.
- `migrate`: a one-off `[[job]]` container that runs an idempotent migration.
- `primary`: a managed `[[database]]` Postgres service with a persistent data volume.

The API and migration task connect to Postgres through the same-node service DNS alias
`primary` on Launch Pad's per-footprint Docker network.

```bash
launchpad cluster create lp-db-test --region us-east-1

launchpad secret set POSTGRES_PASSWORD --service primary
launchpad secret set DATABASE_URL --service api
launchpad secret set DATABASE_URL --service migrate

./deploy.sh
```

`deploy.sh` deliberately gates the API deploy on a successful migration:

```bash
launchpad deploy --cluster lp-db-test --service primary --yes
launchpad job run migrate --cluster lp-db-test --wait --yes
launchpad deploy --cluster lp-db-test --service api --yes
launchpad dns verify api.lp-db-test.webdevcody.com --cluster lp-db-test

curl https://api.lp-db-test.webdevcody.com/healthz
curl https://api.lp-db-test.webdevcody.com/db
```

`/db` should return the `001-create-launchpad-migrations` row after the `migrate`
job exits successfully.
