# Security policy

Dukou is an experimental demo, not an audited file service. Use a low-privilege OS account, share only necessary folders, and keep backups. Do not use it as the sole protection for sensitive files.

## Boundaries

- Peer mode encrypts message contents between device keys. The relay sees account/device metadata, connection timing, ciphertext sizes, and online status, but should not see file contents. Verify device fingerprints out of band before trusting a new peer. If an account password is stolen, an attacker may enroll a new device.
- Pairing codes and one-time enrollment keys expire after ten minutes according to **relay time**. Device clock skew does not extend them. The receiver keeps a bounded replay window for encrypted messages; it is not a durable replay log across restarts.
- Peer UI and local file browsing listen on loopback only. The inbound peer endpoint also listens on loopback unless LAN direct delivery is explicitly enabled. `ENABLE_LAN_DIRECT=1` permits connections to peer-advertised LAN endpoints and increases exposure if a paired device or relay is malicious.
- Direct browser mode uses HTTPS for transport, not end-to-end encryption. The host can see file content. Public visitors cannot use the local-only admin API. Whole-device sharing can expose other applications' credentials and should be avoided on public networks.
- The generated self-signed direct-mode certificate is for testing. Public deployment needs a trusted certificate or a trusted HTTPS reverse proxy. Never expose `DIRECT_HTTP=1` directly to a network.

## Protective controls and limits

- Peer transfers use authenticated encryption, canonical nonce/tag encoding, fixed-format identifiers, confined temporary paths, chunk integrity checks, and serialized receive state. Stored source files are rechecked against current sharing/download permission before reoffering or resuming a pull. Completed/rejected pull jobs cannot be reused to bypass current access rules.
- Each peer admits at most 64 active jobs globally and 16 per remote device, retains about 500 terminal job records, and expires unapproved incoming offers after one hour. History pruning deletes metadata, **not downloaded files**. Metadata requests are limited to 120 per remote device per minute; receive queues hold at most 64 operations. A staged browser push is capped at 1 GiB. These bounds do not provide a disk quota: approved pulls and accumulated downloads can still exhaust disk space.
- Relay WebSocket sessions close when their server-side session expires or their device is revoked. Revocation also invalidates enrollment keys and outstanding pairing/challenge state issued by that device. Already received files cannot be revoked. Permission changes are not a secure erasure mechanism and cannot recall bytes already delivered or in flight.
- Local management uses Host/Origin checks, cross-site request rejection, anti-framing headers, and private-data exclusions. Direct-mode TLS private keys configured outside the data directory are also excluded. This does **not** protect other applications' secrets in a whole-device share.
- Repository and Docker context exclusions keep standard local data, environment files, logs, and PEM files out of publication/build contexts. Custom data paths or custom secret filenames still require manual review. On Windows, use OS ACLs to protect data; POSIX file modes are not a substitute for Windows permissions.

## Remaining risks

There is no forward secrecy, durable replay database, automatic NAT traversal, malware scanning, guaranteed delivery, or global storage quota. Encryption cannot protect a compromised endpoint or an unchecked first device fingerprint. Discovery/account metadata remains visible to the relay. Public authentication and relay workloads may still require upstream resource limits. A local process with the same OS privileges can read device state or influence files; use OS isolation and a dedicated account.

Use a supported Node.js LTS runtime (22 or newer), keep dependencies patched, and prefer a VPN or firewall allowlist plus minimal shares for internet use. Public deployments require trusted TLS; clock skew is handled for enrollment expiry by relay time, not by ignoring certificate validity.

Rotate an access key if it has been shared in chat, logs, screenshots, or elsewhere. Do not commit `.data`, `.env`, device private keys, passwords, access keys, or download contents. The repository ignores these local paths, but review `git status` before every push.

For a suspected vulnerability, use GitHub private vulnerability reporting if available. Do not include working credentials, personal files, or private keys in a public issue.
