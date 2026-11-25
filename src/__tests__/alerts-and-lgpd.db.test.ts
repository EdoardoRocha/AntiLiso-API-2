import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { prisma } from '../infra/database/prisma.js';
import { ACCESS_COOKIE_NAME } from '../shared/middlewares/authenticate.js';
import { generateTotpCode } from '../shared/security/totp.js';

describe.runIf(process.env.RUN_DB_TESTS === 'true')(
  'Etapa 10 — Alertas Proativos (RF-07), 2FA TOTP e Exportação LGPD (RNF-03)',
  () => {
    let app: FastifyInstance;
    let userAId = '';
    let userAEmail = '';
    let userAToken = '';
    let userBId = '';
    let userBEmail = '';
    let userBToken = '';
    let contaPadraoAId = '';
    let catLazerAId = '';
    let catSalarioAId = '';

    beforeAll(async () => {
      app = await buildApp({ logger: false });

      userAEmail = `rf07-a-${randomUUID()}@antiliso.local`;
      userBEmail = `rf07-b-${randomUUID()}@antiliso.local`;

      const [regA, regB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            nome: 'RF07 User A',
            email: userAEmail,
            senha: 'SenhaForte@2026',
            custoVidaMensal: 1500,
          },
        }),
        app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            nome: 'RF07 User B',
            email: userBEmail,
            senha: 'SenhaForte@2026',
          },
        }),
      ]);

      expect(regA.statusCode).toBe(201);
      expect(regB.statusCode).toBe(201);

      userAId = regA.json().user.id;
      userAToken = regA.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!.value;
      userBId = regB.json().user.id;
      userBToken = regB.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!.value;

      const [accountsARes, catsARes] = await Promise.all([
        app.inject({
          method: 'GET',
          url: '/accounts',
          cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        }),
        app.inject({
          method: 'GET',
          url: '/categories',
          cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        }),
      ]);

      const accountsA = accountsARes.json().accounts as Array<{
        id: string;
        ehContaPadrao: boolean;
      }>;
      contaPadraoAId = accountsA.find((a) => a.ehContaPadrao)!.id;

      const catsA = catsARes.json().categories as Array<{ id: string; nome: string }>;
      catLazerAId = catsA.find((c) => c.nome === 'Lazer')!.id;
      catSalarioAId = catsA.find((c) => c.nome === 'Salário')!.id;
    });

    afterAll(async () => {
      const ids = [userAId, userBId].filter(Boolean);
      if (ids.length > 0) {
        await prisma.alertaNotificacao.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.ativoCarteira.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.alocacaoAlvo.deleteMany({ where: { usuarioId: { in: ids } } });
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

    it('gera alertas idempotentes VENC (48h + fatura cartão), ORCAM (80%/100%) e RESUMO semanal com leitura e isolamento (RF-07)', async () => {
      // Orçamento de R$ 500 em Lazer
      const budgetRes = await app.inject({
        method: 'PATCH',
        url: `/categories/${catLazerAId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { orcamentoMensal: 500 },
      });
      expect(budgetRes.statusCode).toBe(200);

      // Receita de novembro + despesa de Lazer R$ 425 (85% do orçamento) + conta pendente em 24h (2026-11-21)
      await Promise.all([
        app.inject({
          method: 'POST',
          url: '/transactions',
          cookies: { [ACCESS_COOKIE_NAME]: userAToken },
          payload: {
            tipo: 'REC',
            valor: 4000,
            descricao: 'Salário Novembro',
            contaId: contaPadraoAId,
            categoriaId: catSalarioAId,
            dataCompetencia: '2026-11-18',
            status: 'PAGO',
          },
        }),
        app.inject({
          method: 'POST',
          url: '/transactions',
          cookies: { [ACCESS_COOKIE_NAME]: userAToken },
          payload: {
            tipo: 'DESP',
            valor: 425,
            descricao: 'Show de Música',
            contaId: contaPadraoAId,
            categoriaId: catLazerAId,
            dataCompetencia: '2026-11-19',
            status: 'PAGO',
          },
        }),
        app.inject({
          method: 'POST',
          url: '/transactions',
          cookies: { [ACCESS_COOKIE_NAME]: userAToken },
          payload: {
            tipo: 'DESP',
            valor: 190,
            descricao: 'Internet Fibra',
            contaId: contaPadraoAId,
            dataCompetencia: '2026-11-21',
            status: 'PENDENTE',
          },
        }),
      ]);

      // Cartão vencendo dia 22 (fechamento dia 15 -> fatura de 2026-11 vence 2026-11-22 = 48h de 2026-11-20)
      const cardRes = await app.inject({
        method: 'POST',
        url: '/credit-cards',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          nome: 'Visa RF07',
          contaPagamentoId: contaPadraoAId,
          limiteTotal: 2000,
          tetoMensalAlerta: 1000,
          diaFechamento: 15,
          diaVencimento: 22,
        },
      });
      expect(cardRes.statusCode).toBe(201);
      const cardId = cardRes.json().card.id as string;

      await app.inject({
        method: 'POST',
        url: '/transactions',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          tipo: 'DESP',
          valor: 310,
          descricao: 'Mercado Fatura',
          cartaoId: cardId,
          dataCompetencia: '2026-11-10',
        },
      });

      const firstAlertsRes = await app.inject({
        method: 'GET',
        url: '/alerts?date=2026-11-20',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(firstAlertsRes.statusCode).toBe(200);
      const firstBody = firstAlertsRes.json();
      expect(firstBody.createdCount).toBe(4); // 2 VENC (Internet + Fatura Visa) + 1 ORCAM 80% + 1 RESUMO
      expect(firstBody.unreadCount).toBe(4);
      expect(firstBody.weeklyDigest).toMatchObject({
        isoWeek: '2026-W47',
        receitas7d: 4000,
        despesas7d: 425,
        contasVencendo48hCount: 2,
      });

      // Re-sincronizar na mesma data não duplica alertas
      const idempotentSync = await app.inject({
        method: 'POST',
        url: '/alerts/sync',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { date: '2026-11-20', canal: 'EMAIL' },
      });
      expect(idempotentSync.statusCode).toBe(200);
      expect(idempotentSync.json().createdCount).toBe(0);

      // Escalar Lazer acima de 100% (425 + 100 = 525 / 500 = 105%) dispara alerta ORCAM 100%
      await app.inject({
        method: 'POST',
        url: '/transactions',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          tipo: 'DESP',
          valor: 100,
          descricao: 'Cinema extra',
          contaId: contaPadraoAId,
          categoriaId: catLazerAId,
          dataCompetencia: '2026-11-20',
          status: 'PAGO',
        },
      });

      const secondSync = await app.inject({
        method: 'POST',
        url: '/alerts/sync',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { date: '2026-11-20', canal: 'WHATS' },
      });
      expect(secondSync.statusCode).toBe(200);
      expect(secondSync.json().createdCount).toBe(1);

      // Leitura individual, read-all e isolamento entre usuários
      const alertId = firstBody.alerts[0].id as string;
      const foreignRead = await app.inject({
        method: 'PATCH',
        url: `/alerts/${alertId}/read`,
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
        payload: { lido: true },
      });
      expect(foreignRead.statusCode).toBe(404);

      const readOne = await app.inject({
        method: 'PATCH',
        url: `/alerts/${alertId}/read`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { lido: true },
      });
      expect(readOne.statusCode).toBe(200);
      expect(readOne.json().alert.lido).toBe(true);

      const readAll = await app.inject({
        method: 'POST',
        url: '/alerts/read-all',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(readAll.statusCode).toBe(200);

      const afterReadAll = await app.inject({
        method: 'GET',
        url: '/alerts?date=2026-11-20&autoSync=false',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(afterReadAll.json().unreadCount).toBe(0);
    });

    it('ativa, exige no login e desativa 2FA TOTP opcional mantendo isolamento (RNF-03)', async () => {
      const setupRes = await app.inject({
        method: 'POST',
        url: '/auth/2fa/setup',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(setupRes.statusCode).toBe(200);
      const { secret, otpauthUrl, twoFactorEnabled } = setupRes.json() as {
        secret: string;
        otpauthUrl: string;
        twoFactorEnabled: boolean;
      };
      expect(twoFactorEnabled).toBe(false);
      expect(otpauthUrl).toContain(`secret=${secret}`);

      // Código errado rejeitado ao ativar
      const invalidEnable = await app.inject({
        method: 'POST',
        url: '/auth/2fa/enable',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { codigoTotp: '000000' },
      });
      expect(invalidEnable.statusCode).toBe(400);

      // Código TOTP válido ativa 2FA
      const validEnable = await app.inject({
        method: 'POST',
        url: '/auth/2fa/enable',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { codigoTotp: generateTotpCode(secret) },
      });
      expect(validEnable.statusCode).toBe(200);
      expect(validEnable.json().user.twoFactorEnabled).toBe(true);

      // Login sem código -> 401 TWO_FACTOR_REQUIRED
      const loginNoCode = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: userAEmail, senha: 'SenhaForte@2026' },
      });
      expect(loginNoCode.statusCode).toBe(401);
      expect(loginNoCode.json().error).toBe('TWO_FACTOR_REQUIRED');

      // Login com código válido -> 200 OK
      const loginWithCode = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: userAEmail,
          senha: 'SenhaForte@2026',
          codigoTotp: generateTotpCode(secret),
        },
      });
      expect(loginWithCode.statusCode).toBe(200);

      // Desativa 2FA com senha atual
      const disableRes = await app.inject({
        method: 'POST',
        url: '/auth/2fa/disable',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { senhaAtual: 'SenhaForte@2026' },
      });
      expect(disableRes.statusCode).toBe(200);
      expect(disableRes.json().user.twoFactorEnabled).toBe(false);
    });

    it('exporta integralmente os dados LGPD em JSON e CSV sem expor senhaHash ou dados de terceiros (RNF-03)', async () => {
      const [jsonRes, csvRes] = await Promise.all([
        app.inject({
          method: 'GET',
          url: '/export?format=json',
          cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        }),
        app.inject({
          method: 'GET',
          url: '/export?format=csv',
          cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        }),
      ]);

      expect(jsonRes.statusCode).toBe(200);
      expect(jsonRes.headers['content-disposition']).toContain(
        'attachment; filename="antiliso-lgpd-',
      );
      const jsonBody = jsonRes.json();
      expect(jsonBody.usuario.email).toBe(userAEmail);
      expect(jsonBody.contas.length).toBeGreaterThanOrEqual(2);
      expect(jsonBody.transacoes.length).toBeGreaterThanOrEqual(4);
      expect(jsonBody.alertasNotificacoes.length).toBeGreaterThanOrEqual(4);

      const serializedJson = JSON.stringify(jsonBody);
      expect(serializedJson).not.toContain('senhaHash');
      expect(serializedJson).not.toContain(userBEmail);

      expect(csvRes.statusCode).toBe(200);
      expect(csvRes.headers['content-type']).toContain('text/csv');
      const csvText = csvRes.body;
      expect(csvText.startsWith('\uFEFF')).toBe(true);
      expect(csvText).toContain('"USUARIOS"');
      expect(csvText).toContain('"TRANSACOES"');
      expect(csvText).toContain('"ALERTAS_NOTIFICACOES"');
      expect(csvText).not.toContain(userBEmail);
    });
  },
);
