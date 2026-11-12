import { ApiError } from '../utils/ApiError.js';

/**
 * Validates request parts against zod schemas and stores the parsed, typed
 * result on `req.valid` ({ params, query, body }).  Handlers read from
 * `req.valid` only, so nothing unvalidated reaches the service layer.
 */
export function validate(schemas) {
  return (req, _res, next) => {
    const valid = {};
    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        const details = result.error.issues.map((issue) => ({
          field: issue.path.join('.') || part,
          message: issue.message,
        }));
        return next(ApiError.validation(details));
      }
      valid[part] = result.data;
    }
    req.valid = valid;
    return next();
  };
}
