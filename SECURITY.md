# Security Policy

## Supported scope

KnockDesk is under active stabilization. Security reports are welcome for the maintained KnockDesk desktop shell, its preload/IPC boundary, the KnockDesk plugins, the bulk archive tools, and the way the product packages or launches its runtime. The upstream Hermes runtime and bundled third-party components may have separate upstream reporting policies and supported-version rules.

## Report privately

Do not publish an unpatched vulnerability, exploit details, credentials, access tokens, private logs, or personal data in a public issue.

If GitHub's **Private vulnerability reporting** feature is enabled for this repository, use the Security tab to submit a private report. If that option is unavailable, contact the repository owner through the GitHub account that maintains this project and request a private reporting channel. Do not include secrets in the initial message.

Please include the affected version or commit, operating system, affected component/path, impact, minimal reproduction steps, and any relevant sanitized logs. Do not upload real user data or live credentials.

## Handling and disclosure

The maintainer should acknowledge a report, investigate and validate it, prepare a fix where appropriate, and coordinate a disclosure that avoids exposing users before a fix is available. Do not assume a response-time guarantee or a bug-bounty program.

## Safe operation

KnockDesk is local-first, not universally offline. Model providers, messaging services, remote relays, browser tools, and other configured integrations may transmit data outside the machine. Review permissions and provider terms before enabling them. Keep the Hermes command-approval gate enabled unless you deliberately accept the additional risk of unattended execution.

Security checks in CI are targeted checks, not a guarantee that every binary, third-party package, dependency, or historic commit is free from vulnerabilities or private data. Review the current release audit and upstream advisories before distributing a build.
