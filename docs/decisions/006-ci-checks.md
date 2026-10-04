# Credential-free CI checks

The CI workflow runs on pushes, pull requests and manual dispatch. A single
Ubuntu 24.04 job installs Node 24.19.0 and npm 11.17.0, performs a locked install
with package scripts disabled, type-checks both runtime targets, bundles and runs
the backend suite, installs Chromium explicitly, runs the browser suite against
the same bundle, and audits known high/critical dependency advisories.

The only repository permission is `contents: read`. Checkout does not persist
credentials; no Google/Cloudflare secrets, deploy command, remote migration,
`pull_request_target` trigger, shared package cache or artifact upload is used.
Tests use isolated local bindings and Google boundary fixtures. Package/browser
downloads, Linux system-library installation and advisory lookup still need
network access; this is not an offline job. A ten-minute job timeout bounds a hang.

Action versions are pinned to commits resolved from the official release tags:
[checkout v7.0.1](https://github.com/actions/checkout/tree/3d3c42e5aac5ba805825da76410c181273ba90b1)
and [setup-node v6.5.0](https://github.com/actions/setup-node/tree/249970729cb0ef3589644e2896645e5dc5ba9c38).
Browser installation follows [Playwright's CI guidance](https://playwright.dev/docs/ci-intro#setting-up-github-actions).
Workflow triggers, permissions and concurrency follow the
[GitHub syntax reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).

Local verification: actionlint 1.7.12 accepts the workflow. Its Windows release
archive was checked against GitHub's published SHA-256 digest before execution.
Fresh-context workflow review and a separate Linux portability source review
found no actionable issue. The existing strict compiler checks cover Worker and
browser code; this repository has no general-purpose source lint configuration.

This is a prepared workflow, not evidence of a green GitHub-hosted run. The owner
has prohibited pushing for now. After publication is explicitly approved, inspect
the first hosted run and resolve any failures before making CI a required branch
check. Branch protection and live-provider verification are still pending; no
external repository settings were changed.
