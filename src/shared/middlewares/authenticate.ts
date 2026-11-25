import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';

export const ACCESS_COOKIE_NAME = 'antiliso_access_token';
export const REFRESH_COOKIE_NAME = 'antiliso_refresh_token';

export const ACCESS_TOKEN_MAX_AGE_SECONDS = 15 * 60;
export const REFRESH_TOKEN_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export function getAuthCookieOptions(maxAgeSeconds?: number): CookieSerializeOptions {
  const isProd = env.NODE_ENV === 'production';

  return {
    httpOnly: true,
    path: '/',
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}),
  };
}

export async function authenticate(request: FastifyRequest): Promise<void> {
  const cookieToken = request.cookies[ACCESS_COOKIE_NAME];
  const authHeader = request.headers.authorization;
  const bearerToken =
    authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;

  const token = cookieToken || bearerToken;
  if (!token) {
    throw new AppError('Não autenticado.', 401, 'UNAUTHORIZED');
  }

  let payload: { sub?: unknown; type?: unknown };
  try {
    payload = request.server.jwt.verify<{ sub?: unknown; type?: unknown }>(token);
  } catch {
    throw new AppError('Sessão inválida ou expirada.', 401, 'UNAUTHORIZED');
  }

  if (payload.type !== 'access' || typeof payload.sub !== 'string' || !payload.sub) {
    throw new AppError('Token de acesso inválido.', 401, 'UNAUTHORIZED');
  }

  request.userId = payload.sub;
}
