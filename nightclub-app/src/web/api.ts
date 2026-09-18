// Thin API client. The operator session id is sent on every request via
// x-operator-context so stale tabs fail with OPERATOR_CHANGED.
export function opSession(): string | null {
  return sessionStorage.getItem('nc_op_session');
}
export function setOpSession(id: string | null) {
  if (id) sessionStorage.setItem('nc_op_session', id);
  else sessionStorage.removeItem('nc_op_session');
}

export class ApiError extends Error {
  constructor(public status: number, public body: { error?: { code?: string; message?: string } } | null) {
    super(body?.error?.message || `HTTP ${status}`);
  }
  get code() { return this.body?.error?.code || `HTTP_${this.status}`; }
}

export async function call<T = Record<string, unknown>>(
  method: string, url: string, body?: unknown, opts: { idem?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idem) headers['idempotency-key'] = opts.idem;
  const op = opSession();
  if (op) headers['x-operator-context'] = op;
  const res = await fetch(`/api${url}`, {
    method, headers,
    body: body === undefined ? null : JSON.stringify(body),
    credentials: 'include',
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json as never);
  return json as T;
}

export const uuid = () => crypto.randomUUID();
