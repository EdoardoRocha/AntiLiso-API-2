import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import {
  accountIdParamSchema,
  createAccountBodySchema,
  createTransferBodySchema,
  listAccountsQuerySchema,
  updateAccountBodySchema,
} from './accounts.schemas.js';
import {
  createAccount,
  createInternalTransfer,
  listAccounts,
  updateAccount,
} from './accounts.service.js';

export async function accountsRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.addHook('preHandler', authenticate);

  typedApp.get(
    '/accounts',
    {
      schema: {
        querystring: listAccountsQuerySchema,
      },
    },
    async (request, reply) => {
      const accounts = await listAccounts(request.userId, request.query.includeInactive);
      return reply.status(200).send({ accounts });
    },
  );

  typedApp.post(
    '/accounts',
    {
      schema: {
        body: createAccountBodySchema,
      },
    },
    async (request, reply) => {
      const account = await createAccount(request.userId, request.body);
      return reply.status(201).send({ account });
    },
  );

  typedApp.patch(
    '/accounts/:id',
    {
      schema: {
        params: accountIdParamSchema,
        body: updateAccountBodySchema,
      },
    },
    async (request, reply) => {
      const account = await updateAccount(request.userId, request.params.id, request.body);
      return reply.status(200).send({ account });
    },
  );

  typedApp.post(
    '/accounts/transfers',
    {
      schema: {
        body: createTransferBodySchema,
      },
    },
    async (request, reply) => {
      const result = await createInternalTransfer(request.userId, request.body);
      return reply.status(201).send(result);
    },
  );
}
