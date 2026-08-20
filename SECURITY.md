# Security policy

RunPublic exposes local services to the public Internet, so security reports are
treated as high priority.

## Supported versions

Only the newest released minor version receives security fixes during beta.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for the repository. Please do not
open a public issue containing exploit details, credentials, private URLs, or
user data. If private reporting is not enabled, open a public issue asking the
maintainer for a private contact channel without including sensitive details.

Include the affected version, impact, reproduction steps, and any suggested
mitigation. You should receive an acknowledgement within three business days.

## Safe testing

Test only accounts and tunnels you own. Do not access another developer's
hostname, degrade the hosted service, exfiltrate data, or retain sensitive data.
Good-faith, non-destructive reports following these rules are welcome.

Never publish RunPublic tokens. Revoke a suspected token immediately and rotate
any local application credentials that may have crossed an exposed tunnel.
