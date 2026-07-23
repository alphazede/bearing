# Security Policy

## Supported versions

Bearing is currently a pre-1.0 project. Security fixes are provided for the
current `main` branch and the latest published `0.1.x` release, when one is
available. Older commits, development snapshots, and superseded releases are
not supported unless a published advisory says otherwise.

| Version | Supported |
|---|---|
| Current `main` | Yes |
| Latest published `0.1.x` | Yes |
| Older or superseded versions | No |

## Report a vulnerability privately

Use GitHub's [private vulnerability reporting
form](https://github.com/alphazede/bearing/security/advisories/new). Private
vulnerability reporting is enabled for this repository.

Do not open a public issue, discussion, pull request, or social-media post for
a suspected vulnerability. Use [public
issues](https://github.com/alphazede/bearing/issues) only for ordinary,
non-security bugs.

Include enough information to reproduce and assess the problem:

- The affected Bearing version or commit.
- Operating system, Node.js version, installation method, and selected harness.
- A minimal reproduction, proof of concept, and observed impact.
- Whether owner approval, repository containment, or local authentication was
  bypassed.
- Suggested mitigations, if known.

Use synthetic data whenever possible. Do not send credentials, one-time
capability URLs, customer data, private repository contents, raw agent-session
history, or unredacted evidence. If a secret may have been exposed, revoke or
rotate it before reporting and include only a redacted identifier.

## Security boundaries

Reports are especially useful when they involve:

- Session authentication, capability leakage, or approval bypass.
- Repository-containment failures, path traversal, symlink attacks, filesystem
  races, or unsafe deletion.
- Command or argument injection and unintended agent or harness authority.
- Stored or reflected script injection and incorrect output escaping.
- Sensitive data leaking through logs, artifacts, reports, browser state,
  plugin contents, or npm packages.
- Release, dependency, build, or package-publishing integrity.
- Resume or recovery behavior that executes work without the recorded owner
  decision.

A weakness in a third-party harness, model provider, runtime, or dependency
should normally be reported to that project. Report it to Bearing as well when
Bearing exposes, amplifies, or incorrectly handles the weakness.

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

Bearing does not currently offer a bug bounty or promise compensation.
