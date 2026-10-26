---
title: Insecure Direct Object Reference on orders
cvss: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N
category: "CWE-639: Authorization Bypass Through User-Controlled Key"
affected:
  - GET /api/v2/orders/{id}
retest_status: not_solved
---
<!-- field:description -->
Orders can be read by any authenticated user by changing the numeric `id` in the URL.

<!-- field:recommendation -->
Check on the server that the order belongs to the authenticated user.

<!-- field:retest_notes -->
Not fixed: the behaviour is unchanged.
