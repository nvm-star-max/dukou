# Dukou

[English](README.md) · [简体中文](README.zh-CN.md) · [Security policy](SECURITY.md)

Dukou (渡口) is an experimental, MIT-licensed file transfer tool for Windows, macOS, and Linux. It requires Node.js 22 or newer; use a still-supported LTS release. The interface defaults to English and can be switched to Chinese with the top-right `中文` button; the choice is stored in the current browser.

There are two ways to run it:

- **Peer transfer**: every participating device runs a client and generates its own device key under the same account. Both ends can authorize the other to search and pull, and can also push. Across the internet a lightweight discovery/relay service is needed; file contents are encrypted end to end between devices, and the relay does not store plaintext.
- **Lightweight browser sharing**: a host runs on one computer and other devices log in with a browser to pull and manually upload. A browser visitor cannot let others search its full filesystem, so this is not the same as peer mode.

## Peer transfer

The recommended way to start is the unified CLI. First install Node.js 22+ on every machine and run `npm ci` in the project directory. Run each long-lived service in its own terminal or service manager:

```sh
node src/cli.mjs doctor
node src/cli.mjs relay --host 127.0.0.1 --port 8787 --data .data/server
node src/cli.mjs peer --port 8788 --peer-port 8789 --data .data/my-device
```

`relay` is the discovery/encrypted data relay, `peer` is a full peer device, and `direct` is the single-host lightweight browser sharing mode. Run `node src/cli.mjs help` to see all role options. `doctor --url https://your-relay-domain` checks Node, common local ports, and the relay health endpoint. `npm run cli -- peer ...` also works. Windows PowerShell, macOS, and Linux use the same `node src/cli.mjs` commands without shell environment-variable syntax. Use a **separate data directory per peer** and never copy a device private key.

CLI help and diagnostics default to English; `node src/cli.mjs help --lang zh` switches them to Chinese. A server running `relay` does not need a graphical desktop, so it can be started by the system service manager with a dedicated persistent directory and a low-privilege system account. A full `peer` still needs a local browser for first-time setup; this release has no fully headless device enrollment command, native installer package, or background-service auto-installer. Do not pass passwords or keys as command-line arguments.

When deploying a lightweight host behind a public reverse proxy, you can use `node src/cli.mjs direct --http 1 --trust-proxy 1`, but the HTTP backend may only listen on the local loopback address and must not be exposed directly to the internet; use `--trust-proxy 1` only behind a trusted local proxy.

Run the discovery/relay service on one reachable computer (it can share a machine with a client):

```sh
npm ci
HOST=127.0.0.1 npm run server
```

Run `npm run client` on each Windows, macOS, or Linux computer and open its own `http://127.0.0.1:8788`. Create the account on the first device; other devices can use the same account and password, or a signed-in device can generate a single-use enrollment key valid for ten minutes in Settings. Every device generates its own Ed25519/X25519 keys and later authenticates with its device key; **do not copy the same private key to multiple devices, and do not treat the direct mode long-term access key as an enrollment key**. Each device needs its own state; the same local directory name can be used on different computers, but never clone an already configured device's data directory. In Windows PowerShell, set environment variables with `$env:CLIENT_PORT="8788"` syntax.

On each end, select a shared folder in the local Settings and enable **Browse** and **Download** for the other side; an end that should receive an active push must also enable **Allow pushes**. All three permissions default to off. Either end can then search the other's authorized directories and pull, or pick a file to push, with the other side confirming each item. Completed downloads offer **Show in folder**. Testing verified both A-pulls-B and B-pulls-A directions.

For use across networks, deploy the discovery/relay service to a machine with a publicly reachable address. The repository's `compose.yaml` and `Caddyfile` provide an HTTPS entry point; the client enters that HTTPS domain. Both ends must be online. The first time you see a new device, verify its fingerprint through another trusted channel; the client pins the first-seen signing and encryption public keys, and later blocks the connection if the keys under the same device ID are replaced. First trust can still be spoofed by a malicious discovery service, so fingerprint verification cannot be skipped.

Peer mode negotiates keys between devices with X25519 and encrypts directories and file chunks with AES-256-GCM, verifying SHA-256 after receipt; the discovery service only forwards ciphertext. Passwords are used only for the initial account join, and a new device can also use a one-time enrollment key. Browse, download, and push permissions are set on the device that provides or receives the files, and a push also requires per-item confirmation by the receiver. Do not give others administrator rights on a public service, device private keys, or unrotated enrollment keys. This demo has not undergone an independent security audit and should not be the only line of defense for sensitive material; encryption cannot compensate if the host is compromised, the first device fingerprint is not verified, or the endpoint itself is infected with malware.

By default data is relayed end to end encrypted; the app does not actively connect to LAN addresses provided by the discovery service, and the inbound peer port listens on loopback only. Set `ENABLE_LAN_DIRECT=1` to allow LAN direct connections only when you fully trust the same-account/paired devices and the discovery service. The receiver rejects duplicate ciphertext within a bounded time window; the ten-minute pairing code and enrollment key use the **discovery service's clock** to decide expiry, not the devices' clocks. Exposed account passwords or access keys should be rotated immediately; the same account password can register a new device, so do not treat it as a read-only access credential.

This release adds limits on jobs and message queues, automatic expiry of pending tasks, canonical ciphertext encoding, rechecking current sharing permissions for old tasks, serialized receive writes, and invalidation of sessions/enrollment keys after device revocation. See [SECURITY.md](SECURITY.md) for the exact limits and remaining risks. These measures cannot replace an independent audit, a firewall, disk quotas, or endpoint security.

Android has no standalone APK for this project. For a Xiaomi phone to become a full peer that can be searched and pulled from, it needs a resident client and user-granted file access permission; logging in with a browser alone cannot do this. As a technical experiment you can install Node.js in Termux on Android, run the project's `peer` client, and open `http://127.0.0.1:8788` in the phone browser. Run `termux-setup-storage` first to grant shared-storage permission, then choose "shared storage" in the app's local file browser. The phone must be able to reach a discovery service using a trusted CA certificate, and neither the Termux process nor the phone may be put to sleep. This path has not been tested on Xiaomi devices and is not equivalent to a finished app.

## Lightweight browser sharing

Install Node.js 22+ on the computer that will provide files, then run in this directory:

```sh
npm ci
npm start
```

On the host computer, open the **local administration address** printed in the terminal, by default `http://127.0.0.1:18789`, and create a host password of at least 12 characters. That HTTP entry listens on the local loopback address only and is not exposed to the LAN or the internet, so the local browser is not blocked by a self-signed certificate. Another computer logs in through the HTTPS LAN address printed in the terminal; the self-signed certificate may be blocked by the browser, so a trusted CA certificate should be used for real use. The host also prints the certificate SHA-256 fingerprint, which must be verified through a trusted channel before manually accepting a self-signed certificate.

Windows PowerShell runs the same `npm ci` and `npm start`. Keep the host running and allow inbound TCP 18788 through the system firewall; the local administration port should not be exposed. Use `DIRECT_PORT` to change the HTTPS port and `DIRECT_LOCAL_PORT` to change the local administration port. Host settings can only be changed from the host's own `localhost` page.

By default only files or folders explicitly added by the administrator are shared, and remote push is off by default. The host can add public locations with the in-app file browser on the local administration page; without a graphical desktop you can still choose through the browser or type an absolute path. The file browsing API is not available to remote accounts or key sessions. The host can also enable a separate upload inbox and set a per-file limit. Remote uploads do not overwrite public files. Whole-device read-only mode requires checking a confirmation box and typing `OPEN ALL`; it exposes system files the host process can read, personal data, and other programs' secrets, and is only for fully trusted scenarios. The app's own data directory is always excluded, but this **cannot** protect other applications' data. Use a dedicated low-privilege system account to run the host, not an administrator/root account.

Files pulled in direct mode are saved by the visitor's browser. After downloading, the browser's download record offers "Show in folder"; the web page itself cannot open the visitor computer's download directory beyond browser permissions. Files in the host inbox can use "Show in folder" on the local administration page. Full peer mode also provides a real **Show in folder** button.

## Cross-network access

In **direct browser mode**, "no central service" does not mean NAT can be bypassed: the host must have an address reachable from the other computer. You can use the host's public IP with router port mapping, or your own domain/tunnel. This mode provides no automatic NAT traversal or built-in cloud relay. Mobile networks or different carriers usually cannot connect directly by LAN address alone. **Full peer mode** instead uses your reachable discovery/relay service to forward encrypted messages across networks.

For public use, prefer a domain with a trusted CA HTTPS certificate, with TLS handled by Caddy on the same host. Point the domain's A/AAAA records at the host's public IP, open ports 80/443, use the repository's `Caddyfile.direct` as the Caddy configuration, then run the app on the loopback address only:

```sh
DIRECT_HTTP=1 DIRECT_TRUST_PROXY=1 npm start
caddy run --config Caddyfile.direct
```

Change the domain in `Caddyfile.direct` to your own. In Windows PowerShell set `$env:DIRECT_HTTP="1"` and `$env:DIRECT_TRUST_PROXY="1"`, then run `npm start`. Do not expose this HTTP backend directly to the internet, and do not let an untrusted reverse proxy connect to it. If you use a third-party tunnel, make sure it only forwards to the loopback port, preserves the original HTTPS Host, and overrides `X-Forwarded-For` with the real visitor IP. The app trusts that header only when `DIRECT_TRUST_PROXY=1` is explicitly enabled and the proxy connects from a loopback address. For public use, disable whole-device mode, share only the minimum necessary directories, and enable uploads only as needed.

Built-in public protections include scrypt password hashing, hashed storage of 256-bit random access keys, login rate limiting, 12-hour HttpOnly/SameSite sessions, same-origin write validation, rotatable keys, host-local-only administration, path traversal and out-of-share symlink blocking, read-only pulls, a per-file upload limit, and an activity log. Rotating an access key immediately revokes all key-based sessions. Account/password sessions are not revoked by key rotation; if you suspect the host password is leaked, stop the service and reinitialize the dedicated data directory, or first restrict the public entry point.

This is a small-scale demo for verification, not an independently audited public file service. There is no end-to-end encryption in direct mode: HTTPS protects transport, and the host can always see the files. Activity logs and uploaded content live on the host disk; manage disk space, backups, and the operating-system firewall yourself. For a public entry point, add a firewall allowlist or VPN.

## Two peer devices on one computer

To simulate two peers on the same computer, give them different ports and data directories:

```sh
HOST=127.0.0.1 npm run server
CLIENT_PORT=8788 PEER_PORT=8789 TRANSFER_CLIENT_DATA=.data/client-a npm run client
CLIENT_PORT=8790 PEER_PORT=8791 TRANSFER_CLIENT_DATA=.data/client-b npm run client
```

Configure the same account at `http://127.0.0.1:8788` and `http://127.0.0.1:8790` with the server address `http://127.0.0.1:8787`. These two clients are peers, and their data directories and access keys are independent of the single-host browser sharing mode.

## Development and verification

```sh
npm test
```

CI is configured to check Windows, macOS, and Linux × Node.js 22/24; see [GitHub Actions](https://github.com/nvm-star-max/dukou/actions) for actual results. This does not mean native pickers, desktop file managers, real Android devices, firewall configuration, or real cross-network speeds have been verified. All protocol regression inputs run in a temporary local test environment and do not scan third-party systems.

Code comments and default documentation use English. Chinese localization remains supported. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution conventions.
