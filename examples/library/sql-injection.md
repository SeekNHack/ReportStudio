---
title: SQL Injection
cvss: CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H
category: "CWE-89: SQL Injection"
references:
  - https://owasp.org/www-community/attacks/SQL_Injection
  - https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html
---
<!-- field:description -->
User input is concatenated into a SQL query without sanitisation, allowing an attacker
to modify the query.

<!-- field:impact -->
Depending on the database privileges: data disclosure, modification or deletion,
authentication bypass and, in some cases, command execution on the database server.

<!-- field:recommendation -->
Use parameterised queries for all database accesses, validate input against an
allow-list and run the database account with least privilege.
