import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import { buildUserExportPayload, serializeExportToCsv } from './export.service.js';

const exportQuerySchema = z.object({
  format: z.enum(['json', 'csv']).default('json'),
});

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.addHook('preHandler', authenticate);

  typedApp.get(
    '/export',
    {
      schema: {
        querystring: exportQuerySchema,
      },
    },
    async (request, reply) => {
      const payload = await buildUserExportPayload(request.userId);
      const dateStamp = new Date().toISOString().slice(0, 10);

      if (request.query.format === 'csv') {
        const csv = serializeExportToCsv(payload);
        return reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="antiliso-lgpd-${dateStamp}.csv"`)
          .status(200)
          .send(csv);
      }

      return reply
        .header('Content-Type', 'application/json; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="antiliso-lgpd-${dateStamp}.json"`)
        .status(200)
        .send(payload);
    },
  );
}
