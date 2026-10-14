# Reviewed sharing and safe evaluation

This fork requires a signed-in organization member to review the report in the app before creating a public link. The dialog presents the exact title, summary and sandboxed HTML, a revision and SHA-256. The server binds approval to that revision and authenticated user. MCP/SAM can revoke links but cannot approve sharing.

Every save increments the revision and atomically clears sharing and approval. Revocation also advances the revision so an outstanding review cannot reopen a revoked link. Approval uses compare-and-set; a concurrent save or revocation requires a fresh review. Public document reads authorize the token and read the HTML in one query, with no-store responses. Previously downloaded copies cannot be withdrawn. Revision identity is not a retained version history or proof of factual accuracy.

## Evaluation and rollout

Apply the paired D1/PostgreSQL migrations only in an approved rollout, after backup and review. Existing public links are intentionally revoked because they have no version-bound approval. No migration should run automatically as part of evaluating this branch. Rolling back code does not restore revoked links; do not restore tokens from backup to bypass review.

Cloudflare Access and local_noauth are shared owner workspaces, not client isolation. Paid DataForSEO, OpenRouter and browser/Context rendering calls are disabled there until an atomic reservation and reconciliation ledger exists. The hosted billing path remains separate and is not certified as a hard monetary ceiling for LLM turns or uncertain transport outcomes. There is deliberately no environment switch to bypass the missing ledger.

The crawler resolves destinations before requests and discovery redirects, rejects unknown DNS results and credentials in URLs, and bounds robots and DNS response reads. This is not connection pinning: DNS rebinding, runtime egress and browser subresources still require deployment-specific controls and validation.

Before enabling commercial use: validate both database dialects, runtime egress, browser/accessibility interactions, immutable review/audit retention, dependency findings, budgets for concurrent jobs and uncertain results, factual/source/right review, and actual SEO outcomes. No paid-provider or production verification is implied by unit tests.
