export class AppError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;

export const toErrorBody = (error: AppError) => ({
  code: error.code,
  message: error.message
});
