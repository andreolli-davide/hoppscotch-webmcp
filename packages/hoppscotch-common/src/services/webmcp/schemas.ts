import { z } from "zod"

const keyValue = z
  .object({
    key: z.string().max(256),
    value: z.string().max(8192),
    active: z.boolean(),
  })
  .strict()

const textContentType = z.enum([
  "application/json",
  "application/ld+json",
  "application/hal+json",
  "application/vnd.api+json",
  "application/xml",
  "text/xml",
  "application/x-www-form-urlencoded",
  "text/html",
  "text/plain",
])

export const emptyInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

export const expectedRevisionSchema = {
  type: "object",
  properties: {
    expectedRevision: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description:
        "Revision token returned by the latest inspection for the active REST document.",
    },
  },
  required: ["expectedRevision"],
  additionalProperties: false,
} as const

export const requestPatchSchema = z
  .object({
    method: z
      .enum([
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "HEAD",
        "OPTIONS",
        "CONNECT",
        "TRACE",
        "CUSTOM",
      ])
      .optional(),
    endpoint: z.string().max(8192).optional(),
    params: z.array(keyValue).max(100).optional(),
    headers: z.array(keyValue).max(100).optional(),
    body: z
      .union([
        z.object({ contentType: z.null(), body: z.null() }).strict(),
        z
          .object({
            contentType: textContentType,
            body: z.string().max(65536),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "Patch cannot be empty")

export const editRESTRequestInputSchema = {
  type: "object",
  properties: {
    expectedRevision: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description:
        "Revision token returned by the latest inspection for the active REST document.",
    },
    patch: {
      type: "object",
      description:
        "Allow-listed draft fields to replace in the visible REST request.",
      properties: {
        method: {
          type: "string",
          description: "HTTP method for the draft request.",
          enum: [
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "HEAD",
            "OPTIONS",
            "CONNECT",
            "TRACE",
            "CUSTOM",
          ],
        },
        endpoint: {
          type: "string",
          maxLength: 8192,
          description: "Request URL or URL template.",
        },
        params: {
          type: "array",
          maxItems: 100,
          description: "Query parameters for the draft request.",
          items: {
            type: "object",
            description: "One query parameter entry.",
            properties: {
              key: {
                type: "string",
                maxLength: 256,
                description: "Query parameter name.",
              },
              value: {
                type: "string",
                maxLength: 8192,
                description: "Query parameter value or template.",
              },
              active: {
                type: "boolean",
                description:
                  "Whether the parameter is included in the request.",
              },
            },
            required: ["key", "value", "active"],
            additionalProperties: false,
          },
        },
        headers: {
          type: "array",
          maxItems: 100,
          description: "Headers for the draft request.",
          items: {
            type: "object",
            description: "One request header entry.",
            properties: {
              key: {
                type: "string",
                maxLength: 256,
                description: "HTTP header name.",
              },
              value: {
                type: "string",
                maxLength: 8192,
                description: "HTTP header value or template.",
              },
              active: {
                type: "boolean",
                description: "Whether the header is included in the request.",
              },
            },
            required: ["key", "value", "active"],
            additionalProperties: false,
          },
        },
        body: {
          description: "Text or empty body for the draft request.",
          oneOf: [
            {
              type: "object",
              description: "Empty request body.",
              properties: {
                contentType: {
                  type: "null",
                  description: "Empty body content type.",
                },
                body: { type: "null", description: "Empty body value." },
              },
              required: ["contentType", "body"],
              additionalProperties: false,
            },
            {
              type: "object",
              description: "Text request body.",
              properties: {
                contentType: {
                  type: "string",
                  enum: textContentType.options,
                  description: "MIME type for the text body.",
                },
                body: {
                  type: "string",
                  maxLength: 65536,
                  description: "Text body content or template.",
                },
              },
              required: ["contentType", "body"],
              additionalProperties: false,
            },
          ],
        },
      },
      additionalProperties: false,
    },
  },
  required: ["expectedRevision", "patch"],
  additionalProperties: false,
} as const

export const readRESTPayloadInputSchema = {
  type: "object",
  properties: {
    source: {
      type: "string",
      enum: ["request", "response"],
      description: "Payload source to read from the visible REST exchange.",
    },
    expectedRevision: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description:
        "Revision token for the selected request or response payload.",
    },
    partIndex: {
      type: "integer",
      minimum: 0,
      maximum: 65535,
      description:
        "Multipart part index when reading a multipart request body.",
    },
    offset: {
      type: "integer",
      minimum: 0,
      maximum: 2147483647,
      default: 0,
      description: "Character or byte offset for the bounded payload window.",
    },
    maxChars: {
      type: "integer",
      minimum: 1,
      maximum: 768,
      default: 384,
      description: "Maximum text characters to return in the payload window.",
    },
  },
  required: ["source", "expectedRevision"],
  additionalProperties: false,
} as const

export const readRESTPayloadParser = z
  .object({
    source: z.enum(["request", "response"]),
    expectedRevision: z.string().min(1).max(128),
    partIndex: z.number().int().min(0).max(65535).optional(),
    offset: z.number().int().min(0).max(2147483647).default(0),
    maxChars: z.number().int().min(1).max(768).default(384),
  })
  .strict()

export const editRESTRequestParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    patch: requestPatchSchema,
  })
  .strict()

export const executeRESTRequestParser = z
  .object({ expectedRevision: z.string().min(1).max(128) })
  .strict()

const revisionProperty = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  description: "Revision token returned by the latest matching inspection.",
} as const

const environmentReference = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^<>\r\n]+$/, "Use an environment variable name, not a value")

const authReferenceFields = [
  "username",
  "password",
  "token",
  "key",
  "value",
  "accessKey",
  "secretKey",
  "region",
  "serviceName",
  "serviceToken",
  "authId",
  "authKey",
  "secret",
  "privateKey",
  "clientID",
  "clientSecret",
] as const

const authTypes = [
  "inherit",
  "none",
  "basic",
  "digest",
  "bearer",
  "oauth-2",
  "api-key",
  "aws-signature",
  "hawk",
  "jwt",
] as const

export const configureRESTAuthParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    authType: z.enum(authTypes),
    active: z.boolean(),
    placement: z.enum(["HEADERS", "QUERY_PARAMS"]).optional(),
    references: z
      .object(
        Object.fromEntries(
          authReferenceFields.map((field) => [
            field,
            environmentReference.optional(),
          ])
        ) as Record<
          (typeof authReferenceFields)[number],
          z.ZodOptional<typeof environmentReference>
        >
      )
      .strict()
      .optional(),
  })
  .strict()

const authReferenceProperties = Object.fromEntries(
  authReferenceFields.map((field) => [
    field,
    {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[^<>\\r\\n]+$",
      description: `Environment variable name for ${field}.`,
    },
  ])
)

export const configureRESTAuthInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    authType: {
      type: "string",
      enum: authTypes,
      description: "Supported authorization mode for the visible draft.",
    },
    active: {
      type: "boolean",
      description: "Whether authorization is enabled for execution.",
    },
    placement: {
      type: "string",
      enum: ["HEADERS", "QUERY_PARAMS"],
      description:
        "Credential placement for authorization modes that support it.",
    },
    references: {
      type: "object",
      description: "Credential fields mapped to environment variable names.",
      properties: authReferenceProperties,
      additionalProperties: false,
    },
  },
  required: ["expectedRevision", "authType", "active"],
  additionalProperties: false,
} as const

const restVariable = z
  .object({
    key: z.string().min(1).max(256),
    value: z.string().max(8192),
    active: z.boolean(),
  })
  .strict()

export const editRESTVariablesParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    variables: z.array(restVariable).max(50),
  })
  .strict()

export const editRESTVariablesInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    variables: {
      type: "array",
      maxItems: 50,
      description: "Complete replacement set for active-request variables.",
      items: {
        type: "object",
        properties: {
          key: { type: "string", minLength: 1, maxLength: 256 },
          value: { type: "string", maxLength: 8192 },
          active: { type: "boolean" },
        },
        required: ["key", "value", "active"],
        additionalProperties: false,
      },
    },
  },
  required: ["expectedRevision", "variables"],
  additionalProperties: false,
} as const

export const editRESTScriptsParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    target: z.enum(["pre_request", "post_request"]),
    script: z.string().max(32768),
  })
  .strict()

export const editRESTScriptsInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    target: {
      type: "string",
      enum: ["pre_request", "post_request"],
      description: "Pre-request script or post-request test script.",
    },
    script: {
      type: "string",
      maxLength: 32768,
      description:
        "Complete replacement script text for a separately approved request execution.",
    },
  },
  required: ["expectedRevision", "target", "script"],
  additionalProperties: false,
} as const

const jsonPointerOperation = z
  .object({
    op: z.enum(["add", "replace", "remove"]),
    path: z.string().max(2048),
    value: z.unknown().optional(),
  })
  .strict()

const bodyEntry = z
  .object({
    key: z.string().max(256),
    value: z.string().max(8192),
    active: z.boolean(),
  })
  .strict()

export const editRESTBodyParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    operation: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("replace_document"), document: z.unknown() })
        .strict(),
      z
        .object({
          kind: z.literal("json_pointer"),
          operations: z.array(jsonPointerOperation).min(1).max(50),
        })
        .strict(),
      z
        .object({
          kind: z.literal("set_urlencoded_entries"),
          entries: z.array(bodyEntry).max(100),
        })
        .strict(),
      z
        .object({
          kind: z.literal("set_multipart_text_entries"),
          entries: z.array(bodyEntry).max(100),
        })
        .strict(),
    ]),
  })
  .strict()

export const editRESTBodyInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    operation: {
      oneOf: [
        {
          type: "object",
          properties: { kind: { const: "replace_document" }, document: {} },
          required: ["kind", "document"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { const: "json_pointer" },
            operations: { type: "array", minItems: 1, maxItems: 50 },
          },
          required: ["kind", "operations"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { const: "set_urlencoded_entries" },
            entries: { type: "array", maxItems: 100 },
          },
          required: ["kind", "entries"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { const: "set_multipart_text_entries" },
            entries: { type: "array", maxItems: 100 },
          },
          required: ["kind", "entries"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["expectedRevision", "operation"],
  additionalProperties: false,
} as const

export const readRESTScriptParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    sourceHandle: z.string().min(1).max(128),
    offset: z.number().int().min(0).max(32768).default(0),
    maxChars: z.number().int().min(1).max(768).default(384),
  })
  .strict()

export const readRESTScriptInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    sourceHandle: { type: "string", minLength: 1, maxLength: 128 },
    offset: { type: "integer", minimum: 0, maximum: 32768, default: 0 },
    maxChars: { type: "integer", minimum: 1, maximum: 768, default: 384 },
  },
  required: ["expectedRevision", "sourceHandle"],
  additionalProperties: false,
} as const

export const inspectEnvironmentParser = z
  .object({ referencedOnly: z.boolean().default(false) })
  .strict()

export const inspectEnvironmentInputSchema = {
  type: "object",
  properties: {
    referencedOnly: {
      type: "boolean",
      default: false,
      description:
        "Filter the result to selected-environment variables referenced by the visible request.",
    },
  },
  additionalProperties: false,
} as const

export const listEnvironmentsParser = z
  .object({ offset: z.number().int().min(0).max(2147483647).default(0) })
  .strict()

export const listEnvironmentsInputSchema = {
  type: "object",
  properties: {
    offset: {
      type: "integer",
      minimum: 0,
      maximum: 2147483647,
      default: 0,
      description:
        "Environment-list offset returned as nextOffset by the previous page.",
    },
  },
  additionalProperties: false,
} as const

export const selectEnvironmentParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    environmentHandle: z.string().min(1).max(128),
  })
  .strict()

export const selectEnvironmentInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    environmentHandle: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "Opaque handle returned by list_environments.",
    },
  },
  required: ["expectedRevision", "environmentHandle"],
  additionalProperties: false,
} as const

const gqlHeader = z
  .object({
    key: z.string().max(256),
    value: z.string().max(8192),
    active: z.boolean(),
  })
  .strict()

export const editGraphQLOperationParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    patch: z
      .object({
        endpoint: z.string().max(8192).optional(),
        query: z.string().max(65536).optional(),
        variables: z.string().max(65536).optional(),
        headers: z.array(gqlHeader).max(100).optional(),
      })
      .strict()
      .refine(
        (patch) => Object.keys(patch).length > 0,
        "Patch cannot be empty"
      ),
  })
  .strict()

export const editGraphQLOperationInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    patch: {
      type: "object",
      properties: {
        endpoint: { type: "string", maxLength: 8192 },
        query: { type: "string", maxLength: 65536 },
        variables: { type: "string", maxLength: 65536 },
        headers: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              key: { type: "string", maxLength: 256 },
              value: { type: "string", maxLength: 8192 },
              active: { type: "boolean" },
            },
            required: ["key", "value", "active"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  required: ["expectedRevision", "patch"],
  additionalProperties: false,
} as const

export const editGraphQLVariablesParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    operation: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("replace_document"), document: z.unknown() })
        .strict(),
      z
        .object({
          kind: z.literal("json_pointer"),
          operations: z.array(jsonPointerOperation).min(1).max(50),
        })
        .strict(),
    ]),
  })
  .strict()

export const editGraphQLVariablesInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    operation: { type: "object" },
  },
  required: ["expectedRevision", "operation"],
  additionalProperties: false,
} as const

export const graphqlPayloadParser = z
  .object({
    source: z.enum(["query", "variables", "response"]),
    expectedRevision: z.string().min(1).max(128),
    offset: z.number().int().min(0).max(2147483647).default(0),
    maxChars: z.number().int().min(1).max(768).default(384),
  })
  .strict()

export const graphqlPayloadInputSchema = {
  type: "object",
  properties: {
    source: { type: "string", enum: ["query", "variables", "response"] },
    expectedRevision: revisionProperty,
    offset: { type: "integer", minimum: 0, maximum: 2147483647, default: 0 },
    maxChars: { type: "integer", minimum: 1, maximum: 768, default: 384 },
  },
  required: ["source", "expectedRevision"],
  additionalProperties: false,
} as const

export const graphqlSchemaSearchParser = z
  .object({ query: z.string().min(1).max(128) })
  .strict()

export const graphqlSchemaSearchInputSchema = {
  type: "object",
  properties: { query: { type: "string", minLength: 1, maxLength: 128 } },
  required: ["query"],
  additionalProperties: false,
} as const

type RealtimeSchemaMode = "websocket" | "socketio" | "sse" | "mqtt"

const nonEmptyPatch = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .strict()
    .refine((patch) => Object.keys(patch).length > 0, "Patch cannot be empty")

const realtimePatchParsers = {
  websocket: nonEmptyPatch({
    endpoint: z.string().max(8192).optional(),
    protocols: z
      .array(
        z.object({ value: z.string().max(256), active: z.boolean() }).strict()
      )
      .max(32)
      .optional(),
  }),
  socketio: nonEmptyPatch({
    endpoint: z.string().max(8192).optional(),
    path: z.string().max(512).optional(),
    version: z.enum(["v2", "v3", "v4"]).optional(),
    auth: z
      .object({
        authType: z.enum(["None", "Bearer"]).optional(),
        bearerToken: z.string().max(4096).optional(),
        authActive: z.boolean().optional(),
      })
      .strict()
      .optional(),
  }),
  sse: nonEmptyPatch({
    endpoint: z.string().max(8192).optional(),
    eventType: z.string().max(256).optional(),
  }),
  mqtt: nonEmptyPatch({
    endpoint: z.string().max(8192).optional(),
    clientID: z.string().max(256).optional(),
    username: z.string().max(512).optional(),
    password: z.string().max(4096).optional(),
    keepAlive: z.string().max(32).optional(),
    cleanSession: z.boolean().optional(),
    lwTopic: z.string().max(512).optional(),
    lwMessage: z.string().max(4096).optional(),
    lwQos: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    lwRetain: z.boolean().optional(),
  }),
} as const

export const editRealtimeSessionParser = (mode: RealtimeSchemaMode) =>
  z
    .object({
      expectedRevision: z.string().min(1).max(128),
      patch: realtimePatchParsers[mode],
    })
    .strict()

const realtimePatchInputSchemas = {
  websocket: {
    type: "object",
    properties: {
      endpoint: { type: "string", maxLength: 8192 },
      protocols: {
        type: "array",
        maxItems: 32,
        items: {
          type: "object",
          properties: {
            value: { type: "string", maxLength: 256 },
            active: { type: "boolean" },
          },
          required: ["value", "active"],
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  socketio: {
    type: "object",
    properties: {
      endpoint: { type: "string", maxLength: 8192 },
      path: { type: "string", maxLength: 512 },
      version: { type: "string", enum: ["v2", "v3", "v4"] },
      auth: {
        type: "object",
        properties: {
          authType: { type: "string", enum: ["None", "Bearer"] },
          bearerToken: { type: "string", maxLength: 4096 },
          authActive: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  sse: {
    type: "object",
    properties: {
      endpoint: { type: "string", maxLength: 8192 },
      eventType: { type: "string", maxLength: 256 },
    },
    additionalProperties: false,
  },
  mqtt: {
    type: "object",
    properties: {
      endpoint: { type: "string", maxLength: 8192 },
      clientID: { type: "string", maxLength: 256 },
      username: { type: "string", maxLength: 512 },
      password: { type: "string", maxLength: 4096 },
      keepAlive: { type: "string", maxLength: 32 },
      cleanSession: { type: "boolean" },
      lwTopic: { type: "string", maxLength: 512 },
      lwMessage: { type: "string", maxLength: 4096 },
      lwQos: { type: "integer", enum: [0, 1, 2] },
      lwRetain: { type: "boolean" },
    },
    additionalProperties: false,
  },
} as const

export const editRealtimeSessionInputSchema = (mode: RealtimeSchemaMode) => ({
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    patch: realtimePatchInputSchemas[mode],
  },
  required: ["expectedRevision", "patch"],
  additionalProperties: false,
})

export const realtimeMessageParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    message: z.string().min(1).max(65536),
    eventName: z.string().max(256).default(""),
    format: z.enum(["text", "json"]).default("text"),
  })
  .strict()

export const realtimeMessageInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    message: { type: "string", minLength: 1, maxLength: 65536 },
    eventName: { type: "string", maxLength: 256, default: "" },
    format: { type: "string", enum: ["text", "json"], default: "text" },
  },
  required: ["expectedRevision", "message"],
  additionalProperties: false,
} as const

export const mqttTopicParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    topic: z.string().min(1).max(512),
    message: z.string().max(65536).optional(),
    qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
    format: z.enum(["text", "json"]).default("text"),
  })
  .strict()

export const mqttTopicInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    topic: { type: "string", minLength: 1, maxLength: 512 },
    message: { type: "string", maxLength: 65536 },
    qos: { type: "integer", enum: [0, 1, 2], default: 0 },
    format: { type: "string", enum: ["text", "json"], default: "text" },
  },
  required: ["expectedRevision", "topic"],
  additionalProperties: false,
} as const

export const realtimeLogParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    offset: z.number().int().min(0).max(2147483647).default(0),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict()

export const realtimeLogInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    offset: { type: "integer", minimum: 0, maximum: 2147483647, default: 0 },
    limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
  },
  required: ["expectedRevision"],
  additionalProperties: false,
} as const

export const switchTabParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    tabID: z.string().min(1).max(128),
  })
  .strict()

export const switchTabInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    tabID: { type: "string", minLength: 1, maxLength: 128 },
  },
  required: ["expectedRevision", "tabID"],
  additionalProperties: false,
} as const

export const createTabParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    name: z.string().max(256).optional(),
  })
  .strict()

export const createTabInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    name: { type: "string", maxLength: 256 },
  },
  required: ["expectedRevision"],
  additionalProperties: false,
} as const

export const closeTabParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    tabID: z.string().min(1).max(128),
    force: z.boolean().default(false),
  })
  .strict()

export const closeTabInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    tabID: { type: "string", minLength: 1, maxLength: 128 },
    force: { type: "boolean", default: false },
  },
  required: ["expectedRevision", "tabID"],
  additionalProperties: false,
} as const

export const inspectCollectionParser = z
  .object({
    path: z.string().min(1).max(256),
  })
  .strict()

export const inspectCollectionInputSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, maxLength: 256 },
  },
  required: ["path"],
  additionalProperties: false,
} as const

export const saveRequestToCollectionParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    collectionPath: z.string().max(256).optional(),
    name: z.string().max(256).optional(),
  })
  .strict()

export const saveRequestToCollectionInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    collectionPath: { type: "string", maxLength: 256 },
    name: { type: "string", maxLength: 256 },
  },
  required: ["expectedRevision"],
  additionalProperties: false,
} as const

export const listHistoryParser = z
  .object({
    limit: z.number().int().min(1).max(50).default(10),
    offset: z.number().int().min(0).default(0),
  })
  .strict()

export const listHistoryInputSchema = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    offset: { type: "integer", minimum: 0, default: 0 },
  },
  additionalProperties: false,
} as const

export const loadHistoryEntryParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    index: z.number().int().min(0),
    targetTab: z.enum(["current", "new"]).default("current"),
  })
  .strict()

export const loadHistoryEntryInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    index: { type: "integer", minimum: 0 },
    targetTab: { type: "string", enum: ["current", "new"], default: "current" },
  },
  required: ["expectedRevision", "index"],
  additionalProperties: false,
} as const

export const switchWorkspaceParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    workspaceID: z.string().min(1).max(128),
  })
  .strict()

export const switchWorkspaceInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    workspaceID: { type: "string", minLength: 1, maxLength: 128 },
  },
  required: ["expectedRevision", "workspaceID"],
  additionalProperties: false,
} as const

export const runCollectionParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    collectionPath: z.string().max(256).optional(),
    collectionID: z.string().max(256).optional(),
    delay: z.number().int().min(0).max(10000).default(0),
    stopOnError: z.boolean().default(false),
    persistResponses: z.boolean().default(false),
    keepVariableValues: z.boolean().default(true),
  })
  .strict()

export const runCollectionInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    collectionPath: { type: "string", maxLength: 256 },
    collectionID: { type: "string", maxLength: 256 },
    delay: { type: "integer", minimum: 0, maximum: 10000, default: 0 },
    stopOnError: { type: "boolean", default: false },
    persistResponses: { type: "boolean", default: false },
    keepVariableValues: { type: "boolean", default: true },
  },
  required: ["expectedRevision"],
  additionalProperties: false,
} as const

export const deleteCollectionParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    collectionPath: z.string().min(1).max(256),
    confirmationName: z.string().min(1).max(256),
  })
  .strict()

export const deleteCollectionInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    collectionPath: { type: "string", minLength: 1, maxLength: 256 },
    confirmationName: { type: "string", minLength: 1, maxLength: 256 },
  },
  required: ["expectedRevision", "collectionPath", "confirmationName"],
  additionalProperties: false,
} as const

export const deleteFolderParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    folderPath: z.string().min(1).max(256),
    confirmationName: z.string().min(1).max(256),
  })
  .strict()

export const deleteFolderInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    folderPath: { type: "string", minLength: 1, maxLength: 256 },
    confirmationName: { type: "string", minLength: 1, maxLength: 256 },
  },
  required: ["expectedRevision", "folderPath", "confirmationName"],
  additionalProperties: false,
} as const

export const deleteEnvironmentParser = z
  .object({
    expectedRevision: z.string().min(1).max(128),
    environmentIndex: z.number().int().min(0),
    confirmationName: z.string().min(1).max(256),
  })
  .strict()

export const deleteEnvironmentInputSchema = {
  type: "object",
  properties: {
    expectedRevision: revisionProperty,
    environmentIndex: { type: "integer", minimum: 0 },
    confirmationName: { type: "string", minLength: 1, maxLength: 256 },
  },
  required: ["expectedRevision", "environmentIndex", "confirmationName"],
  additionalProperties: false,
} as const


