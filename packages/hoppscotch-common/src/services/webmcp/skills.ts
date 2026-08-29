export type SkillSummary = {
  name: string
  title: string
  description: string
  tags: string[]
}

export type SkillDetail = SkillSummary & {
  guide: string
  examples?: Array<{
    title: string
    code: string
  }>
}

export const SKILLS_CATALOG: Record<string, SkillDetail> = {
  "scripting-sandbox": {
    name: "scripting-sandbox",
    title: "Hoppscotch JavaScript Scripting Sandbox",
    description:
      "APIs (pw/hopp/pm), available Web globals, execution phases, and limitations for pre-request and test scripts.",
    tags: ["scripts", "sandbox", "pw", "hopp", "pm", "fetch", "crypto"],
    guide: [
      "Hoppscotch executes pre-request and post-request test scripts in an isolated JavaScript sandbox (ES6+).",
      "",
      "### Supported Namespaces",
      "- `pw`: Hoppscotch standard API",
      "  - `pw.env.get(key)`: Resolve variable value across request -> selected -> global cascade.",
      "  - `pw.env.getResolve(key)`: Resolve variable value with nested <<var>> interpolation.",
      "  - `pw.env.set(key, val)`: Set variable currentValue in active environment.",
      "  - `pw.env.unset(key)`: Unset variable from active environment.",
      "  - `pw.env.resolve(str)`: Interpolate all <<var>> templates within a string.",
      "  - `pw.getRequestVariable(key)`: Read active request variable.",
      "  - `pw.test(name, fn)`: Define an automated test block.",
      "  - `pw.expect(val)`: Chai-powered test assertions.",
      "  - `pw.response`: Response details { status, headers, body, responseTime }.",
      "- `hopp`: Modern API",
      "  - `hopp.env.get/set/delete/reset`, `hopp.env.getInitialRaw/setInitial`",
      "  - `hopp.request`: Live getters for url, method, params, headers, body, auth.",
      "  - `hopp.fetch(url, options)`: Built-in async fetch to make sub-requests inside scripts.",
      "  - `hopp.test(...)`, `hopp.expect(...)`",
      "- `pm`: Postman compatibility",
      "  - `pm.environment.get/set/unset`, `pm.variables.get/set`, `pm.response`, `pm.test`, `pm.expect`",
      "",
      "### Sandbox Globals & Web APIs",
      "- `console`: log, warn, error, info, table, time, timeEnd, assert, dir.",
      "- `crypto`: crypto.getRandomValues(), crypto.subtle (digest, importKey, encrypt, decrypt, sign, verify).",
      "- `atob()` & `btoa()`: Base64 encoding and decoding.",
      "- `TextEncoder` & `TextDecoder`: UTF-8 / binary string encoding.",
      "- `URL` & `URLSearchParams`: URL construction and parameter parsing.",
      "- `Blob`, `setTimeout()`, `clearTimeout()`, and `fetch()`.",
      "- ESM imports: `import ... from 'data:text/javascript,...'` or supported module URLs.",
      "",
      "### Strict Sandbox Rules & Hazards",
      "- Pure JavaScript: TypeScript syntax (type, interface, as Type, : string) is unsupported.",
      "- No Node.js core modules: fs, path, process, require() are unavailable.",
      "- Reserved identifiers: Never declare variables named pw, hopp, request, or response.",
    ].join("\n"),
    examples: [
      {
        title: "Pre-request: Dynamic HMAC / Timestamp Header",
        code: [
          "const timestamp = Date.now().toString();",
          "pw.env.set('TIMESTAMP', timestamp);",
          "const secret = pw.env.get('API_SECRET') || 'default_secret';",
          "const encoder = new TextEncoder();",
          "const keyData = encoder.encode(secret);",
          "const messageData = encoder.encode(timestamp);",
          "const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);",
          "const sigBuf = await crypto.subtle.sign('HMAC', key, messageData);",
          "const sigHex = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');",
          "pw.env.set('SIGNATURE', sigHex);",
        ].join("\n"),
      },
      {
        title: "Pre-request: Async Sub-Request with hopp.fetch",
        code: [
          "const res = await hopp.fetch('https://auth.example.com/oauth/token', {",
          "  method: 'POST',",
          "  headers: { 'Content-Type': 'application/json' },",
          "  body: JSON.stringify({ client_id: pw.env.get('CLIENT_ID'), client_secret: pw.env.get('CLIENT_SECRET') })",
          "});",
          "const data = await res.json();",
          "pw.env.set('ACCESS_TOKEN', data.access_token);",
        ].join("\n"),
      },
    ],
  },

  "variables-and-environments": {
    name: "variables-and-environments",
    title: "Hoppscotch Variables and Environments",
    description:
      "Template interpolation (<<var>>), resolution cascade hierarchy, and environment scopes.",
    tags: ["variables", "environments", "templating", "cascade", "secrets"],
    guide: [
      "### Variable Interpolation Syntax",
      "- Format: `<<variable_name>>`",
      "- Usable in: URL endpoints, path params, query params, headers, request bodies (JSON, XML, Form-Data, urlencoded), and authorization fields.",
      "",
      "### Resolution Precedence (Cascade Order)",
      "When Hoppscotch evaluates `<<var_name>>` or `pw.env.get('var_name')`, it checks scopes in this order:",
      "1. Active Request Variables (`requestVariables` local to the tab/draft)",
      "2. Selected Environment Variables (active personal or team environment)",
      "3. Global Environment Variables",
      "",
      "### Variable Lifecycle & Scopes",
      "- `initialValue`: Shared baseline persisted to the workspace / team.",
      "- `currentValue`: Session-local value; modified dynamically at runtime by scripts (`pw.env.set`) without altering the shared baseline.",
      "- `secret`: Masked/redacted from UI and WebMCP inspections, but resolved securely at execution time.",
    ].join("\n"),
    examples: [
      {
        title: "Using variables in REST requests",
        code: [
          "// Endpoint: https://<<baseUrl>>/v1/orders/<<orderId>>",
          "// Header: Authorization: Bearer <<accessToken>>",
          '// JSON Body: { "userId": "<<userId>>", "timestamp": <<timestamp>> }',
        ].join("\n"),
      },
      {
        title: "Reading and updating variables in scripts",
        code: [
          "// Read variable resolving hierarchy:",
          "const baseUrl = pw.env.get('baseUrl');",
          "",
          "// Update session-local environment variable:",
          "pw.env.set('lastCreatedId', '12345');",
          "",
          "// Interpolate a template string manually:",
          "const url = pw.env.resolve('https://<<baseUrl>>/api/<<version>>');",
        ].join("\n"),
      },
    ],
  },

  "test-assertions": {
    name: "test-assertions",
    title: "Hoppscotch Test Assertions and Response Validation",
    description:
      "Test blocks (pw.test), Chai-powered matchers (pw.expect), and response payload assertions.",
    tags: ["tests", "assertions", "expect", "status", "response", "chai"],
    guide: [
      "### Writing Tests",
      "Tests are written inside post-request test scripts using `pw.test(name, fn)` and `pw.expect(actual)`.",
      "",
      "### Response Object (`pw.response`)",
      "- `pw.response.status`: HTTP status code (number, e.g. 200, 201, 404).",
      "- `pw.response.headers`: Response headers array/map.",
      "- `pw.response.body`: Response body (parsed JSON object if JSON, or raw string).",
      "- `pw.response.responseTime`: Duration in milliseconds.",
      "",
      "### Matchers Reference",
      "- Status Codes: `.toBeLevel2xx()`, `.toBeLevel3xx()`, `.toBeLevel4xx()`, `.toBeLevel5xx()`, `.toBe(200)`",
      "- Equality: `.toBe(value)`, `.toEqual(value)`",
      "- Types: `.toBeType('string' | 'number' | 'boolean' | 'array' | 'object')`",
      "- Properties: `.toHaveProperty('key')`",
      "- Comparisons: `.toBeGreaterThan(n)`, `.toBeLessThan(n)`, `.toBeGreaterThanOrEqual(n)`",
      "- Nullability: `.toBeNull()`, `.toBeDefined()`, `.toBeUndefined()`",
      "- Arrays / Strings: `.toInclude(item)`, `.toContain(item)`, `.toMatch(/regex/)`",
      "- Negation: `.not.*` (e.g. `pw.expect(pw.response.status).not.toBe(500)`)",
    ].join("\n"),
    examples: [
      {
        title: "Standard REST API Test Suite",
        code: [
          "pw.test('Status code is 200 OK', () => {",
          "  pw.expect(pw.response.status).toBe(200);",
          "});",
          "",
          "pw.test('Response is valid JSON with required fields', () => {",
          "  const body = typeof pw.response.body === 'string' ? JSON.parse(pw.response.body) : pw.response.body;",
          "  pw.expect(body).toHaveProperty('id');",
          "  pw.expect(body.id).toBeType('string');",
          "  pw.expect(body.items).toBeType('array');",
          "  pw.expect(body.items.length).toBeGreaterThan(0);",
          "});",
          "",
          "pw.test('Response time is under 1000ms', () => {",
          "  pw.expect(pw.response.responseTime).toBeLessThan(1000);",
          "});",
        ].join("\n"),
      },
      {
        title: "Extracting Auth Token for Chained Requests",
        code: [
          "pw.test('Extract and persist token', () => {",
          "  pw.expect(pw.response.status).toBeLevel2xx();",
          "  const body = typeof pw.response.body === 'string' ? JSON.parse(pw.response.body) : pw.response.body;",
          "  pw.expect(body.token).toBeType('string');",
          "  pw.env.set('AUTH_TOKEN', body.token);",
          "});",
        ].join("\n"),
      },
    ],
  },

  "auth-configuration": {
    name: "auth-configuration",
    title: "Hoppscotch Authorization Configurations",
    description:
      "Configuring authentication modes (Bearer, Basic, OAuth 2, API Key, AWS Signature) with variable references.",
    tags: [
      "auth",
      "authorization",
      "bearer",
      "oauth",
      "basic",
      "apikey",
      "aws",
    ],
    guide: [
      "### Supported Authorization Modes",
      "- `inherit`: Inherit authorization settings from the parent collection.",
      "- `none`: No authorization.",
      "- `bearer`: Bearer token authorization (`token`).",
      "- `basic`: Basic authentication (`username`, `password`).",
      "- `oauth-2`: OAuth 2.0 (`grantType`, `token`, `clientID`, `clientSecret`, `authEndpoint`, `tokenEndpoint`).",
      "- `api-key`: API key in headers or query params (`key`, `value`, `addTo`).",
      "- `aws-signature`: AWS SigV4 (`accessKey`, `secretKey`, `region`, `serviceName`, `serviceToken`).",
      "- `hawk`: Hawk authentication (`authId`, `authKey`, `algorithm`).",
      "- `digest`: Digest access authentication.",
      "- `jwt`: JSON Web Token (`secret`, `privateKey`, `algorithm`, `payload`).",
      "",
      "### Variable References in Auth Tools",
      "- In `configure_rest_auth` / `configure_graphql_auth`: Supply variable names (e.g. `token: 'ACCESS_TOKEN'`).",
      "- In manual draft templates: Use `<<var_name>>` syntax (e.g. Bearer `<<ACCESS_TOKEN>>`).",
    ].join("\n"),
    examples: [
      {
        title: "Configuring Bearer Auth with Variable Reference",
        code: [
          "// Tool call: configure_rest_auth",
          "{",
          '  "expectedRevision": "rest-document:1",',
          '  "authType": "bearer",',
          '  "active": true,',
          '  "references": {',
          '    "token": "ACCESS_TOKEN"',
          "  }",
          "}",
        ].join("\n"),
      },
    ],
  },
}

export const listSkills = (): SkillSummary[] =>
  Object.values(SKILLS_CATALOG).map(({ name, title, description, tags }) => ({
    name,
    title,
    description,
    tags,
  }))

export const findSkill = (nameOrQuery: string): SkillDetail | null => {
  const normalized = nameOrQuery.trim().toLowerCase()
  if (SKILLS_CATALOG[normalized]) {
    return SKILLS_CATALOG[normalized]
  }
  return (
    Object.values(SKILLS_CATALOG).find(
      (s) =>
        s.name.toLowerCase() === normalized ||
        s.title.toLowerCase().includes(normalized) ||
        s.tags.some((t) => t.toLowerCase() === normalized)
    ) ?? null
  )
}
