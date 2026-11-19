# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: on this repository, open the **Security**
tab and choose **Report a vulnerability**. Only the maintainers can see the
report.

Include what you can of:

- the affected package and version or commit;
- steps to reproduce, or a proof of concept;
- the impact you expect.

## What to expect

We are a small team and answer on a best-effort basis. We aim to acknowledge a
report within a few business days and to tell you what we plan to do about a
confirmed issue. Once a fix ships we publish a GitHub security advisory and
credit you, unless you ask us not to.

## Scope

This policy covers the SDKs and command line tools published from this
repository. The repository is a read-only mirror generated from a private
monorepo, so fixes are made upstream and arrive here with the next sync.

Out of scope:

- The project token being readable in a browser or app bundle. It is public
  by design: it can only write events and profile properties, never read.
- Findings that need a compromised host or physical access to a user's device.

## Supported versions

Fixes ship in the next release of the affected package. Please test against
the latest published version before reporting.
