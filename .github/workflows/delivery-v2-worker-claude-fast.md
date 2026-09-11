---
on:
  workflow_dispatch:
    inputs:
      target_repository: {description: Target repository in owner/repo form, required: true, type: string}
      target_issue: {description: Target issue number, required: true, type: string}
      base_branch: {description: Target base branch, required: true, default: main, type: string}
permissions:
  contents: read
  issues: read
engine: claude
max-turns: 20
max-ai-credits: 100
timeout-minutes: 20
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
    draft: false
    max: 1
    fallback-as-issue: false
    protected-files: blocked
    allowed-files: [docs/**, '*.md', '**/*.md', '**/styles/**', '**/assets/**', '**/*.css', '**/*.scss', '**/*.sass', '**/*.less', apps/web/src/components/**, apps/web/src/views/**, apps/web/src/screens/**]
---
# Delivery V2 implementation worker

Work only on **${{ github.event.inputs.target_repository }} issue #${{ github.event.inputs.target_issue }}**. Start in `${{ github.workspace }}/target`.

Risk profile: **fast**. AI provider: **claude**.

Read the target issue and local repository instructions. Identify the smallest concrete cause, implement the smallest cohesive fix, add regression coverage when testable, and run only focused checks related to the issue. Do not run the full repository suite. Never weaken workflow security, expose credentials, bypass the FAST file envelope, broaden repository access, merge the PR, or close the issue directly. Create exactly one PR with `Closes #${{ github.event.inputs.target_issue }}` and list only validations actually executed. If broader scope is required, stop and report the blocker.
