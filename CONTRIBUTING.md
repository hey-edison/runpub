# Contributing

Thank you for helping improve RunPub. Anyone can contribute through a pull
request; organization membership or prior permission is not required.

Use GitHub Discussions for setup questions and early ideas. Open an issue for a
reproducible bug or a feature with a concrete use case. Security issues belong
in private vulnerability reporting as described in `SECURITY.md`.

## Pull-request workflow

All repository changes, including maintainer changes, go through a pull request.
The `main` branch is protected from direct pushes and force pushes.

1. Fork the repository and create a focused branch from the latest `main`.
2. Make the change and add tests when behavior changes.
3. Run `npm ci` and `npm run check` locally.
4. Push the branch and open a pull request against `hey-edison/runpub:main`.
5. Explain the user-visible outcome, verification, compatibility, and security
   consequences in the pull request template.
6. Address review and CI feedback. A maintainer merges the pull request after
   the required checks pass.

Opening an issue first is helpful for large features or protocol changes, but
it is not required for documentation, tests, or a focused bug fix.

## Release workflow

Contributors should not change the package version unless a maintainer requests
it. The maintainer records releases in `CHANGELOG.md` and updates both
`package.json` and `package-lock.json` to the same version.

Every push to protected `main` runs the trusted publishing workflow. It executes
the complete check suite, compares the repository version with npm, and
publishes only when that exact version does not already exist. Publishing uses
GitHub's npm Trusted Publisher identity and provenance; pull-request branches,
forks, and contributor npm credentials cannot publish the package. A successful
npm publication creates the matching `v<version>` GitHub release.

## Development requirements

- Keep changes focused and preserve compatibility aliases unless a documented
  migration says otherwise.
- Add tests for protocol, authentication, routing, naming, detection, or CLI
  behavior you change.
- Never commit tokens, Cloudflare credentials, `.dev.vars`, D1 local state, TLS
  private keys, private tunnel URLs, or captured request data.

Protocol changes must remain backward-compatible for at least one released
minor version or include an explicit migration plan.
