# RunPublic architecture

## Public production path

```text
developer CLI                         public browser / webhook
     |                                           |
     | authenticated WebSocket                  | HTTPS / WebSocket
     +-------------------+   +-------------------+
                         v   v
                   Cloudflare Worker
                         |
                  hostname -> idFromName
                         |
                 one Durable Object
                    per hostname
                         |
                  tunnel WebSocket
                         |
                  developer localhost
```

The Worker validates an API token against D1 before it accepts a tunnel. D1 is
the permanent control plane: it stores accounts, SHA-256 hashes of 256-bit
random tokens, service reservations, quotas, and audit events. Plaintext tokens
are returned only once when created and are never stored by the service.

The full `(account, project, service)` tuple and the generated hostname both
have database uniqueness constraints. A long generated DNS label includes a
128-bit SHA-256 suffix. These constraints make a duplicate reservation an
explicit conflict rather than a last-writer-wins accident.

`TUNNELS.idFromName(hostname)` maps every request and tunnel connection for one
hostname to the same Durable Object globally. The object owns the active agent
WebSocket and any public HTTP or WebSocket sessions. Cloudflare can move or
hibernate the object without creating two owners, so the architecture does not
need replica-local routing tables or Redis pub/sub for request data.

HTTP protocol v2 sends bounded 64 KiB chunks between the Durable Object and the
CLI. The CLI applies response-side WebSocket backpressure and both sides enforce
body, concurrency, and timeout limits. WebSocket messages are forwarded without
HTTP buffering. The older buffered protocol remains supported by the Node edge.

## Node/Railway path

The Node edge remains useful for local development, private installations, and
rollback. It stores active tunnels in one process, so it must run as exactly one
replica. Its static token configuration is not the public multi-tenant control
plane.

The current wildcard DNS record points at Railway and is proxied by Cloudflare.
A Cloudflare Worker route can intercept `*.runpublic.dev/*` before the Railway
origin. Removing that route rolls traffic back to Railway without a DNS change.

## Security boundaries

- Only an authenticated account token may open a tunnel in that account's
  namespace.
- The operator admin API exists only on `edge.runpublic.dev`, requires a secret
  stored as a Cloudflare Worker secret, and never accepts that secret in a URL.
- Public tunnel traffic is intentionally unauthenticated unless the developer's
  local application adds its own authentication.
- Hop-by-hop headers are removed, forwarding headers are regenerated, response
  headers are validated, and error responses receive restrictive browser
  security headers.
- Each hostname has request-rate, pending-request, WebSocket-count, body-size,
  and timeout limits. Account service counts are enforced in D1.

## Remaining scale work

Before promising 100,000 simultaneously connected developers, load test the
actual traffic mix and set Cloudflare account limits from measured results.
Also add automated abuse detection, customer support tooling, usage metering,
data-retention jobs, and an incident on-call rotation. The architecture removes
the single-process bottleneck; operations still determine production capacity.
