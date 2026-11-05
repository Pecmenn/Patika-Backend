import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

// Uygulamaya dönen hatalar. code sabit bir sözcüktür, ayrıntı ve iç bilgi içermez.
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, 'invalid_request');
  }
  return result.data;
}

export function handleError(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ApiError) {
    return reply.status(error.statusCode).send({ error: error.code });
  }
  const status = error.statusCode ?? 500;
  if (status >= 500) {
    // Veritabanı hatalarının metni sorgudaki değerleri (telefon, mesaj) içerebilir, kayda yazılmaz.
    const isDatabaseError = 'sql' in error;
    request.log.error({
      code: error.code,
      name: error.name,
      ...(isDatabaseError ? {} : { message: error.message, stack: error.stack }),
    });
    return reply.status(500).send({ error: 'server_error' });
  }
  if (status === 413) {
    return reply.status(413).send({ error: 'too_large' });
  }
  return reply.status(status).send({ error: 'invalid_request' });
}

export function handleNotFound(_request: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send({ error: 'not_found' });
}
