import type { ErrorBody } from '../../../src/api/types.ts';

export type * from '../../../src/api/types.ts';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** One API call: JSON in and out, an ApiError for any error status. */
export async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    // Every write sends JSON: the server refuses a write without it.
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new ApiError(res.status, (data as ErrorBody | null)?.error?.message ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const get = <T>(path: string) => call<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => call<T>('POST', path, body);
export const put = <T>(path: string, body?: unknown) => call<T>('PUT', path, body);
export const del = <T>(path: string) => call<T>('DELETE', path);

/** The message of any thrown value. */
export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
