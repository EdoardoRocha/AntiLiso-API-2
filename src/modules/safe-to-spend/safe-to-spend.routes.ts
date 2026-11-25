import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { safeToSpendQuerySchema } from './safe-to-spend.schemas.js';
import { getSafeToSpend } from './safe-to-spend.service.js';

export async function safeToSpendRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.addHook('preHandler', authenticate);

  typedApp.get(
    '/safe-to-spend',
    {
      schema: {
        querystring: safeToSpendQuerySchema,
      },
    },
    async (request, reply) => {
      const result = await getSafeToSpend(request.userId, request.query.date);
      return reply.status(200).send(result);
    },
  );
}
