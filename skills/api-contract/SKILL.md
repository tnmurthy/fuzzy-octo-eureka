---
name: api-contract
description: Best practices for clean, predictable, idempotent REST APIs and HTTP status codes.
triggers: [api, rest, endpoint, route, http, json, request, response]
file_patterns: ["*server*.js", "*routes*.js", "*api*.js"]
---

# REST API Contract Principles

## Core Principles
1. Standard Status Codes:
   - 200 OK for successful reads/updates returning body.
   - 201 Created for resource generation.
   - 400 Bad Request for validation errors.
   - 403 Forbidden for auth/permission denials.
   - 404 Not Found for missing entities.
2. Structured JSON Envelopes:
   - Always return `{ ok: true, ... }` or `{ ok: false, error: "..." }`.
3. Input Sanitization:
   - Enforce explicit limits on payload size and string lengths.
4. Idempotency:
   - Support retry-safe endpoints using unique client tokens.
