# RunPublic

RunPublic gives local frontends, APIs, and webhook handlers stable public HTTPS
URLs from one global CLI.

```text
https://fullstack-demo-frontend-keshavmac.runpublic.dev
https://fullstack-demo-backend-keshavmac.runpublic.dev
```

The developer runs one command. RunPublic opens an authenticated outbound
tunnel, so no router configuration, inbound firewall rule, TLS certificate, or
developer-owned Cloudflare account is required.

> **Public beta:** a RunPublic URL exposes a process on your computer to the
> Internet. Never expose a database, admin port, secrets dashboard, or service
> containing sensitive data without appropriate application authentication.

## Install and use

RunPublic requires Node.js 20 or newer. Install the CLI globally:

```bash
npm install --global runpublic
```

During source development, clone this repository and run `npm install -g .`.
Sign in once with GitHub. The device flow asks only for your public GitHub
identity and creates a unique RunPublic namespace automatically:

```bash
runpublic login
```

Pass `--account your-name` on the first login when you want a specific available
namespace; otherwise RunPublic starts from your GitHub username.

Then enter a project and run one command:

```bash
runpublic
```

On the first run, the CLI detects common Node.js and Python development
services, writes `runpublic.json`, starts them, and prints their stable HTTPS
URLs. Later runs reuse that file. Framework hot reload keeps working, so saving
source code does not require restarting RunPublic. Interactive setup also asks
whether AI coding agents should use RunPublic for explicitly requested mobile,
remote, public-URL, and webhook testing. The default is no.

If a repository contains several possible applications, RunPublic asks once
instead of guessing:

```text
RunPublic found several development services:

  1. backend — FastAPI backend — python3 -m uvicorn ... — port 8000
  2. careers-web — Node.js frontend — npm run dev — port 3000
  3. edison-web — Node.js frontend — npm run dev — port 3000

Select the services to expose (comma-separated numbers, or "all"): 1,3
Selected 2 services for ai-native-ats.
Detected backend: FastAPI backend in backend (port 8000)
Detected frontend: Node.js frontend in edison-web (port 3000)
```

When one frontend and one backend are selected, their service names become the
simple `frontend` and `backend` aliases. Selecting multiple services with the
same role uses their folder names so every URL remains unambiguous.

Coding agents and CI can make the same choice without an interactive prompt:

```bash
runpublic --services edison-web,backend --json
runpublic --yes --json  # deliberately select every detected service
runpublic --services edison-web,backend --agents --json
```

Use `--no-agents` to explicitly skip the agent integration in an automated
setup. Non-interactive and `--json` setup never changes agent instructions
unless `--agents` is present.

Natural shortcuts cover the common cases:

```bash
runpublic frontend       # start one configured service
runpublic backend
runpublic all            # start every configured service
runpublic 3000           # expose an already-running port
runpublic status         # show public, local-only, and stopped services
runpublic stop           # stop this project's managed RunPublic sessions
runpublic setup          # reopen detection and replace the saved selection
runpublic agents status  # inspect AI-agent integration
```

`runpublic setup` preserves custom commands, ports, and environment mappings
for services selected again by the same name or folder.

The original explicit forms, such as `runpublic run frontend` and `runpublic
expose 3000 --project demo --service frontend`, remain supported for scripts.

## AI coding agents

When the developer opts in, RunPublic adds a small managed instruction block
to the supported global instruction files:

```text
~/.codex/AGENTS.md       Codex and the ChatGPT coding agent
~/.claude/CLAUDE.md      Claude Code
~/.gemini/GEMINI.md      Antigravity
```

If Codex already uses `AGENTS.override.md`, RunPublic updates that active file
instead. Cursor stores its supported global User Rules in the application
settings rather than a Markdown file, so RunPublic creates the supported
project rule `.cursor/rules/runpublic.mdc` in each opted-in project.

The instructions tell agents to activate RunPublic only for an explicit public
URL, mobile/remote test, webhook, or on-the-go development request. Agents
check status first, reuse live tunnels, select one service or the complete
stack, keep the process alive, return the URL, and avoid exposing databases,
admin/debug ports, secret dashboards, or unauthenticated sensitive services.

The installer preserves all existing text and owns only content between
`<!-- runpublic:managed:start -->` and `<!-- runpublic:managed:end -->`. It is
safe to run repeatedly. Existing projects can manage the integration directly:

```bash
runpublic agents install
runpublic agents status
runpublic agents remove
```

The CLI verifies the issued RunPublic token before storing it in
`~/.config/runpublic/config.json` with private file permissions. For private or
self-hosted installations, operator-issued token login remains available with
`runpublic login --server ... --account ... --token-file ...`.

Expose an already-running backend:

```bash
runpublic expose 8000 --project edison-sourcing --service backend
```

Or commit a `runpublic.json` so one command starts and exposes a whole project:

```json
{
  "$schema": "./node_modules/runpublic/runpublic.schema.json",
  "project": "ai-native-ats",
  "services": {
    "frontend": {
      "command": "npm run dev",
      "port": 3000,
      "cwd": "edison-web",
      "env": {
        "NEXT_PUBLIC_API_BASE": "${RUNPUBLIC_BACKEND_URL}/api/v1"
      }
    },
    "backend": {
      "command": ".venv/bin/python -m uvicorn app.main:app --reload --port 8000",
      "port": 8000,
      "cwd": "backend"
    }
  }
}
```

```bash
runpublic
runpublic frontend
```

This also works in npm scripts and with coding agents:

```json
{
  "scripts": {
    "public": "runpublic"
  }
}
```

The URL format is deterministic:

```text
{project}-{service}-{account}.runpublic.dev
```

Long names receive a stable 128-bit hash suffix and remain within DNS limits.
The hosted edge permanently reserves the full account/project/service tuple and
hostname in its database.

Every started process receives `RUNPUBLIC_URL` for its own public URL and one
variable per configured service, such as `RUNPUBLIC_FRONTEND_URL` and
`RUNPUBLIC_BACKEND_URL`. The optional service `env` mapping expands these
variables before launching the command, which lets a frontend point to its
public development API without embedding an account-specific hostname.

Auto-detection currently understands npm, pnpm, Yarn, and Bun projects using
common development scripts; Vite, Next.js, React, Vue, Svelte, Angular, Nuxt,
Astro, Gatsby, Express, NestJS, Fastify, Django, FastAPI, and Flask conventions;
and conventional `frontend`/`backend`, `apps/*`, `packages/*`, and package
manager workspace layouts. It also scans top-level application folders and
asks the user to resolve ambiguous choices. Unusual repositories can run
`runpublic init` and edit the small generated file once.

## How it works

```text
public HTTPS request or WebSocket
            -> Cloudflare Worker
            -> one Durable Object for that exact hostname
            -> authenticated tunnel opened by the CLI
            -> localhost frontend or backend
```

Cloudflare D1 stores GitHub identity IDs, accounts, token hashes, quotas, service
reservations, and audit events. The short-lived GitHub device access token is
used only to verify identity and is not stored. A Durable Object gives one
globally consistent active tunnel owner per hostname and can hibernate while the
WebSocket stays connected. HTTP bodies use a bounded chunked protocol rather
than one large base64 allocation.

The operator owns `runpublic.dev`, Cloudflare, D1, and the hosted edge. End
users only install the CLI. Read [the architecture](docs/ARCHITECTURE.md) for
the data model, routing, security boundaries, and scale considerations.

## Local development

Install dependencies and start the Node edge:

```bash
npm install
RUNPUBLIC_DOMAIN=runpublic.test \
RUNPUBLIC_TOKENS_JSON='{"keshavmac":"local-secret"}' \
RUNPUBLIC_PUBLIC_SCHEME=http \
RUNPUBLIC_PUBLIC_PORT=8080 \
npm run start:edge
```

In another terminal:

```bash
runpublic login \
  --server http://localhost:8080 \
  --account keshavmac \
  --token local-secret
cd examples/fullstack
runpublic
```

The `.test` domain does not resolve publicly. Exercise the route with an
explicit host header:

```bash
curl -H 'Host: fullstack-demo-backend-keshavmac.runpublic.test' \
  http://127.0.0.1:8080/api/hello
```

The repository also contains a local Cloudflare Worker/D1 development path:

```bash
cp cloudflare/.dev.vars.example cloudflare/.dev.vars
npm run cloudflare:migrate:local
npm run cloudflare:dev
```

## Operator deployment

The production edge is the Worker/Durable Object implementation under
`cloudflare/`. Follow the [production runbook](docs/PRODUCTION.md) to create
D1, apply migrations, store the admin secret, deploy, onboard accounts, monitor,
and roll back.

The Node edge in `src/edge-server.js`, Dockerfile, Railway config, and Docker
Compose config remains available for private self-hosting and as a single-replica
fallback. It must not be horizontally scaled because active sockets are stored
inside that process.

## Reliability and security behavior

- Token login is verified server-side; production stores only token hashes.
- GitHub device login requests no repository scope and never stores the GitHub
  access token.
- A newer connection for the same service replaces the older connection.
- The CLI uses heartbeat detection and jittered automatic reconnects.
- HTTP and WebSocket traffic have body/message, concurrency, rate, and timeout
  limits.
- Hop-by-hop headers are removed and forwarding headers are regenerated.
- The public URL works only while the local service, CLI, network, and computer
  are online.
- Application authentication remains the developer's responsibility; tunnel
  URLs are public by design.

See [SECURITY.md](SECURITY.md) for private reporting and safe-testing rules,
[PRIVACY.md](PRIVACY.md) for data handling, and
[ACCEPTABLE_USE.md](ACCEPTABLE_USE.md) for hosted-service rules.

## Open source and feedback

RunPublic is MIT-licensed. Bugs, focused feature requests, and first-run beta
feedback belong in the provided GitHub issue forms; broader questions and ideas
belong in GitHub Discussions. See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[launch plan](docs/LAUNCH.md).

## Test and package

```bash
npm test
npm run check
```

The suite covers authentication, config permissions, deterministic naming,
HTTP, WebSockets, protocol v2 streaming, and Worker routing helpers.

## License

MIT
