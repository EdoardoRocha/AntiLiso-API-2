import type { IncomingMessage, ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from './config/env.js';
import { checkDatabaseConnection } from './infra/database/prisma.js';
import { accountsRoutes } from './modules/accounts/accounts.routes.js';
import { alertsRoutes } from './modules/alerts/alerts.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { categoriesRoutes } from './modules/categories/categories.routes.js';
import { creditCardsRoutes } from './modules/credit-cards/credit-cards.routes.js';
import { exportRoutes } from './modules/export/export.routes.js';
import { importsRoutes } from './modules/imports/imports.routes.js';
import { investmentsRoutes } from './modules/investments/investments.routes.js';
import { recurrencesRoutes } from './modules/recurrences/recurrences.routes.js';
import { reserveRoutes } from './modules/reserve/reserve.routes.js';
import { safeToSpendRoutes } from './modules/safe-to-spend/safe-to-spend.routes.js';
import { transactionsRoutes } from './modules/transactions/transactions.routes.js';
import { registerErrorHandler } from './shared/errors/app-error.js';
import { ACCESS_COOKIE_NAME } from './shared/middlewares/authenticate.js';

export interface BuildAppOptions {
  checkDb?: () => Promise<boolean>;
  logger?: boolean;
  corsOrigin?: string;
}

const rootResponseSchema = z.object({
  name: z.literal('AntiLiso API'),
  status: z.literal('ok'),
  health: z.literal('/health'),
});

const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  database: z.enum(['up', 'down']),
  timestamp: z.string(),
});

export function parseCorsOrigins(rawOrigin: string): string[] {
  return rawOrigin
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter((item) => item.length > 0);
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const checkDb = options.checkDb ?? checkDatabaseConnection;

  const app = Fastify({
    logger: options.logger ?? env.NODE_ENV === 'development',
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);

  await app.register(cors, {
    origin: parseCorsOrigins(options.corsOrigin ?? env.CORS_ORIGIN),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.register(cookie);

  await app.register(jwt, {
    secret: env.JWT_SECRET,
    cookie: {
      cookieName: ACCESS_COOKIE_NAME,
      signed: false,
    },
  });

  app.get(
    '/',
    {
      schema: {
        response: {
          200: rootResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      return reply.status(200).send({
        name: 'AntiLiso API' as const,
        status: 'ok' as const,
        health: '/health' as const,
      });
    },
  );

  app.get(
    '/health',
    {
      schema: {
        response: {
          200: healthResponseSchema,
          503: healthResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const dbUp = await checkDb();
      const payload = {
        status: dbUp ? ('ok' as const) : ('degraded' as const),
        database: dbUp ? ('up' as const) : ('down' as const),
        timestamp: new Date().toISOString(),
      };

      return reply.status(dbUp ? 200 : 503).send(payload);
    },
  );

  await app.register(authRoutes);
  await app.register(accountsRoutes);
  await app.register(categoriesRoutes);
  await app.register(transactionsRoutes);
  await app.register(recurrencesRoutes);
  await app.register(creditCardsRoutes);
  await app.register(reserveRoutes);
  await app.register(importsRoutes);
  await app.register(investmentsRoutes);
  await app.register(alertsRoutes);
  await app.register(exportRoutes);
  await app.register(safeToSpendRoutes);

  return app;
}

export type ServerlessRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createServerlessHandler(
  options: BuildAppOptions = {},
  appFactory: (opts: BuildAppOptions) => Promise<FastifyInstance> = buildApp,
): ServerlessRequestHandler {
  let readyAppPromise: Promise<FastifyInstance> | null = null;

  const getReadyApp = (): Promise<FastifyInstance> => {
    if (!readyAppPromise) {
      readyAppPromise = (async () => {
        const instance = await appFactory(options);
        await instance.ready();
        return instance;
      })().catch((error: unknown) => {
        readyAppPromise = null;
        throw error;
      });
    }
    return readyAppPromise;
  };

  return async function serverlessHandler(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const app = await getReadyApp();
    app.server.emit('request', req, res);
  };
}

const defaultServerlessHandler = createServerlessHandler();

export default defaultServerlessHandler;
