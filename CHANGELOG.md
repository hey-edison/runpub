# Changelog

## 0.6.1 - 2026-08-21

- Reframe the README around the original remote AI development problem: opening
  a coding agent's local changes from a phone or another device.
- Add outcome-first use cases, an honest one-off-tunnel comparison, automation
  boundaries, and direct answers for mobile previews, full-stack apps, webhooks,
  stable URLs, Cloudflare accounts, and public access.
- Improve npm and GitHub discovery metadata for localhost tunnels, remote
  development, mobile testing, and AI coding-agent workflows.

## 0.6.0 - 2026-08-21

- Rename the product, npm package, CLI, repository, project manifest, and
  environment variables to RunPub, `runpub`, `runpub.json`, and `RUNPUB_*`.
- Keep `runpublic.dev` as the hosted domain, preserving every existing public
  frontend, backend, and webhook URL.
- Retain compatibility aliases for the former command, manifest, credentials,
  environment variables, agent instructions, process state, and edge protocol.

## 0.5.0 - 2026-08-21

- Add an explicit first-run opt-in that makes RunPub the default launcher
  when AI coding agents start interactive development servers or previews.
- Install idempotent, managed global instructions for Codex/ChatGPT coding
  agents, Claude Code, and Antigravity, plus a project-level Cursor rule.
- Add `--agents` and `--no-agents` for non-interactive setup.
- Add `runpub agents install|status|remove` so existing projects can manage
  the integration without rerunning service detection.
- Preserve existing instruction-file content and refuse malformed or duplicate
  managed blocks instead of risking an overwrite.

## 0.4.0 - 2026-08-21

- Discover development services in unconventional top-level application
  folders as well as conventional monorepo layouts.
- Add an interactive first-run selector when multiple plausible services are
  detected, then assign clean frontend/backend aliases from the selection.
- Add `--services <folders>` and `--yes` for coding agents and CI environments
  that cannot answer an interactive prompt.
- Add `runpub setup` for reconfiguration while preserving custom settings
  for reselected services.

## 0.3.0 - 2026-08-21

- Make bare `runpub` auto-detect, configure, start, and expose a project.
- Add direct service aliases, `all`, numeric-port shorthand, `status`, and
  cross-terminal `stop`.
- Detect common Node.js, Python, workspace, and conventional monorepo layouts.
- Add per-service working directories and interpolated environment mappings.
- Inject deterministic `RUNPUB_URL` and cross-service public URL variables.

## 0.2.0 - 2026-08-21

- Add a horizontally scalable Cloudflare Worker and Durable Object edge.
- Persist accounts, hashed revocable tokens, service reservations, quotas, and
  audit events in D1.
- Add streaming HTTP protocol v2 with bounded chunks while retaining Node-edge
  protocol compatibility.
- Add tunnel heartbeats, reconnect jitter, login credential verification,
  limits, security headers, and operator administration commands.
- Add self-service GitHub device login, identity-backed namespace ownership,
  and a Cloudflare-hosted apex landing page.
- Preserve origin response encodings through Cloudflare without double
  compression, including mobile Safari responses from Next.js.
- Add production, architecture, security, contribution, CI, and launch docs.

## 0.1.0 - 2026-08-21

- Initial Node/Railway edge, global CLI, deterministic hostnames, project
  manifests, HTTP forwarding, and WebSocket forwarding.
