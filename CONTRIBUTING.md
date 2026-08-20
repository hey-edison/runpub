# Contributing

Thank you for helping improve RunPublic.

Use GitHub Discussions for setup questions and early ideas. Open an issue for a
reproducible bug or a feature with a concrete use case. Security issues belong
in private vulnerability reporting as described in `SECURITY.md`.

For code changes:

1. Fork the repository and create a focused branch.
2. Run `npm ci` and `npm test`.
3. Add tests for protocol, authentication, routing, or naming behavior you
   change.
4. Run `npm run check` before opening a pull request.
5. Explain compatibility and security consequences in the pull request.

Protocol changes must remain backward-compatible for at least one released
minor version or include an explicit migration plan. Never commit tokens,
Cloudflare credentials, `.dev.vars`, D1 local state, or TLS private keys.
