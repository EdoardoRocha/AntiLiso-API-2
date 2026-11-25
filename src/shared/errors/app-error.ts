import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly code = 'BAD_REQUEST',
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Dados inválidos.',
        details: error.validation.map((issue) => ({
          path: issue.instancePath,
          message: issue.message,
        })),
      });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return reply.status(409).send({
          error: 'CONFLICT',
          message: 'Registro duplicado para os dados informados.',
        });
      }

      if (error.code === 'P2003') {
        return reply.status(409).send({
          error: 'REFERENCE_CONFLICT',
          message: 'Registro em uso por outros dados e não pode ser removido.',
        });
      }

      if (error.code === 'P2025') {
        return reply.status(404).send({
          error: 'NOT_FOUND',
          message: 'Registro não encontrado.',
        });
      }
    }

    request.log.error(error);
    return reply.status(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Erro interno do servidor.',
    });
  });
}
