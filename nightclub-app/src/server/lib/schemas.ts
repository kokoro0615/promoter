// Shared JSON Schema fragments for Fastify route validation (ajv, bundled).
// Fastify's ajv runs with removeAdditional, so `additionalProperties:false`
// acts as a strict allowlist: undeclared fields are stripped before the
// handler sees them — declare every field the handler reads.
export const uuid = { type: 'string', format: 'uuid' } as const;
export const isoTs = { type: 'string', format: 'date-time' } as const;
export const minor = { type: 'integer', minimum: 0 } as const;
export const posMinor = { type: 'integer', minimum: 1 } as const;
export const str = (maxLength = 500) => ({ type: 'string', maxLength } as const);
export const bool = { type: 'boolean' } as const;
export const int = { type: 'integer' } as const;
export const cursor = { type: 'string', pattern: '^[0-9]+$', maxLength: 24 } as const;
export const version = { type: 'integer', minimum: 0 } as const;

// Route params: every :xxxId segment in this API is a uuid.
export const params = (names: Record<string, unknown>) =>
  ({ type: 'object', properties: names, required: Object.keys(names) } as const);
export const storeParam = params({ storeId: uuid });
export const eventParams = params({ storeId: uuid, eventId: uuid });
export const eventChild = (name: string) =>
  params({ storeId: uuid, eventId: uuid, [name]: uuid });

export const body = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: 'object', properties, required, additionalProperties: false,
} as const);

export const query = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: 'object', properties, required } as const);
