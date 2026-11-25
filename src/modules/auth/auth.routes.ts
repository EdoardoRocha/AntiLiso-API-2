import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ACCESS_COOKIE_NAME,
  ACCESS_TOKEN_MAX_AGE_SECONDS,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_MAX_AGE_SECONDS,
  authenticate,
  getAuthCookieOptions,
} from '../../shared/middlewares/authenticate.js';
import {
  disableTwoFactorBodySchema,
  loginBodySchema,
  registerBodySchema,
  totpCodeBodySchema,
  updateProfileBodySchema,
} from './auth.schemas.js';
import {
  authenticateUser,
  disableTwoFactor,
  enableTwoFactor,
  ensureUserExists,
  getUserProfile,
  registerUser,
  setupTwoFactor,
  updateUserProfile,
} from './auth.service.js';

function setSessionCookies(app: FastifyInstance, reply: FastifyReply, userId: string): void {
  const accessToken = app.jwt.sign(
    { sub: userId, type: 'access' },
    { expiresIn: ACCESS_TOKEN_MAX_AGE_SECONDS },
  );
  const refreshToken = app.jwt.sign(
    { sub: userId, type: 'refresh' },
    { expiresIn: REFRESH_TOKEN_MAX_AGE_SECONDS },
  );

  reply.setCookie(
    ACCESS_COOKIE_NAME,
    accessToken,
    getAuthCookieOptions(ACCESS_TOKEN_MAX_AGE_SECONDS),
  );
  reply.setCookie(
    REFRESH_COOKIE_NAME,
    refreshToken,
    getAuthCookieOptions(REFRESH_TOKEN_MAX_AGE_SECONDS),
  );
}

function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(ACCESS_COOKIE_NAME, getAuthCookieOptions());
  reply.clearCookie(REFRESH_COOKIE_NAME, getAuthCookieOptions());
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    '/auth/register',
    {
      schema: {
        body: registerBodySchema,
      },
    },
    async (request, reply) => {
      const user = await registerUser(request.body);
      setSessionCookies(app, reply, user.id);
      return reply.status(201).send({ user });
    },
  );

  typedApp.post(
    '/auth/login',
    {
      schema: {
        body: loginBodySchema,
      },
    },
    async (request, reply) => {
      const user = await authenticateUser(
        request.body.email,
        request.body.senha,
        request.body.codigoTotp,
      );
      setSessionCookies(app, reply, user.id);
      return reply.status(200).send({ user });
    },
  );

  typedApp.post('/auth/refresh', async (request, reply) => {
    const refreshToken = request.cookies[REFRESH_COOKIE_NAME];
    if (!refreshToken) {
      clearSessionCookies(reply);
      return reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: 'Refresh token ausente.',
      });
    }

    let payload: { sub?: unknown; type?: unknown };
    try {
      payload = app.jwt.verify<{ sub?: unknown; type?: unknown }>(refreshToken);
    } catch {
      clearSessionCookies(reply);
      return reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: 'Refresh token inválido ou expirado.',
      });
    }

    if (payload.type !== 'refresh' || typeof payload.sub !== 'string' || !payload.sub) {
      clearSessionCookies(reply);
      return reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: 'Refresh token inválido.',
      });
    }

    const exists = await ensureUserExists(payload.sub);
    if (!exists) {
      clearSessionCookies(reply);
      return reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: 'Usuário não encontrado.',
      });
    }

    setSessionCookies(app, reply, payload.sub);
    return reply.status(200).send({ ok: true });
  });

  typedApp.post('/auth/logout', async (_request, reply) => {
    clearSessionCookies(reply);
    return reply.status(200).send({ ok: true });
  });

  typedApp.get(
    '/me',
    {
      preHandler: [authenticate],
    },
    async (request, reply) => {
      const user = await getUserProfile(request.userId);
      return reply.status(200).send({ user });
    },
  );

  typedApp.patch(
    '/me',
    {
      preHandler: [authenticate],
      schema: {
        body: updateProfileBodySchema,
      },
    },
    async (request, reply) => {
      const user = await updateUserProfile(request.userId, request.body);
      return reply.status(200).send({ user });
    },
  );

  typedApp.post(
    '/auth/2fa/setup',
    {
      preHandler: [authenticate],
    },
    async (request, reply) => {
      const setup = await setupTwoFactor(request.userId);
      return reply.status(200).send(setup);
    },
  );

  typedApp.post(
    '/auth/2fa/enable',
    {
      preHandler: [authenticate],
      schema: {
        body: totpCodeBodySchema,
      },
    },
    async (request, reply) => {
      const user = await enableTwoFactor(request.userId, request.body.codigoTotp);
      return reply.status(200).send({ user });
    },
  );

  typedApp.post(
    '/auth/2fa/disable',
    {
      preHandler: [authenticate],
      schema: {
        body: disableTwoFactorBodySchema,
      },
    },
    async (request, reply) => {
      const user = await disableTwoFactor(request.userId, request.body.senhaAtual);
      return reply.status(200).send({ user });
    },
  );
}
