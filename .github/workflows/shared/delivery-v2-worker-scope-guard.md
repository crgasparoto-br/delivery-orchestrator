---
safe-outputs:
  threat-detection:
    steps:
      - name: Checkout trusted material scope guard
        uses: actions/checkout@v7
        with:
          repository: ${{ github.repository }}
          ref: ${{ github.sha }}
          path: .delivery-v2-scope-guard
          sparse-checkout: |
            .github/scripts/delivery-v2-worker-scope-contract.mjs
            .github/scripts/validate-delivery-v2-worker-authorization.mjs
            .github/scripts/validate-delivery-v2-worker-scope.mjs
          sparse-checkout-cone-mode: false
          fetch-depth: 1
          persist-credentials: false
      - name: Validate controller-authorized material scope
        shell: bash
        env:
          TARGET_REPOSITORY: ${{ github.event.inputs.target_repository }}
          TARGET_ISSUE: ${{ github.event.inputs.target_issue }}
          TARGET_PR: ${{ github.event.inputs.target_pr }}
          CONTROLLER_RUN_ID: ${{ github.event.inputs.controller_run_id }}
          DISPATCH_NONCE: ${{ github.event.inputs.dispatch_nonce }}
          DELIVERY_GITHUB_READ_TOKEN: ${{ secrets.DELIVERY_GITHUB_READ_TOKEN }}
          PATCH_PATH: /tmp/gh-aw/threat-detection/aw.patch
        run: |
          set -euo pipefail
          trap 'rm -rf .delivery-v2-scope-guard' EXIT
          node .delivery-v2-scope-guard/.github/scripts/validate-delivery-v2-worker-scope.mjs
---
