import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import {
  checklistQuerySchema,
  createRecurrenceBodySchema,
  generateRecurrencesBodySchema,
  listRecurrencesQuerySchema,
  recurrenceIdParamSchema,
  updateRecurrenceBodySchema,
} from './recurrences.schemas.js';
import {
  createRecurrence,
  deleteRecurrence,
  generateMonthlyRecurrences,
  getMonthlyChecklist,
  listRecurrences,
  updateRecurrence,
} from './recurrences.service.js';

export async function recurrencesRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.addHook('preHandler', authenticate);

  typedApp.get(
    '/recurrences/checklist',
    {
      schema: {
        querystring: checklistQuerySchema,
      },
    },
    async (request, reply) => {
      const checklist = await getMonthlyChecklist(request.userId, request.query.month);
      return reply.status(200).send(checklist);
    },
  );

  typedApp.post(
    '/recurrences/generate',
    {
      schema: {
        body: generateRecurrencesBodySchema,
      },
    },
    async (request, reply) => {
      const result = await generateMonthlyRecurrences(request.userId, request.body.month);
      return reply.status(200).send(result);
    },
  );

  typedApp.get(
    '/recurrences',
    {
      schema: {
        querystring: listRecurrencesQuerySchema,
      },
    },
    async (request, reply) => {
      const recurrences = await listRecurrences(request.userId, request.query.includeInactive);
      return reply.status(200).send({ recurrences });
    },
  );

  typedApp.post(
    '/recurrences',
    {
      schema: {
        body: createRecurrenceBodySchema,
      },
    },
    async (request, reply) => {
      const recurrence = await createRecurrence(request.userId, request.body);
      return reply.status(201).send({ recurrence });
    },
  );

  typedApp.patch(
    '/recurrences/:id',
    {
      schema: {
        params: recurrenceIdParamSchema,
        body: updateRecurrenceBodySchema,
      },
    },
    async (request, reply) => {
      const recurrence = await updateRecurrence(request.userId, request.params.id, request.body);
      return reply.status(200).send({ recurrence });
    },
  );

  typedApp.delete(
    '/recurrences/:id',
    {
      schema: {
        params: recurrenceIdParamSchema,
      },
    },
    async (request, reply) => {
      await deleteRecurrence(request.userId, request.params.id);
      return reply.status(204).send();
    },
  );
}
