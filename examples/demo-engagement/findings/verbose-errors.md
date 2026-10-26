---
title: Verbose error messages
severity: info
category: "CWE-209: Information Exposure Through an Error Message"
retest_status: not_tested
---
<!-- field:description -->
Stack traces are returned for malformed requests and disclose framework versions.

<!-- field:recommendation -->
Return generic error messages in production.
