# Protected external development access

The development application may be served as `https://dev.ordercornerdeli.com` through Cloudflare Tunnel to `http://127.0.0.1:3000`. Do not use router/NAT port forwarding and never publish PostgreSQL port 5432.

## Application prerequisites

- Keep `APP_URL=http://192.168.1.237:3000` and `COOKIE_SECURE=false` for direct LAN HTTP access, or use a separate HTTPS-only runtime with `APP_URL=https://dev.ordercornerdeli.com` and `COOKIE_SECURE=true`.
- Set `ALLOWED_HOSTS=dev.ordercornerdeli.com,192.168.1.237,localhost,127.0.0.1`.
- The proxy honors forwarded host validation; Cloudflare must preserve `Host`/`X-Forwarded-Host` and send `X-Forwarded-Proto: https`.
- The app emits noindex/nofollow and baseline security headers. The DEVELOPMENT banner remains visible.

## Cloudflare prerequisites

1. Create a named tunnel in the Cloudflare dashboard or with `cloudflared tunnel create`.
2. Add a DNS route for `dev.ordercornerdeli.com` to that tunnel.
3. Configure ingress (credentials stay outside Git):

```yaml
ingress:
  - hostname: dev.ordercornerdeli.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

4. Protect the entire hostname with Cloudflare Access before enabling ingress. Restrict it to explicitly authorized identities and require MFA.

## Verification

- Confirm unauthenticated requests are stopped by Access.
- Confirm authenticated access reaches the DEVELOPMENT banner and sign-in/PIN screens.
- Confirm `X-Robots-Tag: noindex, nofollow, noarchive`, secure cookies on the HTTPS-only configuration, and `/api/health` contains no secrets.
- Confirm `docker inspect corner-ops-postgres` reports no host port bindings.

## Disable / rollback

Disable the tunnel service, remove/disable the DNS route and Access application, then remove the external hostname from `ALLOWED_HOSTS`. Local LAN access continues unchanged.
