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
    expectedRevision: { type: "string", minLength: 1, maxLength: 128 },
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
    expectedRevision: { type: "string", minLength: 1, maxLength: 128 },
    patch: {
      type: "object",
      properties: {
        method: {
          type: "string",
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
        endpoint: { type: "string", maxLength: 8192 },
        params: {
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
        body: {
          oneOf: [
            {
              type: "object",
              properties: {
                contentType: { type: "null" },
                body: { type: "null" },
              },
              required: ["contentType", "body"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                contentType: { type: "string", enum: textContentType.options },
                body: { type: "string", maxLength: 65536 },
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
    source: { type: "string", enum: ["request", "response"] },
    expectedRevision: { type: "string", minLength: 1, maxLength: 128 },
    partIndex: { type: "integer", minimum: 0, maximum: 65535 },
    offset: { type: "integer", minimum: 0, maximum: 2147483647, default: 0 },
    maxChars: { type: "integer", minimum: 1, maximum: 4096, default: 768 },
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
    maxChars: z.number().int().min(1).max(4096).default(768),
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
