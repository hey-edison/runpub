# RunPub — stable public HTTPS URLs for localhost

[![npm version](https://img.shields.io/npm/v/runpub.svg)](https://www.npmjs.com/package/runpub)
[![CI](https://github.com/hey-edison/runpub/actions/workflows/ci.yml/badge.svg)](https://github.com/hey-edison/runpub/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/runpub.svg)](LICENSE)

[npm package](https://www.npmjs.com/package/runpub) ·
[report a bug](https://github.com/hey-edison/runpub/issues/new/choose) ·
[ask a question or share feedback](https://github.com/hey-edison/runpub/discussions)

**Open your local frontend, API, or webhook from your phone, another computer,
an AI coding agent, or any external service—through one stable public HTTPS
URL.**

RunPub is a project-aware development tunnel. It detects and starts local
services, gives each one a predictable URL, connects frontends to backends, and
keeps framework hot reload working through the tunnel. For example, using
illustrative project and account names:

```text
https://sample-app-frontend-alice.runpublic.dev
https://sample-app-backend-alice.runpublic.dev
```

It is built for development previews and testing. It is not a production app
host: the URL works only while RunPub, your local service, network, and computer
are running.

## Why RunPub exists

RunPub started with a real remote-development problem: a coding agent could make
changes on my development computer, but I could not see its local preview from
my phone. Codex or Claude could run the app on `localhost`, but my phone could
not open that computer's `localhost`. I kept finding ports, setting up tunnels,
copying new URLs, reconnecting the frontend to the backend, and repeating the
same setup later.

RunPub turns that recurring work into one command:

```bash
runpub
```

The agent returns a stable URL. Open it on your phone and keep refreshing—or let
the framework's hot reload update it—as the agent edits the local project. The
same URL can be used from your own desktop browser, sent to a teammate, or
entered as a webhook callback.

After the global install, one login, and a project's first-run selection, the
normal development loop is just `runpub`, `runpub frontend`, `runpub backend`,
or `runpub all`.

## When is RunPub useful?

| Use case | What RunPub changes |
| --- | --- |
| Remote AI coding | Codex, Claude Code, Cursor, or Antigravity can start the local app and return a URL you can test from your phone. |
| Mobile and cross-device testing | Open a localhost project on a real phone, tablet, or second computer without joining the same network. |
| Full-stack local development | Start and expose a frontend and backend together, with public service URLs available as environment variables. |
| Webhook and OAuth callback testing | Give GitHub, Stripe, Twilio, or another external service an HTTPS endpoint that reaches your local handler. |
| Temporary sharing | Send a current local preview to a teammate, designer, tester, or client without deploying a preview build. |
| Agent and script automation | Use stable JSON output, deterministic hostnames, and non-interactive service selection in coding-agent or CI workflows. |

## Quick start

RunPub requires Node.js 20 or newer.

```bash
npm install --global runpub
runpub login
cd my-project
runpub
```

Sign in once with GitHub. The device flow requests only your public GitHub
identity and creates a unique RunPub namespace. End users do not need a
Cloudflare account, a domain, a TLS certificate, router configuration, or an
inbound firewall rule.

On the first project run, RunPub detects common Node.js and Python development
services and asks which ones to expose when the choice is ambiguous. It saves
the answer in `runpub.json`; later runs reuse it and print the same URLs.

```text
RunPub found several development services:

  1. backend — FastAPI backend — python3 -m uvicorn ... — port 8000
  2. dashboard — Node.js frontend — npm run dev — port 3000
  3. marketing-site — Node.js frontend — npm run dev — port 3000

Select the services to expose (comma-separated numbers, or "all"): 1,2
Selected 2 services for sample-app.
Detected backend: FastAPI backend in backend (port 8000)
Detected frontend: Node.js frontend in dashboard (port 3000)
```

Interactive onboarding asks once whether supported AI coding agents should use
RunPub by default when they start browser-accessible development servers. The
question normally appears after `runpub login`, is opt-in, and defaults to no.
If the global instructions already exist, future projects inherit that choice
without asking again; RunPub adds only Cursor's project rule where needed.

## What does RunPub automate?

For a conventional repository, RunPub handles the complete recurring workflow:

- detects common frontend, backend, monorepo, package-manager, and Python app
  layouts;
- remembers the selected services, commands, folders, ports, and URL names;
- starts one service or the full stack and opens authenticated outbound tunnels;
- assigns each account/project/service combination the same deterministic HTTPS
  hostname;
- injects each service's public URL so a local frontend can call its public
  backend;
- forwards HTTP and WebSockets, so framework hot reload can keep working; and
- reconnects interrupted tunnels and can teach supported coding agents to check
  status, reuse a running tunnel, and return its URL.

There are three honest boundaries: your computer and RunPub process must stay
online, public URLs need the same application authentication you would require
on any public API, and an unusual repository may need a small manual edit to
`runpub.json` after detection.

> **Public beta:** a RunPub URL exposes a process on your computer to the
> Internet. Never expose a database, admin port, secrets dashboard, or service
> containing sensitive data without appropriate application authentication.

## RunPub versus a one-off tunnel

Tools such as ngrok, Cloudflare Quick Tunnels, and localtunnel are useful for
putting one local port on the Internet. RunPub focuses on the layer above that:
remembering an entire development project and making the workflow natural for
people and coding agents.

| Workflow | RunPub | Typical one-off tunnel command |
| --- | --- | --- |
| Expose an already-running port | Yes | Yes |
| Detect and start project services | Built in | You start and identify them |
| Frontend and backend together | One project command | Usually one tunnel command per port |
| Public URL | Stable `{project}-{service}-{account}` name | Often session-assigned unless separately reserved |
| Frontend-to-backend URL setup | Injected project variables | Configure and copy URLs manually |
| AI coding-agent default | Optional managed instructions | Configure the agent workflow yourself |
| Developer-owned Cloudflare account | Not required | Depends on the provider and setup |

RunPub is not intended to replace the dashboards, traffic inspection, access
policies, or production features offered by general tunnel platforms.

## Project setup and commands

Natural shortcuts cover the common cases:

```bash
runpub                 # detect/setup once, then start configured services
runpub frontend        # start one configured service
runpub backend
runpub all             # start every configured service
runpub 3000            # expose an already-running port
runpub status          # show public, local-only, and stopped services
runpub stop            # stop this project's managed RunPub sessions
runpub setup           # reopen detection and replace the saved selection
runpub agents status   # inspect AI-agent integration
```

When one frontend and one backend are selected, their service names become the
simple `frontend` and `backend` aliases. Multiple services with the same role
use their folder names so every URL remains unambiguous. `runpub setup`
preserves custom commands, ports, and environment mappings for services
selected again by the same name or folder.

Coding agents and CI can make the first-run choice without a prompt:

```bash
runpub --services dashboard,backend --json
runpub --yes --json  # deliberately select every detected service
runpub --services dashboard,backend --agents --json
```

Use `--no-agents` to explicitly skip agent integration for a command. A new
non-interactive project never creates global instructions unless `--agents` is
present. When global integration is already installed, RunPub automatically
adds the project's Cursor rule even in `--json` mode.

The explicit forms below remain supported for scripts:

```bash
runpub run frontend
runpub expose 3000 --project demo --service frontend
```

Expose an already-running backend directly:

```bash
runpub expose 8000 --project sample-app --service backend
```

Or commit a `runpub.json` so one command starts and exposes the whole project:

```json
{
  "$schema": "./node_modules/runpub/runpub.schema.json",
  "project": "sample-app",
  "services": {
    "frontend": {
      "command": "npm run dev",
      "port": 3000,
      "cwd": "dashboard",
      "env": {
        "NEXT_PUBLIC_API_BASE": "${RUNPUB_BACKEND_URL}/api/v1"
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

This also works in npm scripts:

```json
{
  "scripts": {
    "public": "runpub"
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

Every started process receives `RUNPUB_URL` for its own public URL and one
variable per configured service, such as `RUNPUB_FRONTEND_URL` and
`RUNPUB_BACKEND_URL`. The optional service `env` mapping expands these
variables before launching the command, which lets a frontend point to its
public development API without embedding an account-specific hostname.

Auto-detection understands npm, pnpm, Yarn, and Bun projects using common
development scripts; Vite, Next.js, React, Vue, Svelte, Angular, Nuxt, Astro,
Gatsby, Express, NestJS, Fastify, Django, FastAPI, and Flask conventions; and
conventional `frontend`/`backend`, `apps/*`, `packages/*`, and package-manager
workspace layouts. It also scans top-level application folders and asks the
user to resolve ambiguous choices. Unusual repositories can run `runpub init`
and edit the generated file once.

## AI coding agents

When the developer opts in once, RunPub adds a small managed instruction block
to the supported global instruction files:

```text
~/.codex/AGENTS.md       Codex and the ChatGPT coding agent
~/.claude/CLAUDE.md      Claude Code
~/.gemini/GEMINI.md      Antigravity
```

If Codex already uses `AGENTS.override.md`, RunPub updates that active file
instead. On later projects, RunPub detects the global managed blocks and does
not ask again. Cursor stores its global User Rules in application settings, so
RunPub creates the supported project rule `.cursor/rules/runpub.mdc` for each
RunPub project after the global opt-in.

These instructions make RunPub the default launcher for interactive development
servers, frontend previews, APIs, and webhook handlers. Agents check status
first, reuse live tunnels, choose one service or the complete stack, keep the
process alive, and return the public URL. Unit tests, builds, linters, one-off
scripts, databases, admin/debug ports, and processes that do not need a
browser-accessible URL are explicitly excluded.

The installer preserves existing text and owns only content between
`<!-- runpub:managed:start -->` and `<!-- runpub:managed:end -->`. It is safe to
run repeatedly:

```bash
runpub agents install
runpub agents status
runpub agents remove
```

The CLI verifies the issued RunPub token before storing it in
`~/.config/runpub/config.json` with private file permissions. For private or
self-hosted installations, operator-issued token login remains available with
`runpub login --server ... --account ... --token-file ...`.

## Frequently asked questions

### What is RunPub?

RunPub is an open-source, project-aware localhost tunnel and global CLI. It
starts local development services and gives each frontend, API, or webhook
handler a stable public HTTPS URL under `runpublic.dev`.

### How do I open localhost on my phone?

Install RunPub on the computer running the project, sign in once, and run
`runpub` inside the repository. Open the printed `https://...runpublic.dev` URL
on the phone. The devices do not need to share a local network.

### Can Codex or Claude use RunPub automatically?

Yes. Choose the AI-agent option during initial login/onboarding or run `runpub
agents install`. The global choice is reused across projects. Supported agents
are instructed to use RunPub for interactive local frontends, APIs, and
webhooks, keep it running, and return the public URL.

### Does RunPub replace repeated ngrok setup?

For the normal local-development loop, yes: configure the project once and use
`runpub` on later sessions instead of separately starting, naming, and wiring a
tunnel for every service. RunPub does not attempt to reproduce every traffic
inspection, access-policy, or production feature of a general tunnel platform.

### Does RunPub handle frontend and backend services together?

Yes. `runpub all` starts every selected service. RunPub exposes each service at
its own hostname and provides cross-service URL variables so the frontend can
be configured to call the backend.

### Can I use a RunPub URL for a webhook or OAuth callback?

Yes. The public HTTPS URL forwards requests to the local handler while the
tunnel is running, solving the fact that external providers cannot call your
computer's `localhost`. The provider still needs to accept the hostname and
your app must validate webhook signatures, OAuth state, and authentication as
usual.

### Is the URL permanent?

The hostname is stable and reserved for the same account/project/service tuple;
the local app behind it is reachable only while your computer, service, and
RunPub are online.

### Do developers need their own Cloudflare account or domain?

No. The RunPub operator owns the domain and Cloudflare infrastructure. A
developer installs the CLI and signs in with GitHub.

### Is a RunPub URL private?

No. HTTPS encrypts traffic in transit, but the hostname is publicly reachable.
Keep application authentication enabled and never expose databases, admin
ports, debuggers, or secret-bearing services.

### Is RunPub production hosting?

No. RunPub publishes a process running on your development computer. Use a
production hosting platform for an always-on production application.

## Package and compatibility

RunPub is the product, npm package, CLI, GitHub repository, manifest, and
environment-variable prefix. The hosted domain intentionally remains
`runpublic.dev`, so existing public URLs do not change. The former `runpublic`
command, `runpublic.json`, `RUNPUBLIC_*` variables, local credential store, and
tunnel API paths remain supported as migration aliases; new projects should use
the shorter names.

During source development, clone this repository and run `npm install -g .`.
Pass `--account your-name` on the first login when you want a specific available
namespace; otherwise RunPub starts from your GitHub username.

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
RUNPUB_DOMAIN=runpub.test \
RUNPUB_TOKENS_JSON='{"alice":"local-secret"}' \
RUNPUB_PUBLIC_SCHEME=http \
RUNPUB_PUBLIC_PORT=8080 \
npm run start:edge
```

In another terminal:

```bash
runpub login \
  --server http://localhost:8080 \
  --account alice \
  --token local-secret
cd examples/fullstack
runpub
```

The `.test` domain does not resolve publicly. Exercise the route with an
explicit host header:

```bash
curl -H 'Host: fullstack-demo-backend-alice.runpub.test' \
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

RunPub is MIT-licensed. Bugs, focused feature requests, and first-run beta
feedback belong in the provided GitHub issue forms; broader questions and ideas
belong in GitHub Discussions. Anyone can fork the repository and open a pull
request—no prior permission is required. All changes go through protected
`main`, required CI, and maintainer review. See
[CONTRIBUTING.md](CONTRIBUTING.md) and the [launch plan](docs/LAUNCH.md).

## Test and package

```bash
npm test
npm run check
```

The suite covers authentication, config permissions, deterministic naming,
HTTP, WebSockets, protocol v2 streaming, and Worker routing helpers.

## License

MIT
