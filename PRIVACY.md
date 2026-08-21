# RunPub privacy notice

Effective 21 August 2026.

RunPub processes the minimum control-plane data needed to operate a public
developer tunnel.

## Data we process

- GitHub's immutable user ID, username, and display name when you sign in;
- your RunPub account slug, quota, token prefix and token hash;
- project names, service names, reserved hostnames, status, and timestamps;
- security and operational audit events; and
- network and error metadata made available by Cloudflare for reliability and
  abuse prevention.

The GitHub device access token is used transiently to call GitHub's `/user`
endpoint and is not stored. RunPub stores only a one-way hash of its own
long-lived token. The plaintext RunPub token is stored on the developer's
machine with private file permissions.

HTTP bodies and WebSocket messages are forwarded through the active Cloudflare
Worker and Durable Object. RunPub does not intentionally persist tunnel
content. A developer's local application and its own providers may separately
log or store requests.

## Use, sharing, and retention

Data is used to authenticate accounts, reserve unique names, route tunnels,
apply quotas, diagnose failures, and respond to abuse. RunPub does not sell
personal data. Cloudflare processes hosted-edge traffic and storage; GitHub
processes sign-in; GitHub and npm host the open-source project and package under
their own terms.

Account and reservation data is retained while the account is active and as
needed afterward for security, abuse prevention, legal obligations, and
operational recovery. Request account deletion through GitHub's private
vulnerability-reporting channel. Some provider logs and backups expire on the
provider's own retention schedule.

RunPub is a developer service and is not directed to children. This notice
may change as the beta adds features; material changes will be recorded in the
repository.
