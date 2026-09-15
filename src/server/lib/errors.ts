// Application errors -> RFC7807 problem+json (contract: Problem schema).
export type FieldError = { path: string; code: string; message: string };

export class AppError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public opts: {
      currentVersion?: number | null;
      retryable?: boolean;
      fieldErrors?: FieldError[];
    } = {},
  ) {
    super(message);
  }
}

export const E = {
  unauthenticated: (m = 'authentication required') =>
    new AppError('UNAUTHENTICATED', 401, m),
  forbidden: (m = 'forbidden') => new AppError('FORBIDDEN', 403, m),
  notFound: (m = 'not found') => new AppError('NOT_FOUND', 404, m),
  operatorRequired: () =>
    new AppError('OPERATOR_REQUIRED', 401, 'operator session required'),
  operatorChanged: (cur?: number | null) =>
    new AppError('OPERATOR_CHANGED', 409, 'operator changed on this device', {
      currentVersion: cur ?? null,
    }),
  deviceRevoked: () => new AppError('DEVICE_REVOKED', 403, 'device revoked'),
  versionConflict: (cur?: number | null) =>
    new AppError('VERSION_CONFLICT', 409, 'version conflict', {
      currentVersion: cur ?? null, retryable: true,
    }),
  alreadyDecided: () =>
    new AppError('ALREADY_DECIDED', 409, 'request already decided'),
  selfApproval: () =>
    new AppError('SELF_APPROVAL_DENIED', 403, 'cannot decide own request'),
  quotaExceeded: () =>
    new AppError('QUOTA_EXCEEDED', 409, 'quota exceeded', { retryable: false }),
  hardLimit: () =>
    new AppError('HARD_LIMIT_EXCEEDED', 409, 'hard limit exceeded'),
  identityRequired: () =>
    new AppError('IDENTITY_REQUIRED', 422, 'customer check required'),
  paymentRequired: () =>
    new AppError('PAYMENT_REQUIRED', 422, 'payment required'),
  entryCountExceeded: () =>
    new AppError('ENTRY_COUNT_EXCEEDED', 409, 'entry count exceeded'),
  idempotencyConflict: () =>
    new AppError('IDEMPOTENCY_CONFLICT', 409, 'idempotency key reused with different payload'),
  configIncomplete: (m = 'configuration incomplete') =>
    new AppError('CONFIG_INCOMPLETE', 422, m),
  previewStale: () =>
    new AppError('PREVIEW_STALE', 409, 'preview is stale', { retryable: true }),
  snapshotRequired: () =>
    new AppError('SNAPSHOT_REQUIRED', 410, 'snapshot required'),
  rateLimited: () =>
    new AppError('RATE_LIMITED', 429, 'rate limited', { retryable: true }),
  unavailable: () =>
    new AppError('SERVICE_UNAVAILABLE', 503, 'service unavailable', { retryable: true }),
  paymentPending: () =>
    new AppError('PAYMENT_PENDING_REVIEW', 409, 'payment pending review'),
  commandInProgress: () =>
    new AppError('COMMAND_IN_PROGRESS', 409, 'command in progress', { retryable: true }),
  tableUnavailable: () =>
    new AppError('TABLE_UNAVAILABLE', 409, 'table unavailable'),
  validation: (m: string, fields?: FieldError[]) =>
    new AppError('VALIDATION', 422, m,
      fields ? { fieldErrors: fields } : {}),
  invalid: (m = 'invalid request') => new AppError('VALIDATION', 422, m),
};
