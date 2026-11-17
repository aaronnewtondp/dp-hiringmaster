// Maps an error that reached the server's last error handler to an HTTP answer. See the comment above the handler in server.ts.
export function errorResponseFor(err: unknown): { status: number; error: string } {
  const e = (err ?? {}) as { code?: unknown; status?: unknown; statusCode?: unknown; type?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  if (['23514', '22P02', '22003', '22001', '22007', '22008'].includes(code)) return { status: 400, error: 'One of the submitted values is missing, the wrong type, or not allowed.' };
  if (code === '23505') return { status: 409, error: 'That value already exists.' };
  const http = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : 0;
  if (http >= 400 && http < 500) return { status: http, error: e.type === 'entity.parse.failed' ? 'Malformed JSON body.' : e.type === 'entity.too.large' ? 'Request body too large.' : 'Bad request.' };
  return { status: 500, error: 'Internal server error' };
}
