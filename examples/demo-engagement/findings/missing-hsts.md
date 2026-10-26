---
title: Missing HTTP Strict Transport Security header
cvss: CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N
category: "CWE-319: Cleartext Transmission"
affected:
  - https://shop.acme.example
retest_status: solved
---
<!-- field:description -->
The application does not send the `Strict-Transport-Security` header.

<!-- field:recommendation -->
Send `Strict-Transport-Security: max-age=31536000; includeSubDomains`.

<!-- field:retest_notes -->
The header is now present.
