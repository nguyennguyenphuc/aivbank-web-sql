# Production Deployment

This directory contains the tracked production deployment flow for the rootless Podman stack that serves `https://candy.longh.work`.

The deployment is SHA-pinned and isolated:

- `candy` is the only tunnel for this hostname.
- No container publishes a host port.
- The host Cloudflare tunnel jobs already on the Mac mini stay untouched.
- The Podman connection must remain `podman-machine-default` and rootless.

## Runtime Layout

The stack runs these services from `infra/production/compose.yml`:

- `web` on container port `8080`
- `api` on container port `3001`
- `postgres`
- `redis`
- `cloudflared`
- `ops` for one-shot migrations

The production env file is external and private:

- `~/Services/match3-h5/shared/.env.production`

The file names referenced by the env example are:

- `MATCH3_ENV_FILE`
- `POSTGRES_PASSWORD_FILE`
- `MATCH3_DB_PASSWORD_FILE`
- `REDIS_ACL_FILE`
- `REDIS_PASSWORD_FILE`
- `CLOUDFLARED_CONFIG_FILE`
- `CLOUDFLARED_CREDENTIALS_FILE`
- `BACKUP_DIR`

`bootstrap-db-role.sh` uses the mounted `match3-app-password` secret to create or update the non-superuser `match3_app` owner role.

## First Deploy

First deploy means a clean, approved SHA in a detached release directory under `~/Services/match3-h5/releases/<full-git-sha>/`.

The release entrypoint is:

```sh
cd ~/Services/match3-h5/current
CANDY_RELEASE_DIR="$PWD" \
CANDY_ENV_FILE=~/Services/match3-h5/shared/.env.production \
CANDY_RELEASE_SHA=<full-git-sha> \
  infra/production/scripts/deploy-stack.sh
```

What `deploy-stack.sh` does:

1. validates the release tree is clean
2. validates the Compose render does not publish host ports
3. builds the immutable release images
4. starts `postgres` and `redis`
5. boots the database app role with `bootstrap-db-role.sh`
6. runs the one-shot `ops` migrations
7. starts `api`, `web`, and `cloudflared`
8. waits for health/running state

Do not run demo seeding for public production.

## Dedicated Tunnel

`cloudflared` runs inside the Compose project and connects directly to the `web` service over the private `edge` network.

The tunnel must be dedicated to `candy` and must not reuse any existing host tunnel credential or process.

The effective ingress is:

```yaml
ingress:
  - hostname: candy.longh.work
    service: http://web:8080
  - service: http_status:404
```

Before creating it, stop if either command shows an existing `candy` resource:

```sh
cloudflared tunnel list --name candy
dig +short candy.longh.work A
dig +short candy.longh.work AAAA
dig +short candy.longh.work CNAME
```

Create only the dedicated tunnel and route, then place its credential at the external path configured by `CLOUDFLARED_CREDENTIALS_FILE`:

```sh
cloudflared tunnel create candy
cloudflared tunnel route dns candy candy.longh.work
```

Its private `config.yml` must name that new tunnel, set `credentials-file: /run/secrets/cloudflared-credentials.json`, and contain the ingress above. Never edit, unload, or restart the existing host Cloudflare LaunchAgent.

## Update

Updates are immutable SHA updates.

1. Keep the previous release directory intact.
2. Add the new release under `~/Services/match3-h5/releases/<new-sha>/`.
3. Move `current` to that release.
4. Run `deploy-stack.sh` for the new SHA.
5. Run `verify-stack.sh` against the public origin.

If only reconciliation is needed, use:

```sh
cd ~/Services/match3-h5/current
CANDY_RELEASE_DIR="$PWD" \
CANDY_ENV_FILE=~/Services/match3-h5/shared/.env.production \
  infra/production/scripts/reconcile-stack.sh
```

`reconcile-stack.sh` is intentionally narrow: it brings the `candy` Compose project back to the expected state and waits for health.

## Rollback

Rollback is also SHA-based.

1. Re-point `current` to the last known good release.
2. Set `IMAGE_TAG` and `RELEASE_SHA` in the protected env file back to that exact SHA.
3. Run `reconcile-stack.sh` so the retained images are reused without pulling or rebuilding mutable base tags.
4. Re-run `verify-stack.sh`.
5. Keep the previous images and release directory until the rollback is proven.

If a database schema reversal is required, only use `npm run db:rollback` after the down migration has been explicitly tested. Otherwise restore a backup into a fresh empty database and cut over deliberately after validation.

## Backup And Restore

Backups are host-side custom-format dumps stored outside the Podman VM.

Create a backup with:

```sh
cd ~/Services/match3-h5/current
CANDY_RELEASE_DIR="$PWD" \
CANDY_ENV_FILE=~/Services/match3-h5/shared/.env.production \
CANDY_BACKUP_DIR=~/Services/match3-h5/backups \
  infra/production/scripts/backup-postgres.sh
```

The script writes:

- `match3-h5-<timestamp>.dump`
- `match3-h5-<timestamp>.dump.sha256`

Restore-drill a backup with:

```sh
cd ~/Services/match3-h5/current
CANDY_RELEASE_DIR="$PWD" \
CANDY_ENV_FILE=~/Services/match3-h5/shared/.env.production \
CANDY_BACKUP_DIR=~/Services/match3-h5/backups \
CANDY_BACKUP_FILE=~/Services/match3-h5/backups/<backup-file>.dump \
  infra/production/scripts/restore-drill.sh
```

The restore drill verifies the checksum sidecar, restores into a temporary recovery database, checks migration history, and then drops the recovery database.

Do not treat a named volume snapshot as a backup.

## Verification

The public verification script is:

```sh
cd ~/Services/match3-h5/current
CANDY_RELEASE_DIR="$PWD" \
CANDY_ENV_FILE=~/Services/match3-h5/shared/.env.production \
CANDY_PUBLIC_ORIGIN=https://candy.longh.work \
  infra/production/scripts/verify-stack.sh
```

It checks:

- all candy containers are running
- no container publishes a host port
- `web` serves the app shell
- `/api/health` and `/api/ready` work through the public hostname
- hashed assets, the service worker, and the manifest load
- SPA fallback works

## Logs

Container logs are written by the Compose logging driver and rotated at 10 MB.

Useful checks:

```sh
podman ps
podman port <container-id>
podman logs --tail 80 <container-id>
podman inspect <container-id>
```

LaunchAgent logs live under:

- `~/Services/match3-h5/logs/launchd.stdout.log`
- `~/Services/match3-h5/logs/launchd.stderr.log`

## LaunchAgent And Reboot

The tracked LaunchAgent template is:

- `infra/production/launchd/com.longh.candy-match3.plist.template`

The wrapper is:

- `infra/production/launchd/start-candy-stack.sh`

On login or reboot, the wrapper:

1. starts `podman-machine-default` if needed
2. waits with bounded retries for the Podman socket
3. checks the connection is still rootless
4. runs `reconcile-stack.sh`

It exits after reconciliation. Do not add an always-on restart loop.

Render and install only the dedicated LaunchAgent:

```sh
sed "s#__HOME__#$HOME#g" \
  ~/Services/match3-h5/current/infra/production/launchd/com.longh.candy-match3.plist.template \
  > ~/Library/LaunchAgents/com.longh.candy-match3.plist
chmod 600 ~/Library/LaunchAgents/com.longh.candy-match3.plist
plutil -lint ~/Library/LaunchAgents/com.longh.candy-match3.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.longh.candy-match3.plist
launchctl kickstart -k "gui/$(id -u)/com.longh.candy-match3"
```

Confirm whether the deploy user automatically logs in; this user LaunchAgent requires that GUI session. Then perform one real reboot and confirm the stack/public hostname return without manual Terminal work. Re-check the existing host Cloudflare jobs and port `8780` before and after.

## Deferred Items

These are intentionally deferred unless the user explicitly asks for them:

- `db:seed-demo`
- the large teaching dataset import
- real ad and payment provider cutover
- broader monitoring dashboards beyond logs and health checks
- Cloudflare Access changes once the release is no longer a restricted preview

## Current Variables

The production scripts currently depend on these shell variables:

- `CANDY_RELEASE_DIR`
- `CANDY_ENV_FILE`
- `CANDY_RELEASE_SHA`
- `CANDY_PUBLIC_ORIGIN`
- `CANDY_BACKUP_DIR`
- `CANDY_BACKUP_FILE`

The env example also defines the external secret file paths used by Compose.
