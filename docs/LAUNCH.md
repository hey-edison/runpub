# Open-source and public-beta launch plan

RunPub should be both an open-source developer tool and an operator-hosted
service. GitHub is where developers inspect the code, report issues, contribute,
and star the project. npm is how they install the CLI. `runpublic.dev` is the
managed network that makes the URLs work.

## Recommended sequence

1. Create a public GitHub repository named `runpub` and push this code.
2. Add the repository URL to `package.json`, enable Discussions, private
   vulnerability reporting, Dependabot, and branch protection requiring CI.
3. Publish `runpub` to npm. Configure npm Trusted Publishing for
   `.github/workflows/publish.yml` after the first package exists.
4. Invite 10-20 developers manually. Give each one a token and a 15-minute task:
   install, expose an existing app, send a webhook, stop it, and tell you where
   they hesitated.
5. Fix onboarding friction before making a broad announcement.
6. Publish a short demo video or GIF and launch from the founder's own account on
   GitHub, X/LinkedIn, relevant Discord/Slack communities, Hacker News Show HN,
   Reddit communities that permit project posts, and Product Hunt if useful.

## What the launch post should say

- One sentence: “Stable HTTPS URLs for every local frontend and backend, from
  one global CLI.”
- A 20-second example showing install, login, bare `runpub`, and a webhook.
- Why it exists and how it differs from generic random-URL tunnel tools.
- The honest beta limits and security warning.
- One request: try it on a real project and open an issue or Discussion.

Do not ask primarily for stars. Ask for one concrete use and one piece of
feedback. Stars tend to follow a useful demo, clear docs, responsive maintenance,
and visible momentum.

## Feedback loop

- GitHub Issues: reproducible bugs and scoped feature requests.
- GitHub Discussions: setup questions, ideas, show-and-tell, and polls.
- A short form or 20-minute calls for qualitative onboarding feedback.
- Labels: `first-run`, `tunnel`, `websocket`, `webhook`, `docs`, `security`,
  `good first issue`.
- Weekly public changelog summarizing what beta users changed.

Measure activation, not vanity alone:

- account created -> first successful tunnel;
- time from install -> first public 2xx response;
- tunnel connection and request success rates;
- weekly developers who open a tunnel;
- week-one return rate;
- issues resolved and median first response time.

GitHub stars are useful social proof and discovery, but they do not measure
whether the hosted service works. npm downloads can also be inflated by CI. The
best early signal is developers returning to expose another service.

## Boundaries for the beta

- Start invite-only; do not expose self-service account creation yet.
- State that URLs are public and machines must stay online.
- Publish fair-use limits and prohibited content.
- Provide a security contact and abuse takedown process.
- Keep the CLI/edge protocol open. Reserve billing, hosted reliability, team
  controls, and managed abuse protection as service value rather than making the
  client proprietary.
