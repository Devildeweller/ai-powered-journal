import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

export function notFoundHandler(req, _res, next) {
  next(ApiError.notFound(`No route for ${req.method} ${req.originalUrl.split('?')[0]}`));
}

// Express recognises error middleware by its four-argument signature.
// eslint-disable-next-line no-unused-vars
export function errorHandler(error, req, res, _next) {
  let apiError = error;

  if (!(error instanceof ApiError)) {
    if (error?.type === 'entity.parse.failed') {
      apiError = ApiError.badRequest('Request body is not valid JSON.');
    } else if (error?.type === 'entity.too.large') {
      apiError = new ApiError(413, 'Request body is too large.');
    } else {
      logger.error({ err: error, method: req.method, path: req.originalUrl.split('?')[0] }, 'unhandled error');
      apiError = new ApiError(500, 'Something went wrong on our side.', { code: 'internal_error' });
    }
  }

  // A streaming response may already be underway; all we can do is end it.
  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(apiError.status).json({
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details ? { details: apiError.details } : {}),
    },
  });
}
