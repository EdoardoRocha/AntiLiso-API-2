import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { prisma } from '../infra/database/prisma.js';
import { ACCESS_COOKIE_NAME } from '../shared/middlewares/authenticate.js';

describe.runIf(process.env.RUN_DB_TESTS === 'true')(
  'Etapa 3 — Categorização Inteligente por Histórico (RF-03)',
  () => {
    let app: FastifyInstance;
    let userAId = '';
    let userAToken = '';
    let userBId = '';
    let userBToken = '';
    let transporteId = '';
    let lazerId = '';
    let salarioId = '';

    beforeAll(async () => {
      app = await buildApp({ logger: false });

      const regA = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          nome: 'RF03 User A',
          email: `rf03-a-${randomUUID()}@antiliso.local`,
          senha: 'SenhaForte@2026',
        },
      });
      expect(regA.statusCode).toBe(201);
      userAId = regA.json().user.id;
      userAToken = regA.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!.value;

      const regB = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          nome: 'RF03 User B',
          email: `rf03-b-${randomUUID()}@antiliso.local`,
          senha: 'SenhaForte@2026',
        },
      });
      expect(regB.statusCode).toBe(201);
      userBId = regB.json().user.id;
      userBToken = regB.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!.value;

      const catsRes = await app.inject({
        method: 'GET',
        url: '/categories',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      const cats = catsRes.json().categories as Array<{ id: string; nome: string; tipo: string }>;
      transporteId = cats.find((c) => c.nome === 'Transporte')!.id;
      lazerId = cats.find((c) => c.nome === 'Lazer')!.id;
      salarioId = cats.find((c) => c.nome === 'Salário')!.id;
    });

    afterAll(async () => {
      const ids = [userAId, userBId].filter(Boolean);
      if (ids.length > 0) {
        await prisma.regraAprendizado.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.movimentoReserva.deleteMany({
          where: { reserva: { usuarioId: { in: ids } } },
        });
        await prisma.transacao.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.recorrencia.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.cartaoCredito.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.reservaEmergencia.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.conta.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.categoria.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.usuario.deleteMany({ where: { id: { in: ids } } });
      }
      await app.close();
      await prisma.$disconnect();
    });

    it('aprende no lançamento, autopreenche no Quick-Add seguinte, incrementa confiança e atualiza ao corrigir', async () => {
      const firstTx = await app.inject({
        method: 'POST',
        url: '/transactions',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          tipo: 'DESP',
          valor: 42,
          descricao: 'Uber aeroporto',
          categoriaId: transporteId,
        },
      });
      expect(firstTx.statusCode).toBe(201);

      let ruleDb = await prisma.regraAprendizado.findUnique({
        where: { usuarioId_termoChave: { usuarioId: userAId, termoChave: 'uber' } },
      });
      expect(ruleDb).not.toBeNull();
      expect(ruleDb?.categoriaId).toBe(transporteId);
      expect(ruleDb?.hitsConfianca).toBe(1);

      const quickRes = await app.inject({
        method: 'POST',
        url: '/transactions/quick-add',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          texto: 'Uber 24,90',
        },
      });
      expect(quickRes.statusCode).toBe(201);
      const quickBody = quickRes.json();
      expect(quickBody.transaction.categoriaId).toBe(transporteId);
      expect(quickBody.transaction.categoriaNome).toBe('Transporte');
      expect(quickBody.suggestedCategory?.source).toBe('RULE');

      ruleDb = await prisma.regraAprendizado.findUnique({
        where: { usuarioId_termoChave: { usuarioId: userAId, termoChave: 'uber' } },
      });
      expect(ruleDb?.hitsConfianca).toBe(2);

      const suggestDesp = await app.inject({
        method: 'GET',
        url: '/categories/suggest?descricao=Uber%20casa&tipo=DESP',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(suggestDesp.statusCode).toBe(200);
      expect(suggestDesp.json().suggestion).toEqual({
        categoriaId: transporteId,
        categoriaNome: 'Transporte',
        source: 'RULE',
        termoChave: 'uber',
        hitsConfianca: 2,
      });

      const suggestRec = await app.inject({
        method: 'GET',
        url: '/categories/suggest?descricao=Uber%20casa&tipo=REC',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(suggestRec.statusCode).toBe(200);
      expect(suggestRec.json().suggestion).toBeNull();

      const patchTx = await app.inject({
        method: 'PATCH',
        url: `/transactions/${quickBody.transaction.id}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          categoriaId: lazerId,
        },
      });
      expect(patchTx.statusCode).toBe(200);

      ruleDb = await prisma.regraAprendizado.findUnique({
        where: { usuarioId_termoChave: { usuarioId: userAId, termoChave: 'uber' } },
      });
      expect(ruleDb?.categoriaId).toBe(lazerId);
      expect(ruleDb?.hitsConfianca).toBe(1);
    });

    it('permite CRUD manual de regras e garante isolamento multi-tenant', async () => {
      const createdRule = await app.inject({
        method: 'POST',
        url: '/categories/rules',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          termoChave: 'Freela Design',
          categoriaId: salarioId,
        },
      });
      expect(createdRule.statusCode).toBe(201);
      const ruleId = createdRule.json().rule.id;
      expect(createdRule.json().rule.termoChave).toBe('freela design');

      const listA = await app.inject({
        method: 'GET',
        url: '/categories/rules',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(listA.statusCode).toBe(200);
      expect(listA.json().rules.some((r: { id: string }) => r.id === ruleId)).toBe(true);

      const listB = await app.inject({
        method: 'GET',
        url: '/categories/rules',
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
      });
      expect(listB.statusCode).toBe(200);
      expect(listB.json().rules).toHaveLength(0);

      const crossDelete = await app.inject({
        method: 'DELETE',
        url: `/categories/rules/${ruleId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
      });
      expect(crossDelete.statusCode).toBe(404);

      const ownDelete = await app.inject({
        method: 'DELETE',
        url: `/categories/rules/${ruleId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(ownDelete.statusCode).toBe(204);
    });
  },
);
