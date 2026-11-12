/**
 * An error that is safe to show to API clients.  Anything that is not an
 * ApiError is treated as an unexpected failure and reported as a generic 500.
 */
export class ApiError extends Error {
  constructor(status, message, { code, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code ?? ApiError.defaultCode(status);
    this.details = details;
  }

  static defaultCode(status) {
    return (
      {
        400: 'bad_request',
        401: 'unauthorized',
        403: 'forbidden',
        404: 'not_found',
        409: 'conflict',
        413: 'payload_too_large',
        422: 'validation_failed',
        429: 'rate_limited',
        503: 'service_unavailable',
      }[status] ?? 'error'
    );
  }

  static badRequest(message, options) {
    return new ApiError(400, message, options);
  }
  static unauthorized(message = 'Authentication required.', options) {
    return new ApiError(401, message, options);
  }
  static forbidden(message = 'You do not have access to this resource.', options) {
    return new ApiError(403, message, options);
  }
  static notFound(message = 'Not found.', options) {
    return new ApiError(404, message, options);
  }
  static conflict(message, options) {
    return new ApiError(409, message, options);
  }
  static validation(details) {
    return new ApiError(422, 'Some fields are invalid.', { details });
  }
  static unavailable(message, options) {
    return new ApiError(503, message, options);
  }
}
