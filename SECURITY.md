# Security Policy

## Supported versions

Bearing Lite is currently a pre-1.0 project. Security fixes are provided for the
current `main` branch and the latest published `0.1.x` release of
`@alphazede/bearing-lite`, when one is available. Older commits, development
snapshots, and superseded releases are not supported unless a published advisory
says otherwise.

| Version | Supported |
|---|---|
| Current `main` | Yes |
| Latest published `0.1.x` | Yes |
| Older or superseded versions | No |

## Report a vulnerability privately

Use GitHub's [private vulnerability reporting
form](https://github.com/alphazede/bearing-lite/security/advisories/new). Private
vulnerability reporting is enabled for this repository when the host supports it.

Do not open a public issue, discussion, pull request, or social-media post for
a suspected vulnerability. Use [public
issues](https://github.com/alphazede/bearing-lite/issues) only for ordinary,
non-security bugs.

Include enough information to reproduce and assess the problem:

- The affected Bearing Lite version or commit.
- Operating system, installation method, and agent client.
- A minimal reproduction, proof of concept, and observed impact.
- Whether owner authority, repository boundaries, skill routing, or hook
  integrity behavior was bypassed or misreported.
- Suggested mitigations, if known.

Use synthetic data whenever possible. Do not send credentials, customer data,
private repository contents, raw agent-session history, or unredacted evidence.
If a secret may have been exposed, revoke or rotate it before reporting and
include only a redacted identifier.

## Security boundaries

Reports are especially useful when they involve:

- Skill or hook behavior that expands authority, skips required assurance, or
  claims executable enforcement the client cannot provide.
- Path traversal, unsafe file mutation guidance, or repository-boundary mistakes
  in packaged skills or hooks.
- Sensitive data leaking through logs, packaged files, diagnostics, or npm
  package contents.
- Release, dependency, build, or package-publishing integrity.
- Model, provider, or credential handling introduced into public product
  surfaces (Bearing Lite must remain provider-neutral and must not ship
  credentials or secret lookup paths).

A weakness in a third-party agent client, model provider, runtime, or dependency
should normally be reported to that project. Report it to Bearing Lite as well
when this package exposes, amplifies, or incorrectly handles the weakness.

## Response and disclosure

GitHub immediately records the private report. AlphaZede aims to:

- Acknowledge the report within three business days.
- Provide an initial triage result within seven calendar days.
- Send an update at least every fourteen calendar days while remediation is
  active.
- Coordinate a fix, release, and public advisory before public disclosure when
  the report is confirmed.

These are response targets, not a support SLA. Timing may change with severity,
reproduction quality, upstream dependencies, and release risk. Reporters who
want public credit should request it in the private advisory. Duplicate,
non-security, or unsupported reports will be closed with an explanation.

## Good-faith research

Research must avoid privacy violations, service disruption, persistence,
social engineering, and access to data or repositories you do not own or have
permission to test. Use the minimum access necessary, stop when sensitive data
is encountered, and report promptly through the private channel.

AlphaZede will not initiate legal action for accidental, good-faith violations
of this policy when the researcher promptly stops, reports the issue, avoids
harm, and gives reasonable time for remediation. This policy cannot authorize
testing of third-party systems or excuse violations of applicable law.

Bearing Lite does not currently offer a bug bounty or promise compensation.
