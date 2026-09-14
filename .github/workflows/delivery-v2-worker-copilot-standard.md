---
on:
  workflow_dispatch:
    inputs:
      target_repository: {description: Target repository in owner/repo form, required: true, type: string}
      target_issue: {description: Target issue number, required: true, type: string}
      base_branch: {description: Target base branch, required: true, default: main, type: string}
      target_ref: {description: Exact base or PR-head ref to inspect, required: false, default: '', type: string}
      target_pr: {description: Existing managed PR number for bounded remediation, required: false, default: '', type: string}
      remediation_context: {description: Controller-provided CI/audit findings for bounded remediation, required: false, default: '', type: string}
      dispatch_nonce: {description: Deterministic controller dispatch correlation nonce, required: true, type: string}
      controller_run_id: {description: Authoritative Delivery V2 controller workflow run id, required: true, type: string}
run-name: "Delivery V2 worker ${{ github.event.inputs.dispatch_nonce }}"
permissions:
  actions: read
  contents: read
  issues: read
env:
  GH_AW_POLICY_ALLOW_CREATE_PULL_REQUEST: "${{ github.event.inputs.target_pr == '' && 'true' || 'false' }}"
  copilot-requests: write
pre-steps:
  - name: Validate controller-selected worker authorization
    shell: bash
    env:
      CONTROLLER_RUN_ID: ${{ github.event.inputs.controller_run_id }}
      TARGET_REPOSITORY: ${{ github.event.inputs.target_repository }}
      TARGET_ISSUE: ${{ github.event.inputs.target_issue }}
      TARGET_PR: ${{ github.event.inputs.target_pr }}
      TARGET_REF: ${{ github.event.inputs.target_ref || github.event.inputs.base_branch }}
      BASE_BRANCH: ${{ github.event.inputs.base_branch }}
      DISPATCH_NONCE: ${{ github.event.inputs.dispatch_nonce }}
      EXPECTED_PROVIDER: copilot
      EXPECTED_RISK: standard
      DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}
      GITHUB_TOKEN: ${{ github.token }}
      DELIVERY_GITHUB_READ_TOKEN: ${{ secrets.DELIVERY_GITHUB_READ_TOKEN }}
    run: node .github/scripts/validate-delivery-v2-worker-authorization.mjs
engine:
  id: copilot
  model: ${{ vars.DELIVERY_STANDARD_IMPLEMENTER_MODEL || vars.DELIVERY_IMPLEMENTER_MODEL || 'gpt-5.3-codex' }}
max-turns: 40
max-ai-credits: 250
timeout-minutes: 35
network:
  allowed: [defaults, node, binaries.prisma.sh]
checkout:
  repository: ${{ github.event.inputs.target_repository }}
  ref: ${{ github.event.inputs.target_ref || github.event.inputs.base_branch }}
  path: target
  github-token: ${{ secrets.DELIVERY_GITHUB_READ_TOKEN }}
  fetch-depth: 0
  fetch: ["refs/pulls/open/*"]
  current: true
tools:
  edit:
  bash: true
  github:
    mode: gh-proxy
    toolsets: [issues]
    github-token: ${{ secrets.DELIVERY_GITHUB_READ_TOKEN }}
    allowed-repos: ["crgasparoto-br/*"]
    min-integrity: approved
safe-outputs:
  github-token: ${{ secrets.DELIVERY_GITHUB_WRITE_TOKEN }}
  create-pull-request:
    target-repo: ${{ github.event.inputs.target_repository }}
    allowed-repos: ["crgasparoto-br/*"]
    base-branch: ${{ github.event.inputs.base_branch }}
    allowed-base-branches: [main, develop]
    title-prefix: "[delivery-v2] "
    draft: false
    max: 1
    fallback-as-issue: false
    protected-files: blocked
  push-to-pull-request-branch:
    target: "${{ github.event.inputs.target_pr }}"
    target-repo: ${{ github.event.inputs.target_repository }}
    allowed-repos: ["crgasparoto-br/*"]
    required-title-prefix: "[delivery-v2] "
    max: 1
    fallback-as-pull-request: false
    protected-files: blocked
---
# Delivery V2 implementation worker

Work only on **${{ github.event.inputs.target_repository }} issue #${{ github.event.inputs.target_issue }}**. Start in `${{ github.workspace }}/target`.

Risk profile: **standard**. AI provider: **copilot**.

Context hygiene: do not inventory retired or generated delivery snapshots, `.generated/**`, compiled `*.lock.yml`, or unrelated repository history unless the issue explicitly targets them or a deterministic check requires them. Prefer targeted search in issue-relevant source/test/docs paths; do not inventory the entire repository before editing.

The deterministic controller owns orchestration, risk, budgets, CI/audit state and retries. You are only the bounded material worker for this attempt.

- **Initial mode** (`target_pr` is empty): read the target issue and local repository instructions; identify the smallest concrete cause before editing. Implement the smallest cohesive fix without unrelated refactoring. Add regression coverage when testable. Run affected tests plus the smallest applicable typecheck/build checks; do not run unrelated full regression suites. Create exactly one PR whose title starts with `[delivery-v2] ` and whose body contains `Closes #${{ github.event.inputs.target_issue }}`. List only validations actually executed.
- **Remediation mode** (`target_pr` is non-empty): treat `remediation_context` as the only requested correction scope unless the current diff exposes a new safety boundary. Work on the exact checked-out PR head from `target_ref`; inspect the existing PR/diff as needed, apply the smallest correction, commit it, and use `push-to-pull-request-branch` for exactly PR #${{ github.event.inputs.target_pr }}. Do **not** create a replacement PR. If the remediation would require a broader risk surface, unrelated refactor, provider substitution or protected-file bypass, stop and report the blocker instead of broadening scope.

Never weaken workflow security, expose credentials, bypass the protected-file policy, broaden repository access, merge a PR, close the issue directly, or orchestrate another AI worker.
