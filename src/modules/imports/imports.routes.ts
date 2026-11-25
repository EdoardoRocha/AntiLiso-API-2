import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { commitImportBodySchema, previewImportBodySchema } from './imports.schemas.js';
import { commitImport, previewImport } from './imports.service.js';

const IMPORT_BODY_LIMIT = 2 * 1024 * 1024; // 2 MB JSON payload

export async function importsRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.addHook('preHandler', authenticate);

  typedApp.post(
    '/imports/preview',
    {
      bodyLimit: IMPORT_BODY_LIMIT,
      schema: {
        body: previewImportBodySchema,
      },
    },
    async (request, reply) => {
      const preview = await previewImport(request.userId, request.body);
      return reply.status(200).send(preview);
    },
  );

  typedApp.post(
    '/imports/commit',
    {
      bodyLimit: IMPORT_BODY_LIMIT,
      schema: {
        body: commitImportBodySchema,
      },
    },
    async (request, reply) => {
      const result = await commitImport(request.userId, request.body);
      return reply.status(201).send(result);
    },
  );
}
