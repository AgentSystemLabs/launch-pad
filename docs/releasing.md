# Releasing — publishing the CLI to npm

The user-facing product is the **`@agentsystemlabs/launch-pad`** CLI. It is published to npm
by `.github/workflows/release.yml` using **npm OIDC Trusted Publishing** — GitHub Actions
authenticates to npm through a short-lived OIDC identity, so there is **no `NPM_TOKEN` secret**
to manage or leak. Provenance attestation is attached automatically.

Only the CLI is published. `@agentsystemlabs/launch-pad-shared` is **bundled into the CLI**
(tsup `noExternal`), and the Rust agent (`@agentsystemlabs/launch-pad-agent`) is **not** a
runtime dependency — both are kept as `devDependencies` for local builds only, so the published
package depends solely on public npm packages and works with a plain `npm i -g` / `npx`.

## One-time setup (per package, before the first CI release)

npm only lets you attach a trusted publisher to a package that **already exists** on the
registry, and `@agentsystemlabs/launch-pad` has never been published. So the very first
release is a manual bootstrap; every release after that is hands-off CI.

1. **Bootstrap the package name** — publish the initial version manually so the package exists:

   ```bash
   npm login                      # as a member of the @agentsystemlabs org with publish rights
   pnpm install
   pnpm --filter @agentsystemlabs/launch-pad publish --no-git-checks --access public
   ```

   (This is the only publish that needs a human / token. If 2FA is enabled on the org, you'll
   be prompted for an OTP.)

2. **Configure the trusted publisher** at
   <https://www.npmjs.com/package/@agentsystemlabs/launch-pad/access> → **Trusted Publisher** →
   **GitHub Actions**, with these values **exactly** (npm validates them against the OIDC token
   and the match is **case-sensitive** — a wrong case fails later with a misleading `404`):

   | Field | Value |
   | --- | --- |
   | Organization or user | `AgentSystemLabs` |
   | Repository | `launch-pad` |
   | Workflow filename | `release.yml` |
   | Environment | *(leave blank)* |

That's it — from now on no token is needed and CI publishes on its own.

## Cutting a release

The workflow publishes the version currently in `packages/cli/package.json` and refuses to run
if a triggering tag doesn't match it. The flow:

1. Bump `packages/cli/package.json` `version` (the [`/release`](../CLAUDE.md) skill / `pnpm version`
   can do this and create the tag for you).
2. Push a matching `v<version>` tag:

   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

3. The `release` workflow runs: `pnpm install --frozen-lockfile` → tag/version check →
   build `shared` → `typecheck` → `test` → `pnpm publish` (OIDC). Watch it in the **Actions**
   tab; the package appears at <https://www.npmjs.com/package/@agentsystemlabs/launch-pad>.

You can also trigger it manually from the Actions tab (**Run workflow** / `workflow_dispatch`),
which skips the tag/version check and publishes whatever version is on the chosen ref.

## How it works / gotchas

- **No `registry-url` in `actions/setup-node`.** The repo pins `pnpm@11.1.2`; on that version
  the `.npmrc` placeholder token `actions/setup-node` writes (`_authToken=${NODE_AUTH_TOKEN}`)
  makes OIDC publishes return a spurious `404` (fixed upstream in pnpm 11.1.3). The workflow
  therefore lets pnpm talk to the default registry and run the OIDC exchange itself. If you bump
  the repo's pnpm to ≥ 11.1.3 you may add `registry-url: https://registry.npmjs.org` back.
- **Requirements:** npm OIDC trusted publishing needs Node ≥ 22.14 (the workflow uses 24) and a
  pnpm version with OIDC support (≥ 11.0.7; the repo's 11.1.2 qualifies).
- **`prepublishOnly`** rebuilds the bundled `dist/` right before packing, so a release can never
  ship stale output — even from a manual `pnpm publish`.
- **Provenance** requires the `repository` field in `packages/cli/package.json` (already set) and
  is attached automatically under trusted publishing; no `--provenance` flag is needed.
- **What ships:** only `dist/` + `package.json` + `LICENSE` (see the package `files` field). Verify
  a build locally with `cd packages/cli && pnpm pack` and inspect the `.tgz`.
