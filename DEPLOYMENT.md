# TopSkip production deployment

TopSkip is deployed as one container on the existing KojaKurtki VPS. A
Cloudflare Tunnel publishes `https://topskip.maximtop.dev` while Docker exposes
the backend only on `127.0.0.1:18787`. Existing Caddy and KojaKurtki containers
remain unchanged.

```text
Chrome background service worker
  -> https://topskip.maximtop.dev
  -> Cloudflare Tunnel
  -> http://127.0.0.1:18787
  -> topskip-backend:8787
```

The hostname is public by design. The tunnel hides the TopSkip origin route; it
does not make the shared VPS IP undiscoverable through unrelated services.

## Safety boundaries

- Use `ssh kojakurtki-vps` as the existing `deploy` user for provisioning. Do
  not enable root SSH and do not use the obsolete root alias
  `kojakurtki-vps-codex`.
- Do not publish container port `8787` on a non-loopback address.
- GitHub Actions receives no application or Cloudflare secrets. It gets a
  dedicated SSH key whose forced command accepts only `deploy`, `status`, and
  `rollback`.
- Images are deployed as `ghcr.io/...@sha256:...`; tags are never accepted by
  the server-side gateway.
- yt-dlp is installed from the repository pin during image build. Startup does
  not update it and the runtime image contains no yt-dlp manager or update
  script.
- The root filesystem is read-only. `/tmp` is a private 256 MiB tmpfs with
  `nosuid,nodev`; it must permit execution because the official standalone
  yt-dlp is a PyInstaller one-file binary that extracts its runtime there.

## One-time VPS provisioning

Prerequisites are Docker Engine with the Compose plugin, `flock`, `sudo`, and a
current `cloudflared` package. Confirm that the existing SSH path works before
changing infrastructure:

```bash
ssh kojakurtki-vps 'id && docker version && docker compose version'
```

Copy this repository's `deploy/` directory to a temporary location on the VPS,
then install the root-owned assets. The installer creates the locked deployment
account without a user-writable home, then creates its home and `.ssh` directory
as root-owned paths:

```bash
sudo deploy/scripts/install-vps-assets.sh "$PWD/deploy"
sudo cp deploy/production.env.example /opt/topskip/production.env
sudo chmod 0600 /opt/topskip/production.env
sudoedit /opt/topskip/production.env
```

The example intentionally contains empty secret values, so an unchanged copy
cannot start production. Generate `TOPSKIP_IP_HMAC_SECRET` with 32 random bytes,
for example with `openssl rand -hex 32`, and set the real OpenRouter key. Keep the
OpenRouter key and populated environment file off Git and out of shell history.
Set `TOPSKIP_ALLOWED_EXTENSION_ORIGINS` to the exact current beta origin in the
form `chrome-extension://<32-character-extension-id>`. Multiple exact origins
may be comma-separated during a controlled extension migration; wildcards and
spaces are rejected. Do not commit the real beta extension ID to the repository.
Production artifacts, installation records, quotas, and budget state use the
SQLite database at `/var/lib/topskip/topskip.sqlite`.

Create a separate Actions key locally. Do not reuse the KojaKurtki key:

```bash
ssh-keygen -t ed25519 -f "$HOME/.ssh/topskip-actions" -C topskip-actions
```

Build the restricted line from the generated public key without editing the
tracked example, then send it over the already verified maintenance SSH path:

```bash
{
  printf '%s' 'command="/usr/local/libexec/topskip-deploy-gateway",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty,no-user-rc '
  cat "$HOME/.ssh/topskip-actions.pub"
} | ssh kojakurtki-vps \
  'sudo tee /home/topskip-deploy/.ssh/authorized_keys >/dev/null && \
   sudo chown root:root /home/topskip-deploy/.ssh/authorized_keys && \
   sudo chmod 0644 /home/topskip-deploy/.ssh/authorized_keys && \
   sudo visudo --check --file=/etc/sudoers.d/topskip-deploy'
```

The account intentionally retains `/bin/bash` because OpenSSH invokes forced
commands through the user's shell. Password login is locked and the only
authorized key disables PTY, forwarding, agent forwarding, X11, and user rc.
The home directory and `authorized_keys` stay root-owned so the deployment user
cannot replace its own forced-command restriction.

Keep the current `deploy` SSH session open while checking whether sshd has an
explicit user allow-list:

```bash
sudo grep -RnsE '^[[:space:]]*AllowUsers[[:space:]]' \
  /etc/ssh/sshd_config /etc/ssh/sshd_config.d 2>/dev/null || true
sudo /usr/sbin/sshd -T | grep -E '^(allowusers|permitrootlogin) '
```

If no `AllowUsers` directive exists, do not introduce one solely for TopSkip. If
one exists, identify the file reported by `grep`, back it up, and add
`topskip-deploy` to the existing directive. Preserve `deploy` and every other
existing user or host pattern, and keep `PermitRootLogin no` unchanged. For
example, after replacing the path below with the file that contains the active
directive:

```bash
SSH_CONFIG_FILE=/etc/ssh/sshd_config
sudo cp --archive -- "$SSH_CONFIG_FILE" \
  "$SSH_CONFIG_FILE.before-topskip-$(date -u +%Y%m%dT%H%M%SZ)"
sudoedit "$SSH_CONFIG_FILE"
sudo /usr/sbin/sshd -t
sudo systemctl reload ssh
sudo /usr/sbin/sshd -T | grep -E '^(allowusers|permitrootlogin) '
```

Do not reload sshd if `sshd -t` reports an error. After a successful reload,
confirm that the effective output still contains `permitrootlogin no` and that
the allow-list contains both users. Before closing the original maintenance
session, verify both login paths from a second local terminal:

```bash
ssh kojakurtki-vps 'test "$(id -un)" = deploy'
ssh -i "$HOME/.ssh/topskip-actions" -l topskip-deploy kojakurtki-vps status
```

Only close the original session after both commands succeed. If either fails,
restore the timestamped backup from the still-open session, validate it with
`sudo /usr/sbin/sshd -t`, and reload `ssh` again.

`ghcr.io/maximtop/topskip-backend` is published as a public package because the
source repository is public. The deploy script therefore pulls immutable
digests anonymously and the VPS does not keep a GitHub credential. Verify this
from a client without a configured Docker credential before the first deploy.

If the package is intentionally made private later, create a dedicated token
with only `read:packages` and authenticate root's Docker client without putting
the token on the command line:

```bash
sudo --preserve-env=GHCR_TOKEN sh -c \
  'printf "%s" "$GHCR_TOKEN" | docker login ghcr.io --username maximtop --password-stdin'
sudo chmod 0600 /root/.docker/config.json
```

## Cloudflare Tunnel

Install `cloudflared` from Cloudflare's signed Ubuntu/Debian repository:

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | \
  sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | \
  sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update
sudo apt-get install cloudflared
test "$(command -v cloudflared)" = /usr/bin/cloudflared
```

These commands follow the
[official locally managed Tunnel installation](https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/).
Package upgrades are explicit operator maintenance; the service itself uses
`--no-autoupdate`.

Create the named tunnel `topskip-production` in Cloudflare and route
`topskip.maximtop.dev` to it. Prepare the service account and protected config
directory before copying its credential JSON:

```bash
id cloudflared >/dev/null 2>&1 || \
  sudo useradd --system --home /var/lib/cloudflared --shell /usr/sbin/nologin cloudflared
sudo install -d -o root -g cloudflared -m 0750 /etc/cloudflared
sudo cp TUNNEL_UUID.json /etc/cloudflared/TUNNEL_UUID.json
sudo cp deploy/cloudflared/topskip.yml.example /etc/cloudflared/topskip.yml
sudoedit /etc/cloudflared/topskip.yml
```

Replace the UUID and keep the final `http_status:404` ingress rule.

Install the dedicated unit after confirming `cloudflared` is at
`/usr/bin/cloudflared`:

```bash
sudo chown root:cloudflared /etc/cloudflared/topskip.yml /etc/cloudflared/*.json
sudo chmod 0640 /etc/cloudflared/topskip.yml /etc/cloudflared/*.json
sudo cp deploy/systemd/cloudflared-topskip.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-topskip.service
sudo systemctl status cloudflared-topskip.service
```

Create no TopSkip `A` or `AAAA` record containing the VPS IP. Configure the
Cloudflare rate rule for `/v1/analysis*` at 30 requests per 10 seconds per IP,
blocking for 10 seconds. Do not enable an interactive challenge because an MV3
background request cannot complete it.

Verify the origin boundary from a different machine:

```bash
curl --fail https://topskip.maximtop.dev/v1/health
nc -vz VPS_IP 18787  # must fail
```

## GitHub production environment

Create a protected environment named `production` with required reviewers and
these values:

| Kind     | Name                 | Value                                      |
| -------- | -------------------- | ------------------------------------------ |
| Secret   | `DEPLOY_HOST`        | VPS hostname used by GitHub Actions        |
| Variable | `DEPLOY_PORT`        | SSH port, normally `22`                    |
| Secret   | `DEPLOY_PRIVATE_KEY` | Contents of the dedicated private key      |
| Secret   | `DEPLOY_KNOWN_HOSTS` | Pinned `ssh-keyscan` line checked manually |

Branch protection must require the repository's `CI` workflow. The deploy
workflow independently rejects non-default branches and commits without a
successful `ci.yml` run.

## Deploy and rollback

Run **Deploy TopSkip production** using GitHub's `workflow_dispatch` UI on the
default branch. The workflow builds `linux/amd64`, publishes an immutable GHCR
digest, waits for production approval, then invokes the restricted gateway.

The root-owned deployment script serializes changes with `flock`, pulls before
replacement, waits for the Docker health check, and restores the previous image
if loopback health fails. Afterward Actions checks the public Tunnel endpoint.
A public failure requests `rollback` and fails the workflow.

Operator commands use the existing maintenance account rather than the Actions
key:

```bash
ssh kojakurtki-vps 'sudo /usr/local/sbin/topskip-deploy status'
ssh kojakurtki-vps 'sudo /usr/local/sbin/topskip-deploy rollback'
ssh kojakurtki-vps 'docker logs --tail 200 topskip-backend'
```

If deployment assets themselves change, install the reviewed new assets with
`install-vps-assets.sh` before deploying an image that depends on them. Ordinary
application releases require only the Actions workflow.

## Operations

Back up application secrets and deployment configuration separately. The
analysis cache is disposable and has no off-site backup requirement. Do not
copy transcripts or raw model output into tickets or chat.

Inspect storage and health:

```bash
ssh kojakurtki-vps 'docker volume inspect topskip-data'
ssh kojakurtki-vps 'docker exec topskip-backend node -e \
  "fetch(\"http://127.0.0.1:8787/v1/health\").then(r => r.text()).then(console.log)"'
```

### SQLite retention and pruning

The backend runs bounded housekeeping at most once every five minutes on state
traffic. It removes expired 30-day artifacts and failure events, caps artifacts
at 10,000 rows, prunes more aggressively below 512 MiB free space, checkpoints
WAL, and runs incremental vacuum. Inspect counts only; do not print
`payload_json`, because it contains retained transcripts and model output:

```bash
ssh kojakurtki-vps 'docker exec topskip-backend node -e '\''
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/var/lib/topskip/topskip.sqlite", { readOnly: true });
  for (const table of ["analysis_artifacts", "analysis_failures", "installations"]) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    console.log(table, row.count);
  }
  db.close();
'\'''
ssh kojakurtki-vps 'docker exec topskip-backend df -h /var/lib/topskip'
```

If disk pressure remains after automatic pruning, delete only the disposable
artifact cache while preserving installations, quotas, budgets, and support
events. The transaction and WAL checkpoint are safe with the single backend
replica:

```bash
ssh kojakurtki-vps 'docker exec topskip-backend node -e '\''
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/var/lib/topskip/topskip.sqlite");
  db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; DELETE FROM analysis_artifacts; COMMIT; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum;");
  db.close();
'\'''
```

Do not delete the whole volume as routine pruning: that also resets anonymous
installations and protection/budget state. A lost installation row is
recoverable because the extension performs one bounded re-registration after
`token_invalid`.

Rotate an application secret by editing `/opt/topskip/production.env` with
`sudoedit`, then redeploy the current immutable digest. Rotate the Actions key by
installing a new restricted public key first, replacing the GitHub environment
secret, testing `status`, and only then removing the old key.

### YouTube anonymous challenges

`caption_extraction_failed` can mean YouTube rejected anonymous metadata access
from the VPS IP even though the same public video works from a residential
browser. Production logs intentionally retain only the stable failure code; do
not add yt-dlp stderr, cookies, signed URLs, or exported browser state to logs or
support events. Confirm the category with a one-off operator probe that deletes
its temporary stderr immediately after classifying it.

The yt-dlp project recommends a different egress IP as the safer response when
an anonymous IP is blocked; account cookies may themselves be blocked and put
the account at risk. Proxy, cookie, and PO-token operation are not part of the
current TopSkip production design. See the
[yt-dlp known-issues guidance](https://github.com/yt-dlp/yt-dlp/issues/3766).

To update yt-dlp, run `make yt-dlp-refresh-pin`, review the tag and SHA-256
changes, run CI, and deploy a newly built image. Never run `yt-dlp -U` inside the
production container.
