# Repository Guidelines

## Project Structure & Module Organization
The Railway-hosted Express app lives in `index.js` and serves both the Roblox proxy endpoints and the job reservation API. Deployment metadata stays in `wrangler.toml`; dependency metadata is in `package.json` and `package-lock.json`. Keep Lua automation assets inside `other stuff/`. Add modules under `src/` and tests in `tests/` when needed.

## Build, Test, and Development Commands
- `npm install` - install runtime dependencies.
- `npm run run` - start the proxy and job distributor on `http://localhost:3000`; use for local smoke tests and Railway parity.
- `npx wrangler dev` - emulate the legacy Worker when edge behaviour must be checked.
- `npm run deploy` - deploy through Wrangler; Railway deployments use the dashboard or CLI with the same env vars.

## Coding Style & Naming Conventions
Follow the Zen of Python: simple, explicit, readable. Use ES modules, four-space indentation, and avoid unnecessary trailing commas. Name request handlers in lowerCamelCase; keep constants and allowlists in SCREAMING_SNAKE_CASE. Separate proxy helpers from job scheduling helpers to keep modules focused. Run `npx eslint .` before opening a PR if linting is configured.

## Testing Guidelines
Place integration tests in `tests/` using `supertest`. Cover domain allowlisting, header sanitisation, JobId reservation, cache expiry, and Roblox fetch fallbacks. Manual checks: `curl http://localhost:3000/jobs/next` for JobId rotation and `curl http://localhost:3000/users/v1/users/1` for proxy sanity.

## Commit & Pull Request Guidelines
Write imperative commit messages (e.g. `Implement job reservation cache`) and keep each change scoped. PRs should explain the motivation, reference relevant Lua automation behaviour, and list validation steps or Railway preview URLs. Link issues with `Fixes #id` and call out any new secrets or environment variables.

## Security & Configuration Tips
Store proxy credentials and Roblox tokens in env vars or Wrangler secrets. Enforce allowlists on new endpoints. Strip sensitive headers before logging and keep job distributor responses minimal.

## Job Distribution Service
Call `GET /jobs/next?placeId=<id>` (defaults to `DEFAULT_PLACE_ID` / `109983668079237`) to receive a reserved JobId plus player counts and cache metadata. The service preloads Roblox server pages through the proxy, caches JobIds for one minute, and marks each response as reserved so only one client hops into a server. A lightweight sweep drops expired batches and forces a refetch when the pool is depleted. Keep the handler lean to uphold Zen-of-Python simplicity while allowing many Roblox clients to share the pool without race conditions.

# When running commands
Long-running tooling (tests, docker compose, migrations, etc.) must always be invoked with sensible timeouts or in non-interactive batch mode. Never leave a shell command waiting indefinitely—prefer explicit timeouts, scripted runs, or log polling after the command exits.