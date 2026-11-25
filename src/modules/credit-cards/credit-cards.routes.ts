import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import {
  cardIdParamSchema,
  createCreditCardBodySchema,
  invoiceQuerySchema,
  listCreditCardsQuerySchema,
  payInvoiceBodySchema,
  payInvoiceParamsSchema,
  updateCreditCardBodySchema,
} from './credit-cards.schemas.js';
import {
  createCreditCard,
  deleteCreditCard,
  getCreditCardInvoice,
  listCreditCards,
  payCreditCardInvoice,
  updateCreditCard,
} from './credit-cards.service.js';

export async function creditCardsRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.addHook('preHandler', authenticate);

  typedApp.get(
    '/credit-cards',
    {
      schema: {
        querystring: listCreditCardsQuerySchema,
      },
    },
    async (request, reply) => {
      const cards = await listCreditCards(request.userId, request.query.date);
      return reply.status(200).send({ cards });
    },
  );

  typedApp.post(
    '/credit-cards',
    {
      schema: {
        body: createCreditCardBodySchema,
      },
    },
    async (request, reply) => {
      const card = await createCreditCard(request.userId, request.body);
      return reply.status(201).send({ card });
    },
  );

  typedApp.patch(
    '/credit-cards/:id',
    {
      schema: {
        params: cardIdParamSchema,
        body: updateCreditCardBodySchema,
      },
    },
    async (request, reply) => {
      const card = await updateCreditCard(request.userId, request.params.id, request.body);
      return reply.status(200).send({ card });
    },
  );

  typedApp.delete(
    '/credit-cards/:id',
    {
      schema: {
        params: cardIdParamSchema,
      },
    },
    async (request, reply) => {
      await deleteCreditCard(request.userId, request.params.id);
      return reply.status(204).send();
    },
  );

  typedApp.get(
    '/credit-cards/:id/invoice',
    {
      schema: {
        params: cardIdParamSchema,
        querystring: invoiceQuerySchema,
      },
    },
    async (request, reply) => {
      const invoice = await getCreditCardInvoice(
        request.userId,
        request.params.id,
        request.query.month,
        request.query.date,
      );
      return reply.status(200).send(invoice);
    },
  );

  typedApp.post(
    '/credit-cards/:id/invoices/:month/pay',
    {
      schema: {
        params: payInvoiceParamsSchema,
        body: payInvoiceBodySchema,
      },
    },
    async (request, reply) => {
      const payment = await payCreditCardInvoice(
        request.userId,
        request.params.id,
        request.params.month,
        request.body,
      );
      return reply.status(200).send(payment);
    },
  );
}
