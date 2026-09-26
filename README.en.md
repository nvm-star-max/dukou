# Dukou

[中文说明](README.md) · [Security policy](SECURITY.md)

Dukou is an experimental, open-source file transfer tool for Windows, macOS, and Linux (Node.js 22+; use a supported LTS version). Each `peer` can search and pull files shared by another peer, or push a file for the recipient to approve. Devices have separate Ed25519/X25519 keys. A small `relay` provides discovery and forwards end-to-end encrypted messages when peers are on different networks. A separate `direct` mode lets one computer share files with browser-only visitors; it is **not** a full peer.

## Quick start

```sh
npm ci
node src/cli.mjs relay --host 127.0.0.1 --port 8787 --data .data/server
node src/cli.mjs peer --port 8788 --peer-port 8789 --data .data/device-a
```

Open `http://127.0.0.1:8788` on the peer computer. Create an account on the first peer. On each additional computer, run `peer` with its **own data directory** and join with the same account or a single-use enrollment key. Each peer chooses its own shared folder and grants browse, download, and push permissions separately. The UI defaults to English; use the top-right `中文` button to switch languages.

For a second peer on the same computer, use different ports and data directory:

```sh
node src/cli.mjs peer --port 8790 --peer-port 8791 --data .data/device-b
```

For single-host browser sharing, run `node src/cli.mjs direct`. Open the local administration URL printed in the terminal to set a host password, sharing scope, and upload rules. Visitors log in through the HTTPS URL. This mode does not let browser visitors expose their own files for remote search or pull.

The app's local folder picker works without native desktop dialogs. It is available only to the local administrator, not remote visitors. Downloads in full peer mode have a **Show in folder** button; browser-only downloads use the browser's download manager. Whole-device sharing is an explicit, warned option in direct mode only; it can expose any readable personal files and other apps' credentials.

### Headless servers and CLI

The relay needs no GUI. Run it under your service manager with a persistent, dedicated data directory and a low-privilege OS account. The same commands work in PowerShell, macOS, and Linux:

```sh
node src/cli.mjs help
node src/cli.mjs help --lang zh
node src/cli.mjs doctor
node src/cli.mjs doctor --url https://relay.example.com
node src/cli.mjs direct --http 1 --trust-proxy 1
```

The last command is for a trusted **local** HTTPS reverse proxy only. Never expose its HTTP backend or administration port. Full peers currently require a local browser for initial setup; there is no native installer, background-service installer, or fully headless peer enrollment yet. CLI help and diagnostics default to English; `--lang zh` switches them to Chinese. Credentials are not accepted as CLI arguments.

## Internet deployment

The relay must be reachable through trusted HTTPS; `compose.yaml` and `Caddyfile` are examples. Do not expose the peer UI or direct-mode admin port publicly. Direct mode can use its built-in TLS for testing, but a trusted certificate and restricted network access are recommended for public use. `node src/cli.mjs doctor --url https://relay.example.com` checks the relay health endpoint.

Messages are end-to-end encrypted between peers, but initial key trust depends on checking device fingerprints through another trusted channel. LAN direct delivery is disabled by default; opt in with `ENABLE_LAN_DIRECT=1` only if you trust the paired devices and discovery service. Enrollment and pairing expiry use relay time, not device clocks. **This project has not undergone an independent security audit.** Read [SECURITY.md](SECURITY.md) before exposing it to the internet.

Android has no native APK. Termux with Node.js and storage permission is a possible peer experiment, but has not been verified on a Xiaomi device.

## Verification

Run `npm test` for local integration and protective regression checks. CI runs the suite on Windows, macOS, and Linux with Node.js 22 and 24. CI does not verify Android, native file dialogs, desktop reveal integration, OS firewall setup, or real cross-network performance. See the [workflow results](https://github.com/nvm-star-max/dukou/actions) for actual status.

Transfers have bounded concurrent jobs and metadata queues; see [SECURITY.md](SECURITY.md) for limits, revocation behavior, and remaining risks. Tests are not an independent security audit.
