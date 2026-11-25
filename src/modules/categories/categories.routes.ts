import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import {
  categoryIdParamSchema,
  createCategoryBodySchema,
  listCategoriesQuerySchema,
  updateCategoryBodySchema,
} from './categories.schemas.js';
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from './categories.service.js';
import {
  createLearningRuleBodySchema,
  ruleIdParamSchema,
  suggestCategoryQuerySchema,
} from './learning-rules.schemas.js';
import {
  deleteLearningRule,
  listLearningRules,
  suggestCategoryForDescription,
  upsertLearningRule,
} from './learning-rules.service.js';

export async function categoriesRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.addHook('preHandler', authenticate);

  typedApp.get(
    '/categories/suggest',
    {
      schema: {
        querystring: suggestCategoryQuerySchema,
      },
    },
    async (request, reply) => {
      const suggestion = await suggestCategoryForDescription(
        request.userId,
        request.query.descricao,
        request.query.tipo,
      );
      return reply.status(200).send({ suggestion });
    },
  );

  typedApp.get('/categories/rules', async (request, reply) => {
    const rules = await listLearningRules(request.userId);
    return reply.status(200).send({ rules });
  });

  typedApp.post(
    '/categories/rules',
    {
      schema: {
        body: createLearningRuleBodySchema,
      },
    },
    async (request, reply) => {
      const rule = await upsertLearningRule(request.userId, request.body);
      return reply.status(201).send({ rule });
    },
  );

  typedApp.delete(
    '/categories/rules/:id',
    {
      schema: {
        params: ruleIdParamSchema,
      },
    },
    async (request, reply) => {
      await deleteLearningRule(request.userId, request.params.id);
      return reply.status(204).send();
    },
  );

  typedApp.get(
    '/categories',
    {
      schema: {
        querystring: listCategoriesQuerySchema,
      },
    },
    async (request, reply) => {
      const categories = await listCategories(request.userId, request.query);
      return reply.status(200).send({ categories });
    },
  );

  typedApp.post(
    '/categories',
    {
      schema: {
        body: createCategoryBodySchema,
      },
    },
    async (request, reply) => {
      const category = await createCategory(request.userId, request.body);
      return reply.status(201).send({ category });
    },
  );

  typedApp.patch(
    '/categories/:id',
    {
      schema: {
        params: categoryIdParamSchema,
        body: updateCategoryBodySchema,
      },
    },
    async (request, reply) => {
      const category = await updateCategory(request.userId, request.params.id, request.body);
      return reply.status(200).send({ category });
    },
  );

  typedApp.delete(
    '/categories/:id',
    {
      schema: {
        params: categoryIdParamSchema,
      },
    },
    async (request, reply) => {
      await deleteCategory(request.userId, request.params.id);
      return reply.status(204).send();
    },
  );
}
