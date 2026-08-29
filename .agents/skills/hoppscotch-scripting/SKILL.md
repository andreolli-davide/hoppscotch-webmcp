---
name: hoppscotch-scripting
description: >-
  Comprehensive guide and reference for writing Hoppscotch pre-request and post-request test scripts,
  assertions, variables resolution, sandbox Web APIs, and WebMCP scripting interactions.
---

# Hoppscotch Scripting & Variables Reference

Hoppscotch executes pre-request and post-request test scripts in an isolated browser JavaScript sandbox (`faraday-cage`).

---

## 1. Variables & Templating

### Template Syntax
* Use `<<variable_name>>` inside URLs, paths, query parameters, request headers, request bodies (JSON, XML, Form-Data, URL-encoded), and auth token fields.

### Variable Scopes & Hierarchy (Cascade Order)
When Hoppscotch resolves `<<var>>` or `pw.env.get("var")`, it checks scopes in the following precedence:
1. **Active Request Variables** (`requestVariables` local to the tab draft)
2. **Selected Environment Variables** (Active personal or team environment)
3. **Global Environment Variables**

### Variable Lifecycle
* `initialValue`: Shared default synced across workspace/team members.
* `currentValue`: Session-local value; modified dynamically at runtime by scripts (`pw.env.set`) without overwriting the shared baseline.
* `secret`: Masked/redacted from inspections, resolved safely at request execution time.

### Predefined (Dynamic) Variables — `$` Prefix
Hoppscotch provides built-in system-generated variables prefixed with `$`. They are resolved at request execution time and require **no prior definition** in any environment.

**Syntax in templates:** `<<$variableName>>` (wrapped in double angle brackets like all variables).

**Access in scripts:** `pw.env.get("$variableName")` returns the generated value.

| Variable | Description |
|---|---|
| **Common** | |
| `$guid` | A v4 style GUID |
| `$timestamp` | Current UNIX timestamp in seconds |
| `$isoTimestamp` | Current ISO timestamp at zero UTC |
| `$randomUUID` | A random 36-character UUID |
| **Text, Numbers & Colors** | |
| `$randomAlphaNumeric` | A random alphanumeric character |
| `$randomBoolean` | A random boolean value (`true`/`false`) |
| `$randomInt` | A random integer between 0 and 1000 |
| `$randomColor` | A random color name (e.g. `red`, `blue`) |
| `$randomHexColor` | A random hex color (e.g. `#a3f2c1`) |
| `$randomAbbreviation` | A random abbreviation (e.g. `JSON`, `API`) |
| **Internet & Network** | |
| `$randomIP` | A random IPv4 address |
| `$randomIPV6` | A random IPv6 address |
| `$randomMACAddress` | A random MAC address |
| `$randomPassword` | A random 15-character alphanumeric password |
| `$randomLocale` | A random two-letter language code (ISO 639-1) |
| `$randomUserAgent` | A random user agent string |
| `$randomProtocol` | A random internet protocol (`http` or `https`) |
| `$randomSemver` | A random semantic version number (e.g. `3.7.1`) |
| **Names** | |
| `$randomFirstName` | A random first name |
| `$randomLastName` | A random last name |
| `$randomFullName` | A random full name |
| `$randomNamePrefix` | A random name prefix (e.g. `Dr.`, `Ms.`) |
| `$randomNameSuffix` | A random name suffix (e.g. `PhD`, `Jr.`) |
| **Company** | |
| `$randomCompanyName` | A random company name |
| **Address** | |
| `$randomCity` | A random city name |
| **Profession** | |
| `$randomJobArea` | A random job area (e.g. `Development`, `Design`) |
| `$randomJobDescriptor` | A random job descriptor (e.g. `Senior`, `Lead`) |
| `$randomJobTitle` | A random job title |
| `$randomJobType` | A random job type (e.g. `Manager`, `Director`) |

---

## 2. Scripting Namespaces

### `pw` Namespace (Standard Hoppscotch API)
* **Environment Operations**:
  * `pw.env.get("key")` — Resolves variable through cascade (request → selected → global).
  * `pw.env.getResolve("key")` — Resolves nested `<<var>>` templates in variable value.
  * `pw.env.set("key", "value")` — Updates variable `currentValue` in active environment.
  * `pw.env.unset("key")` — Removes variable from active environment.
  * `pw.env.resolve("https://<<baseUrl>>/api")` — Interpolates all `<<var>>` occurrences in string.
  * `pw.getRequestVariable("key")` — Retrieves value of an active request variable.
* **Test Blocks & Assertions**:
  * `pw.test("Test name", () => { ... })`
  * `pw.expect(value).toBe(expected)`
  * `pw.expect(value).toEqual(expected)`
  * Status helpers: `.toBeLevel2xx()`, `.toBeLevel3xx()`, `.toBeLevel4xx()`, `.toBeLevel5xx()`, `.toBe(200)`
  * Type & property helpers: `.toBeType('string' | 'number' | 'boolean' | 'array' | 'object')`, `.toHaveProperty('id')`, `.toBeGreaterThan(n)`, `.toBeLessThan(n)`, `.toBeNull()`, `.toBeDefined()`, `.toInclude(item)`, `.toMatch(/regex/)`
  * Negation: `pw.expect(val).not.toBe(500)`
* **Response Object (`pw.response`)** (in post-request/test scripts):
  * `pw.response.status` — HTTP status code number (e.g. `200`)
  * `pw.response.headers` — Response headers array/dictionary
  * `pw.response.body` — Parsed JSON object (if JSON) or raw string
  * `pw.response.responseTime` — Duration in milliseconds

### `hopp` Namespace (Modern API)
* `hopp.env.get(key)` / `hopp.env.set(key, value)` / `hopp.env.delete(key)` / `hopp.env.reset(key)`
* `hopp.request` — Live getters for `url`, `method`, `params`, `headers`, `body`, `auth`
* `hopp.fetch(url, options)` — Async fetch hook to make sub-requests directly from scripts (e.g. OAuth token exchange).
* `hopp.test(...)` & `hopp.expect(...)`

### `pm` Namespace (Postman Compatibility)
* `pm.environment.get/set/unset`, `pm.variables.get/set`, `pm.response`, `pm.test`, `pm.expect`

---

## 3. Allowed Globals & Dependencies

* `console` (`log`, `warn`, `error`, `info`, `table`, `time`, `timeEnd`, `assert`, `dir`)
* `crypto` & `crypto.subtle` (random values, SHA-256/SHA-512 hashes, HMAC, AES encryption/decryption)
* `atob()` & `btoa()` (Base64 encoding/decoding)
* `TextEncoder` & `TextDecoder`
* `URL` & `URLSearchParams`
* `Blob`, `setTimeout()`, `clearTimeout()`, `fetch()`
* ESM imports: `import ... from "data:text/javascript,..."` or supported module URLs.

---

## 4. Sandbox Restrictions

* ❌ **No TypeScript syntax**: Scripts execute as pure ES6+ JavaScript. Type annotations (`let x: string`), `interface`, `type`, and `as ...` cast syntax cause syntax/validation errors.
* ❌ **No Node.js core APIs**: `fs`, `path`, `process`, `child_process`, `Buffer`, and `require()` are unavailable.
* ❌ **No shadowing reserved identifiers**: Do not declare variables named `pw`, `hopp`, `request`, or `response`.
