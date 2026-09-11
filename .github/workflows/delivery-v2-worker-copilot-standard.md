---
on:
  workflow_dispatch:
    inputs:
      target_repository: {description: Target repository in owner/repo form, required: true, type: string}
      target_issue: {description: Target issue number, required: true, type: string}
      base_branch: {description: Target base branch, required: true, default: main, type: string}
permissions:
  contents: read
  copilot-requests: write
engine: copilot
max-turns: 40
max-ai-credits: 250
timeout-minutes: 35
network:
  allowed: [defaults, node, binaries.prisma.sh]
checkout:
  repository: ${{ github.event.inputs.target_repository }}
  ref: ${{ github.event.inputs.base_branch }}
  path: target
  github-token: ${{ secrets.DELIVERY_GITHUB_READ_TOKEN }}
  fetch-depth: 0
  current: true
tools:
  edit:
  bash: true
  github:
    mode: gh-proxy
    toolsets: [repos, issues, pull_requests]
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
    draft: false
    max: 1
    fallback-as-issue: false
    protected-files: blocked
---
# Delivery V2 implementation worker

Work only on **${{ github.event.inputs.target_repository }} issue #${{ github.event.inputs.target_issue }}**. The repository is checked out at `${{ github.workspace }}/target`; start there.

Risk profile: **standard**. AI provider: **copilot**.

Read the target issue and local contributor instructions. Identify the smallest concrete cause before editing. Implement the smallest cohesive fix without unrelated refactoring. Add or update regression coverage when testable. Run affected tests plus the smallest applicable typecheck/build checks; do not run unrelated full regression suites. Never weaken workflow security, expose credentials, bypass protected files, broaden repository access, merge the PR, or close the issue directly. Create exactly one PR whose body includes `Closes #${{ github.event.inputs.target_issue }}` and only validations actually executed. If blocked, report rather than bypass.
