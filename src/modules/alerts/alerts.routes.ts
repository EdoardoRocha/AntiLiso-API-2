import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import {
  alertIdParamSchema,
  listAlertsQuerySchema,
  markAlertReadBodySchema,
  syncAlertsBodySchema,
} from './alerts.schemas.js';
import {
  deleteAlert,
  listAlerts,
  markAlertRead,
  markAllAlertsRead,
  syncProactiveAlerts,
} from './alerts.service.js';

export async function alertsRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.addHook('preHandler', authenticate);

  typedApp.get(
    '/alerts',
    {
      schema: {
        querystring: listAlertsQuerySchema,
      },
    },
    async (request, reply) => {
      const result = await listAlerts(request.userId, request.query);
      return reply.status(200).send(result);
    },
  );

  typedApp.post(
    '/alerts/sync',
    {
      schema: {
        body: syncAlertsBodySchema,
      },
    },
    async (request, reply) => {
      const result = await syncProactiveAlerts(request.userId, {
        date: request.body.date,
        canal: request.body.canal,
      });
      return reply.status(200).send(result);
    },
  );

  typedApp.patch(
    '/alerts/:id/read',
    {
      schema: {
        params: alertIdParamSchema,
        body: markAlertReadBodySchema,
      },
    },
    async (request, reply) => {
      const alert = await markAlertRead(request.userId, request.params.id, request.body.lido);
      return reply.status(200).send({ alert });
    },
  );

  typedApp.post('/alerts/read-all', async (request, reply) => {
    const result = await markAllAlertsRead(request.userId);
    return reply.status(200).send(result);
  });

  typedApp.delete(
    '/alerts/:id',
    {
      schema: {
        params: alertIdParamSchema,
      },
    },
    async (request, reply) => {
      await deleteAlert(request.userId, request.params.id);
      return reply.status(204).send();
    },
  );
}
