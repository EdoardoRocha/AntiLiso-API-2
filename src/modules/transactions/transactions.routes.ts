import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import {
  createTransactionBodySchema,
  listTransactionsQuerySchema,
  quickAddBodySchema,
  transactionIdParamSchema,
  updateTransactionBodySchema,
} from './transactions.schemas.js';
import {
  createTransaction,
  deleteTransaction,
  listTransactions,
  quickAddTransaction,
  updateTransaction,
} from './transactions.service.js';

export async function transactionsRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.addHook('preHandler', authenticate);

  typedApp.get(
    '/transactions',
    {
      schema: {
        querystring: listTransactionsQuerySchema,
      },
    },
    async (request, reply) => {
      const result = await listTransactions(request.userId, request.query);
      return reply.status(200).send(result);
    },
  );

  typedApp.post(
    '/transactions',
    {
      schema: {
        body: createTransactionBodySchema,
      },
    },
    async (request, reply) => {
      const result = await createTransaction(request.userId, request.body);
      return reply.status(result.idempotent ? 200 : 201).send(result);
    },
  );

  typedApp.post(
    '/transactions/quick-add',
    {
      schema: {
        body: quickAddBodySchema,
      },
    },
    async (request, reply) => {
      const result = await quickAddTransaction(request.userId, request.body);
      return reply.status(result.idempotent ? 200 : 201).send(result);
    },
  );

  typedApp.patch(
    '/transactions/:id',
    {
      schema: {
        params: transactionIdParamSchema,
        body: updateTransactionBodySchema,
      },
    },
    async (request, reply) => {
      const transaction = await updateTransaction(request.userId, request.params.id, request.body);
      return reply.status(200).send({ transaction });
    },
  );

  typedApp.delete(
    '/transactions/:id',
    {
      schema: {
        params: transactionIdParamSchema,
      },
    },
    async (request, reply) => {
      await deleteTransaction(request.userId, request.params.id);
      return reply.status(204).send();
    },
  );
}
