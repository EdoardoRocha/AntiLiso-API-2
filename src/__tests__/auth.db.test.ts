import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { prisma } from '../infra/database/prisma.js';
import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME } from '../shared/middlewares/authenticate.js';

describe.runIf(process.env.RUN_DB_TESTS === 'true')(
  'Etapa 1 — Auth JWT, Provisionamento e Perfil (/me)',
  () => {
    let app: FastifyInstance;
    const createdUserIds: string[] = [];
    const testEmail = `auth-test-${randomUUID()}@antiliso.local`;
    const testPassword = 'SenhaSegura@2026';

    beforeAll(async () => {
      app = await buildApp({ logger: false });
    });

    afterAll(async () => {
      if (createdUserIds.length > 0) {
        await prisma.movimentoReserva.deleteMany({
          where: { reserva: { usuarioId: { in: createdUserIds } } },
        });
        await prisma.transacao.deleteMany({ where: { usuarioId: { in: createdUserIds } } });
        await prisma.recorrencia.deleteMany({ where: { usuarioId: { in: createdUserIds } } });
        await prisma.cartaoCredito.deleteMany({ where: { usuarioId: { in: createdUserIds } } });
        await prisma.reservaEmergencia.deleteMany({ where: { usuarioId: { in: createdUserIds } } });
        await prisma.conta.deleteMany({ where: { usuarioId: { in: createdUserIds } } });
        await prisma.categoria.deleteMany({ where: { usuarioId: { in: createdUserIds } } });
        await prisma.usuario.deleteMany({ where: { id: { in: createdUserIds } } });
      }
      await app.close();
      await prisma.$disconnect();
    });

    it('realiza signup com cookies HttpOnly e provisiona contas, reserva 1:1 e categorias iniciais', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          nome: 'Usuário Teste',
          email: testEmail,
          senha: testPassword,
          custoVidaMensal: 3000,
          mesesReservaAlvo: 6,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.user.email).toBe(testEmail);
      expect(body.user.senhaHash).toBeUndefined();
      expect(body.user.reserva.valorMetaCalculado).toBe(18000);
      expect(body.user.reserva.statusGatilho).toBe('BLOQUEADO');

      createdUserIds.push(body.user.id);

      const accessCookie = response.cookies.find((c) => c.name === ACCESS_COOKIE_NAME);
      const refreshCookie = response.cookies.find((c) => c.name === REFRESH_COOKIE_NAME);
      expect(accessCookie?.httpOnly).toBe(true);
      expect(refreshCookie?.httpOnly).toBe(true);

      const [contas, categorias, reserva] = await Promise.all([
        prisma.conta.findMany({ where: { usuarioId: body.user.id } }),
        prisma.categoria.findMany({ where: { usuarioId: body.user.id } }),
        prisma.reservaEmergencia.findUnique({ where: { usuarioId: body.user.id } }),
      ]);

      expect(contas).toHaveLength(2);
      expect(contas.filter((c) => c.tipo === 'CORRENTE' && c.ehContaPadrao)).toHaveLength(1);
      expect(contas.filter((c) => c.tipo === 'COFRE' && !c.ehContaPadrao)).toHaveLength(1);
      expect(categorias).toHaveLength(10);
      expect(reserva).not.toBeNull();
      expect(reserva?.travaResgateAtiva).toBe(true);

      const duplicate = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          nome: 'Duplicado',
          email: testEmail,
          senha: testPassword,
        },
      });
      expect(duplicate.statusCode).toBe(409);
    });

    it('autentica, rejeita credenciais/tokens inválidos, renova refresh, atualiza /me e faz logout', async () => {
      const wrongPass = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: testEmail, senha: 'SenhaErrada' },
      });
      expect(wrongPass.statusCode).toBe(401);

      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: testEmail, senha: testPassword },
      });
      expect(loginRes.statusCode).toBe(200);

      const accessCookie = loginRes.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!;
      const refreshCookie = loginRes.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!;
      expect(accessCookie.value).toBeTruthy();
      expect(refreshCookie.value).toBeTruthy();

      const unauthMe = await app.inject({ method: 'GET', url: '/me' });
      expect(unauthMe.statusCode).toBe(401);

      const refreshAsAccess = await app.inject({
        method: 'GET',
        url: '/me',
        cookies: { [ACCESS_COOKIE_NAME]: refreshCookie.value },
      });
      expect(refreshAsAccess.statusCode).toBe(401);

      const validMe = await app.inject({
        method: 'GET',
        url: '/me',
        cookies: { [ACCESS_COOKIE_NAME]: accessCookie.value },
      });
      expect(validMe.statusCode).toBe(200);
      expect(validMe.json().user.email).toBe(testEmail);

      const refreshRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: refreshCookie.value },
      });
      expect(refreshRes.statusCode).toBe(200);
      const rotatedAccess = refreshRes.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!;
      expect(rotatedAccess.value).toBeTruthy();

      const patchMe = await app.inject({
        method: 'PATCH',
        url: '/me',
        cookies: { [ACCESS_COOKIE_NAME]: rotatedAccess.value },
        payload: {
          custoVidaMensal: 4500,
          mesesReservaAlvo: 8,
          pctPaguePrimeiro: 20,
        },
      });
      expect(patchMe.statusCode).toBe(200);
      const patchedUser = patchMe.json().user;
      expect(patchedUser.custoVidaMensal).toBe(4500);
      expect(patchedUser.mesesReservaAlvo).toBe(8);
      expect(patchedUser.pctPaguePrimeiro).toBe(20);
      expect(patchedUser.reserva.valorMetaCalculado).toBe(36000);

      const reservaDb = await prisma.reservaEmergencia.findUnique({
        where: { usuarioId: patchedUser.id },
      });
      expect(Number(reservaDb?.valorMetaCalculado)).toBe(36000);

      const logoutRes = await app.inject({ method: 'POST', url: '/auth/logout' });
      expect(logoutRes.statusCode).toBe(200);
      const clearedAccess = logoutRes.cookies.find((c) => c.name === ACCESS_COOKIE_NAME);
      expect(clearedAccess?.value).toBe('');
    });
  },
);
