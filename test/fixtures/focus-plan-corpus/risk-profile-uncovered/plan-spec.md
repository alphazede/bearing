---
type: plan-spec
status: complete
---

## Acceptance criteria

- **AC-1** — Keep Focus bounded.

## Risks and open questions

- **RISK-1** — Invalid input must fail closed.

## Entry criteria

Requirements are approved.

## Exit criteria

All evidence commands pass.

## Rollback or repair

Repair the fixture and rerun validation.

## Accountable controller

Navigator controls the phase.

## Risk Profile

| Flag | Applies | Coverage or rationale |
| --- | --- | --- |
| moves_money | yes | design: Threat Model |
| live_financial_action | no | The plan never executes a live trade; all work is local markdown. |
| agentic_tools | no | The plan invokes no autonomous agent tooling outside the bounded route. |
| untrusted_external_content | no | Every input is repository-local; nothing external is fetched. |
| personal_or_behavioral_data | no | No personal or behavioral data is read or stored by this plan. |
| multi_user | no | A single operator runs the plan; no concurrent users exist. |
| multi_tenant | no | The plan touches no tenant boundary; all state is per-run. |
| company_customers | no | No customer-facing surface exists; the plan is internal tooling. |
| public_api_or_sdk | no | No public API or SDK surface is introduced by this plan. |
| external_webhooks_and_providers | no | No webhook endpoint or external provider is called at runtime. |
| regulated_or_sanctions_exposure | no | The plan operates in no regulated or sanctions-sensitive domain. |
| production_service | no | Nothing is deployed; the plan runs only in the development checkout. |
| availability_required | no | No always-on service exists, so availability is not required. |
| automatic_external_issue_creation | no | The plan never files or updates external issues automatically. |
