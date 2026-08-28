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
