export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'unauthorized', message);

export const forbidden = (message = 'You do not have access to this resource') =>
  new HttpError(403, 'forbidden', message);

export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);

export const conflict = (message: string) => new HttpError(409, 'conflict', message);

export const tooMany = (message = 'Too many requests') => new HttpError(429, 'rate_limited', message);

export const notConfigured = (message: string) => new HttpError(503, 'not_configured', message);

export type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
};

export function paginate(pageRaw: unknown, pageSizeRaw: unknown) {
  const page = Math.max(1, Number(pageRaw) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(pageSizeRaw) || 20));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
