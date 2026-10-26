---
title: Missing security headers
cvss: CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N
category: "CWE-693: Protection Mechanism Failure"
references:
  - https://owasp.org/www-project-secure-headers/
---
<!-- field:description -->
The application does not set one or more recommended HTTP security headers
(`Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`).

<!-- field:recommendation -->
Configure the web server to send the missing headers on every response.
