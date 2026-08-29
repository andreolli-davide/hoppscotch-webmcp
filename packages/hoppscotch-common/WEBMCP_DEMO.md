# WebMCP REST workspace demo

The WebMCP integration is an experimental progressive enhancement and is off by
default. It exposes the live Hoppscotch app context and the visible REST request
editor; it does not start an MCP server or expose saved resources.

## Browser profile

- Chrome 153 or newer.
- A secure or localhost Hoppscotch origin that does not use `document.domain`.
- `Permissions-Policy: tools=(self)` and `Origin-Agent-Cluster: ?1`. The bundled
  self-host Caddy configurations set both headers.
- The Model Context Tool Inspector extension from the Chrome Web Store.

For local development, enable
`chrome://flags/#enable-webmcp-testing`, relaunch Chrome, and start Hoppscotch
with `VITE_ENABLE_WEBMCP=true`. An experimental production origin must also be
enrolled in the applicable Chrome origin trial and serve its token using the
deployment's normal header or meta-tag mechanism.

## Preflight

Open the REST editor and verify in DevTools:

```js
document.modelContext !== undefined
await document.modelContext
  .getTools()
  .then((tools) => tools.map(({ name }) => name))
```

The REST editor returns:

- context and environment tools: `inspect_app_context`, `list_environments`,
  `inspect_environment`, and `select_environment`;
- REST observation/execution tools: `inspect_rest_exchange`,
  `read_rest_payload`, `edit_rest_request`, and `execute_rest_request`;
- narrow draft extensions: `configure_rest_auth`, `edit_rest_variables`, and
  `edit_rest_scripts`.

On other routes, only `inspect_app_context` remains. Authorization tools accept
environment variable names and store `<<VARIABLE>>` references; they do not
accept raw credential fields.

## Acceptance walkthrough

1. Make an unsaved REST edit and ask the Inspector agent to describe the current
   Hoppscotch context and diagnose the exchange.
2. Ask it to change an allow-listed draft field. Confirm that the editor updates,
   becomes dirty, and does not save.
3. Ask it to execute the request. Hoppscotch must show its own revision-bound
   approval dialog before scripts or network work starts.
4. Confirm the ordinary response viewer and tests update, and the tool returns the
   completed redacted projection.
5. Make another human edit, then manually retry the old mutation input. It must
   return `STATE_CHANGED` without modifying the request.
6. Navigate to GraphQL, realtime, settings, and a shared-request URL and confirm
   the REST tools are unregistered.

For the extended REST walkthrough, list environments and select one using its
opaque handle, then configure a bearer or API-key reference. Edit request
variables or either script and confirm each change is visible, dirty, undoable,
and rejected when called again with a stale revision. Script text must not run
until the separately approved `execute_rest_request` call.

Do not use real credentials in demo payloads. Hoppscotch redacts credentials it
manages or structurally recognizes, but cannot classify every arbitrary secret
typed into unstructured URL or body text.
