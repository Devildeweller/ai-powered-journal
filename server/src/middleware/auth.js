import { ApiError } from '../utils/ApiError.js';
import { verifyAccessToken } from '../utils/tokens.js';

/**
 * Requires a valid `Authorization: Bearer <access token>` header and exposes
 * the caller as `req.user.id`.  Every data query downstream is scoped by it.
 */
export function requireAuth(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return next(ApiError.unauthorized());
  }
  try {
    const { userId } = verifyAccessToken(token);
    req.user = { id: userId };
    return next();
  } catch (error) {
    const expired = error?.name === 'TokenExpiredError';
    return next(
      ApiError.unauthorized(expired ? 'Access token expired.' : 'Invalid access token.', {
        code: expired ? 'token_expired' : 'invalid_token',
      }),
    );
  }
}
