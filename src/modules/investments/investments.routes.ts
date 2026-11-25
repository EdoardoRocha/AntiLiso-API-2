import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate } from '../../shared/middlewares/authenticate.js';
import {
  addAssetContributionBodySchema,
  assetIdParamSchema,
  createAssetBodySchema,
  investmentsOverviewQuerySchema,
  putAllocationsBodySchema,
  rebalanceBodySchema,
  simulateCompoundBodySchema,
  updateAssetBodySchema,
} from './investments.schemas.js';
import {
  addAssetContribution,
  calculateUserRebalance,
  createPortfolioAsset,
  deletePortfolioAsset,
  getInvestmentsOverview,
  runCompoundSimulation,
  updatePortfolioAsset,
  updateTargetAllocations,
} from './investments.service.js';

export async function investmentsRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.addHook('preHandler', authenticate);

  typedApp.get(
    '/investments',
    {
      schema: {
        querystring: investmentsOverviewQuerySchema,
      },
    },
    async (request, reply) => {
      const overview = await getInvestmentsOverview(request.userId, request.query.valorAporte);
      return reply.status(200).send(overview);
    },
  );

  typedApp.put(
    '/investments/allocations',
    {
      schema: {
        body: putAllocationsBodySchema,
      },
    },
    async (request, reply) => {
      const overview = await updateTargetAllocations(request.userId, request.body);
      return reply.status(200).send(overview);
    },
  );

  typedApp.post(
    '/investments/assets',
    {
      schema: {
        body: createAssetBodySchema,
      },
    },
    async (request, reply) => {
      const result = await createPortfolioAsset(request.userId, request.body);
      return reply.status(201).send(result);
    },
  );

  typedApp.patch(
    '/investments/assets/:id',
    {
      schema: {
        params: assetIdParamSchema,
        body: updateAssetBodySchema,
      },
    },
    async (request, reply) => {
      const result = await updatePortfolioAsset(request.userId, request.params.id, request.body);
      return reply.status(200).send(result);
    },
  );

  typedApp.post(
    '/investments/assets/:id/contributions',
    {
      schema: {
        params: assetIdParamSchema,
        body: addAssetContributionBodySchema,
      },
    },
    async (request, reply) => {
      const result = await addAssetContribution(request.userId, request.params.id, request.body);
      return reply.status(200).send(result);
    },
  );

  typedApp.delete(
    '/investments/assets/:id',
    {
      schema: {
        params: assetIdParamSchema,
      },
    },
    async (request, reply) => {
      await deletePortfolioAsset(request.userId, request.params.id);
      return reply.status(204).send();
    },
  );

  typedApp.post(
    '/investments/rebalance',
    {
      schema: {
        body: rebalanceBodySchema,
      },
    },
    async (request, reply) => {
      const plan = await calculateUserRebalance(request.userId, request.body.valorAporte);
      return reply.status(200).send(plan);
    },
  );

  typedApp.post(
    '/investments/simulate',
    {
      schema: {
        body: simulateCompoundBodySchema,
      },
    },
    async (request, reply) => {
      const simulation = runCompoundSimulation(request.body);
      return reply.status(200).send(simulation);
    },
  );
}
