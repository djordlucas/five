import type { ErrorBody, WorkspaceEntry } from '../../../src/api/types.ts';

export type * from '../../../src/api/types.ts';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** One API call: JSON in and out, an ApiError for any error status. */
export async function call<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    // Every write sends JSON: the server refuses a write without it.
    headers: method === 'GET' ? headers : { ...headers, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return parse<T>(res);
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: the status says what went wrong.
  }
  if (!res.ok) throw new ApiError(res.status, (data as ErrorBody | null)?.error?.message ?? `${res.status} ${res.statusText}`);
  return data as T;
}

/** A workspace file: its bytes and version; null when there is none. */
export async function readFile(
  path: string,
): Promise<{ buf: ArrayBuffer; version: string | null; modified: string | null } | null> {
  const res = await fetch(`/api/v1/workspace/file?path=${encodeURIComponent(path)}`);
  if (res.status === 404) return null;
  if (!res.ok) await parse(res);
  return { buf: await res.arrayBuffer(), version: res.headers.get('etag'), modified: res.headers.get('last-modified') };
}

/**
 * Write a workspace file. With ifVersion, only if it is still that version
 * ("" for a file that must not exist yet); otherwise 409.
 */
export async function writeFile(path: string, body: Blob | string, ifVersion?: string): Promise<WorkspaceEntry> {
  const res = await fetch(`/api/v1/workspace/file?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      ...(ifVersion !== undefined && { 'if-match': `"${ifVersion}"` }),
    },
    body,
  });
  return parse<WorkspaceEntry>(res);
}

export const get = <T>(path: string) => call<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => call<T>('POST', path, body);
export const put = <T>(path: string, body?: unknown) => call<T>('PUT', path, body);
export const del = <T>(path: string, headers?: Record<string, string>) => call<T>('DELETE', path, undefined, headers);

/** The message of any thrown value. */
export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
