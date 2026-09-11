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
max-turns: 80
max-ai-credits: 500
timeout-minutes: 55
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
    allowed-repos: [crgasparoto-br/*]
safe-outputs:
  github-token: ${{ secrets.DELIVERY_GITHUB_WRITE_TOKEN }}
  create-pull-request:
    target-repo: ${{ github.event.inputs.target_repository }}
    allowed-repos: [crgasparoto-br/*]
    base-branch: ${{ github.event.inputs.base_branch }}
    allowed-base-branches: [main, develop]
    draft: false
    max: 1
    fallback-as-issue: false
    protected-files: blocked
---
# Delivery V2 implementation worker

Work only on **${{ github.event.inputs.target_repository }} issue #${{ github.event.inputs.target_issue }}**. Start in `${{ github.workspace }}/target`.

Risk profile: **critical**. AI provider: **copilot**.

Read the issue and local contributor instructions; identify the concrete cause; implement the smallest complete fix; add regression coverage; run the strongest relevant local validation that is practical. The deterministic CI layer remains the final full-regression authority. Never weaken workflow security, expose credentials, bypass protected files, broaden repository access, merge the PR, or close the issue directly. Create exactly one PR with `Closes #${{ github.event.inputs.target_issue }}` and list only validations actually executed. If blocked, report the blocker rather than inventing a bypass.
