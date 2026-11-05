export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly error: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Err = {
  notFound: (msg: string) => new AppError(404, 'NOT_FOUND', msg),
  badRequest: (msg: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details),
  unauthorized: (msg = 'Invalid or missing API key') => new AppError(401, 'UNAUTHORIZED', msg),
  conflict: (msg: string) => new AppError(409, 'CONFLICT', msg),
  paymentRequired: (msg: string) => new AppError(402, 'PAYMENT_REQUIRED', msg),
  unprocessable: (msg: string, details?: unknown) => new AppError(422, 'UNPROCESSABLE', msg, details),
};
