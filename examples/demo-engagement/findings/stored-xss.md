---
title: Stored Cross-Site Scripting in product reviews
cvss: CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:H/I:L/A:N
category: "CWE-79: Cross-site Scripting"
affected:
  - https://shop.acme.example/product/*/reviews
retest_status: partial
retest_date: 2026-10-18
---
<!-- field:description -->
Review text is stored and rendered without output encoding. A logged-in customer
can store JavaScript that runs in the browser of every visitor of the product page.

<!-- field:proof_of_concept -->
Submitting the review `<img src=x onerror=alert(document.domain)>` triggers the payload.
Template payloads such as `{{7*7}}` are shown literally because code is never evaluated.

<!-- field:recommendation -->
Encode output according to the context (HTML, attribute, JavaScript) and deploy a
strict Content-Security-Policy.

<!-- field:retest_notes -->
The `<script>` tag is now filtered, but event handlers such as `onerror` are still
accepted. See also {{ report.client }}'s ticket SEC-142.
