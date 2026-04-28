# Deploying the Backblaze Neocloud Demo on EC2

## TL;DR

Build the React app to static files, serve via **nginx**, and let nginx do the same `/b2-*` reverse-proxying that `vite.config.js` does in dev. That removes the CORS wall and makes Live mode work end-to-end without leaving anything node-y running.

---

## 1. Launch the instance

| Setting | Value |
| --- | --- |
| AMI | Amazon Linux 2023 (x86 or arm64) |
| Type | `t3.micro` (x86) or `t4g.small` (arm64) — both fine, ~$5–8/mo |
| Storage | 8 GB gp3 is plenty |
| Security group | inbound TCP 22 (your IP), 80 (anywhere), 443 (anywhere) |
| Elastic IP | allocate + associate so the address survives reboots |

> **Ubuntu 22.04 alternative**: works the same, just swap `dnf` → `apt` and the nginx config path is `/etc/nginx/sites-available/`.

---

## 2. SSH in and install prerequisites

```bash
ssh -i ~/.ssh/your-key.pem ec2-user@<elastic-ip>

sudo dnf update -y
sudo dnf install -y nginx unzip
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
node -v   # should print v20.x
```

---

## 3. Drop the code on the box

Pick whichever you prefer:

```bash
# Option A — scp a zip from your laptop
scp -i ~/.ssh/your-key.pem backblaze-neocloud-demo.zip ec2-user@<ip>:~
ssh ec2-user@<ip>
sudo mkdir -p /var/www && sudo chown ec2-user:ec2-user /var/www
unzip ~/backblaze-neocloud-demo.zip -d /var/www/

# Option B — git clone (if you've pushed the project up)
sudo mkdir -p /var/www && sudo chown ec2-user:ec2-user /var/www
cd /var/www
git clone <your-repo-url> backblaze-neocloud-demo
```

Build it:

```bash
cd /var/www/backblaze-neocloud-demo
npm ci
npm run build
```

That writes a static bundle to `/var/www/backblaze-neocloud-demo/dist/`.

---

## 4. nginx config (replaces the vite dev proxy)

Create `/etc/nginx/conf.d/neocloud.conf`:

```nginx
server {
  listen 80 default_server;
  server_name _;

  root /var/www/backblaze-neocloud-demo/dist;
  index index.html;

  # Single-page app fallback
  location / {
    try_files $uri $uri/ /index.html;
  }

  # Long-cache hashed assets
  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }

  # ===== B2 Native API reverse proxies =====
  # Auth bootstrap (region-agnostic)
  location /b2-proxy/ {
    proxy_pass         https://api.backblazeb2.com/;
    proxy_set_header   Host api.backblazeb2.com;
    proxy_ssl_server_name on;
  }

  # Region-specific API hosts
  location /b2-api005/ { proxy_pass https://api005.backblazeb2.com/; proxy_set_header Host api005.backblazeb2.com; proxy_ssl_server_name on; }
  location /b2-api004/ { proxy_pass https://api004.backblazeb2.com/; proxy_set_header Host api004.backblazeb2.com; proxy_ssl_server_name on; }
  location /b2-api003/ { proxy_pass https://api003.backblazeb2.com/; proxy_set_header Host api003.backblazeb2.com; proxy_ssl_server_name on; }
  location /b2-api006/ { proxy_pass https://api006.backblazeb2.com/; proxy_set_header Host api006.backblazeb2.com; proxy_ssl_server_name on; }

  # Region-specific download hosts (for b2_download_file_by_*)
  location /b2-f005/ { proxy_pass https://f005.backblazeb2.com/; proxy_set_header Host f005.backblazeb2.com; proxy_ssl_server_name on; }
  location /b2-f004/ { proxy_pass https://f004.backblazeb2.com/; proxy_set_header Host f004.backblazeb2.com; proxy_ssl_server_name on; }
  location /b2-f003/ { proxy_pass https://f003.backblazeb2.com/; proxy_set_header Host f003.backblazeb2.com; proxy_ssl_server_name on; }
  location /b2-f006/ { proxy_pass https://f006.backblazeb2.com/; proxy_set_header Host f006.backblazeb2.com; proxy_ssl_server_name on; }

  # Partner API
  location /b2-partner/ {
    proxy_pass         https://api123.backblazeb2.com/;
    proxy_set_header   Host api123.backblazeb2.com;
    proxy_ssl_server_name on;
  }
}
```

> SELinux on Amazon Linux 2023 sometimes blocks nginx from making outbound HTTP. If `nginx -t` is fine but proxied calls 502, run:
> `sudo setsebool -P httpd_can_network_connect 1`

Validate + start:

```bash
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

Open `http://<your-ec2-ip>/` in a browser. You should see the dashboard.

---

## 5. Switch the app into Live mode

1. Open the deployed site.
2. Click **Settings** in the sidebar.
3. Paste your **Master Key ID** + **Application Key**.
4. **CORS proxy URL** → `http://<your-ec2-ip>/b2-proxy` (no trailing slash).
5. Click **Save & test connection** — you should see `Authorized. Account …`.
6. Click the **Live mode** card to switch.

The adapter rewrites the region-specific `apiUrl` returned by `b2_authorize_account` (e.g. `https://api005.backblazeb2.com`) onto the matching `/b2-api005` path on the same origin, so every subsequent call (`b2_list_buckets`, `b2_list_keys`, etc.) also flows through nginx — you don't have to touch anything else.

---

## 6. (Recommended) HTTPS with a real domain

```bash
# Point demo.yourdomain.com → <elastic-ip> first (A record)
sudo dnf install -y certbot python3-certbot-nginx
sudo certbot --nginx -d demo.yourdomain.com
```

Certbot rewrites the nginx server block to listen on 443 and adds an http→https redirect. Renewal runs from a systemd timer automatically.

After issuing the cert, update the **CORS proxy URL** in Settings to `https://demo.yourdomain.com/b2-proxy`.

---

## 7. Lock the demo down

This setup still has a master key sitting in browser localStorage. Even on your own EC2 you almost certainly want one of these:

**Basic auth (10 seconds):**
```bash
sudo dnf install -y httpd-tools
sudo htpasswd -c /etc/nginx/.htpasswd kevin
```
In the nginx `server { ... }` block, add:
```nginx
auth_basic           "Backblaze Neocloud Demo";
auth_basic_user_file /etc/nginx/.htpasswd;
```
`sudo systemctl reload nginx`.

**IP allowlist:** in the security group, restrict port 80/443 to your office IP range.

**Cognito / OIDC in front of nginx:** if this is going to live longer than a week, put it behind an ALB with Cognito auth and remove the public listener entirely.

---

## 8. Updating the deployed app

```bash
cd /var/www/backblaze-neocloud-demo
git pull          # or scp + unzip
npm ci
npm run build
# nginx serves files directly from dist/, no reload needed,
# but reload anyway if you changed neocloud.conf:
sudo systemctl reload nginx
```

---

## Caveats — read before you demo this to a customer

- The master key still lives in the browser. Anyone who can get to the dashboard can pull it out of localStorage. Treat this as an internal/eng-only tool.
- For a real reseller portal, move all B2 calls behind a backend (Node/Go) that holds the master key in AWS Secrets Manager and issues per-customer scoped keys via `b2_create_key`.
- The Bucket Access Logs reader uses a bundled sample log in demo mode. The live-mode path (`getBucketActivity`, `getBucketLogging`, `setBucketLogging`) throws today — wire those up to your destination bucket when you're ready.
- t3.micro/t4g.small can serve the SPA + proxy ~hundreds of req/s easily; if a customer is going to load real Daily Usage CSVs through this, bump to `t3.small` or move CSV parsing server-side.

---

## Cost sketch

| Item | Monthly |
| --- | --- |
| t4g.small on-demand | ~$12 |
| 8 GB gp3 | ~$0.80 |
| Elastic IP (attached) | $0 |
| Outbound to Backblaze (auth + API JSON only) | < $1 |
| **Total** | **~$13/mo** |

Cheaper if you reserve or run on Savings Plans, ~$8/mo.
