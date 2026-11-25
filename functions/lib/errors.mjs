export class AppError extends Error {
  constructor(code, status = 400, message = '') {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export function fail(code, status = 400, message = '') {
  throw new AppError(code, status, message);
}

export function isAppError(value) {
  return value instanceof AppError;
}
