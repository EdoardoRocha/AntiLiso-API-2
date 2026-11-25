import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import {
  createReserveDepositBodySchema,
  createReserveWithdrawalBodySchema,
  reserveOverviewQuerySchema,
  updateReserveConfigBodySchema,
} from './reserve.schemas.js';
import {
  createReserveDeposit,
  createReserveWithdrawal,
  getReserveOverview,
  updateReserveConfig,
} from './reserve.service.js';

export async function reserveRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.addHook('preHandler', authenticate);

  typedApp.get(
    '/reserve',
    {
      schema: {
        querystring: reserveOverviewQuerySchema,
      },
    },
    async (request, reply) => {
      const overview = await getReserveOverview(request.userId, request.query.date);
      return reply.status(200).send(overview);
    },
  );

  typedApp.patch(
    '/reserve/config',
    {
      schema: {
        body: updateReserveConfigBodySchema,
      },
    },
    async (request, reply) => {
      const overview = await updateReserveConfig(request.userId, request.body);
      return reply.status(200).send(overview);
    },
  );

  typedApp.post(
    '/reserve/deposits',
    {
      schema: {
        body: createReserveDepositBodySchema,
      },
    },
    async (request, reply) => {
      const result = await createReserveDeposit(request.userId, request.body);
      return reply.status(201).send(result);
    },
  );

  typedApp.post(
    '/reserve/withdrawals',
    {
      schema: {
        body: createReserveWithdrawalBodySchema,
      },
    },
    async (request, reply) => {
      const result = await createReserveWithdrawal(request.userId, request.body);
      return reply.status(201).send(result);
    },
  );
}
