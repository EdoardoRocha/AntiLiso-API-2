import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { prisma } from '../infra/database/prisma.js';
import { ACCESS_COOKIE_NAME } from '../shared/middlewares/authenticate.js';

describe.runIf(process.env.RUN_DB_TESTS === 'true')(
  'Etapa 6 — Cartão de Crédito por Competência e Faturas (RF-06 / RN-02)',
  () => {
    let app: FastifyInstance;
    let userAId = '';
    let userAToken = '';
    let userBId = '';
    let userBToken = '';
    let contaPadraoAId = '';
    let contaCofreAId = '';
    let catSalarioAId = '';
    let catAlimentacaoAId = '';
    let catAssinaturasAId = '';

    beforeAll(async () => {
      app = await buildApp({ logger: false });

      const [regA, regB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            nome: 'RF06 User A',
            email: `rf06-a-${randomUUID()}@antiliso.local`,
            senha: 'SenhaForte@2026',
            pctPaguePrimeiro: 10,
          },
        }),
        app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            nome: 'RF06 User B',
            email: `rf06-b-${randomUUID()}@antiliso.local`,
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
        tipo: string;
        ehContaPadrao: boolean;
      }>;
      contaPadraoAId = accountsA.find((a) => a.ehContaPadrao)!.id;
      contaCofreAId = accountsA.find((a) => a.tipo === 'COFRE')!.id;

      const catsA = catsARes.json().categories as Array<{ id: string; nome: string }>;
      catSalarioAId = catsA.find((c) => c.nome === 'Salário')!.id;
      catAlimentacaoAId = catsA.find((c) => c.nome === 'Alimentação')!.id;
      catAssinaturasAId = catsA.find((c) => c.nome === 'Assinaturas')!.id;

      await prisma.conta.update({
        where: { id: contaPadraoAId },
        data: { saldoAtual: '2000.00' },
      });
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

    it('valida criação/atualização de cartão, bloqueia COFRE como conta pagadora e isola entre usuários', async () => {
      const invalidCeilingRes = await app.inject({
        method: 'POST',
        url: '/credit-cards',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          nome: 'Teto Inválido',
          contaPagamentoId: contaPadraoAId,
          limiteTotal: 1000,
          tetoMensalAlerta: 1500,
          diaFechamento: 25,
          diaVencimento: 5,
        },
      });
      expect(invalidCeilingRes.statusCode).toBe(400);

      const cofrePayRes = await app.inject({
        method: 'POST',
        url: '/credit-cards',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          nome: 'Cofre Bloqueado',
          contaPagamentoId: contaCofreAId,
          limiteTotal: 2000,
          tetoMensalAlerta: 800,
          diaFechamento: 25,
          diaVencimento: 5,
        },
      });
      expect(cofrePayRes.statusCode).toBe(400);
      expect(cofrePayRes.json().error).toBe('INVALID_PAYMENT_ACCOUNT');

      const createRes = await app.inject({
        method: 'POST',
        url: '/credit-cards',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          nome: 'Nubank Principal',
          contaPagamentoId: contaPadraoAId,
          limiteTotal: 3000,
          tetoMensalAlerta: 500,
          diaFechamento: 25,
          diaVencimento: 5,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const cardId = createRes.json().card.id as string;

      const userBGet = await app.inject({
        method: 'GET',
        url: `/credit-cards/${cardId}/invoice?month=2026-11`,
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
      });
      expect(userBGet.statusCode).toBe(404);

      const deleteUnused = await app.inject({
        method: 'DELETE',
        url: `/credit-cards/${cardId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(deleteUnused.statusCode).toBe(204);
    });

    it('separa limite do cartão do saldo bancário, aplica competência no Safe-to-Spend, alerta teto, vira fatura após fechamento e quita sem dupla contagem', async () => {
      const cardRes = await app.inject({
        method: 'POST',
        url: '/credit-cards',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          nome: 'Inter Black',
          contaPagamentoId: contaPadraoAId,
          limiteTotal: 3000,
          tetoMensalAlerta: 500,
          diaFechamento: 25,
          diaVencimento: 5,
        },
      });
      expect(cardRes.statusCode).toBe(201);
      const cardId = cardRes.json().card.id as string;

      // Receita de novembro = R$ 3.000 (10% reserva = R$ 300 -> saldo livre base = R$ 2.700)
      const incomeRes = await app.inject({
        method: 'POST',
        url: '/transactions',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          tipo: 'REC',
          valor: 3000,
          descricao: 'Salário Novembro',
          contaId: contaPadraoAId,
          categoriaId: catSalarioAId,
          dataCompetencia: '2026-11-05',
          status: 'PAGO',
        },
      });
      expect(incomeRes.statusCode).toBe(201);
      // Saldo da conta agora: 2000 + 3000 = 5000
      let contaDb = await prisma.conta.findUniqueOrThrow({ where: { id: contaPadraoAId } });
      expect(Number(contaDb.saldoAtual)).toBe(5000);

      // Compra #1 no cartão (R$ 200): status PENDENTE, não altera conta, desconta competência em Safe-to-Spend
      const buy1Res = await app.inject({
        method: 'POST',
        url: '/transactions',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          tipo: 'DESP',
          valor: 200,
          descricao: 'Supermercado Cartão',
          cartaoId: cardId,
          categoriaId: catAlimentacaoAId,
          dataCompetencia: '2026-11-10',
        },
      });
      expect(buy1Res.statusCode).toBe(201);
      expect(buy1Res.json().transaction.status).toBe('PENDENTE');
      expect(buy1Res.json().transaction.contaId).toBeNull();
      expect(buy1Res.json().transaction.cartaoId).toBe(cardId);
      expect(buy1Res.json().cardAlert).toBeNull();

      // Compra #2 via Quick-Add texto ("Jantar 320 crédito") -> soma 520 >= teto 500 -> ATINGIDO!
      const buy2Res = await app.inject({
        method: 'POST',
        url: '/transactions/quick-add',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          texto: 'Jantar 320 crédito',
          dataCompetencia: '2026-11-20',
        },
      });
      expect(buy2Res.statusCode).toBe(201);
      const buy2Json = buy2Res.json();
      expect(buy2Json.transaction.cartaoId).toBe(cardId);
      expect(buy2Json.transaction.status).toBe('PENDENTE');
      expect(buy2Json.parsed.metodoDetectado).toBe('credito');
      expect(buy2Json.cardAlert).toMatchObject({
        cardId,
        month: '2026-11',
        totalFatura: 520,
        tetoMensalAlerta: 500,
        status: 'ATINGIDO',
      });

      // Saldo da conta deve continuar intocado (5000)
      contaDb = await prisma.conta.findUniqueOrThrow({ where: { id: contaPadraoAId } });
      expect(Number(contaDb.saldoAtual)).toBe(5000);

      // Assinatura recorrente vinculada ao cartão (dia 15 -> entra na fatura de novembro)
      const recCardRes = await app.inject({
        method: 'POST',
        url: '/recurrences',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          descricao: 'Streaming 4K',
          valorEstimado: 50,
          diaVencimento: 15,
          categoriaId: catAssinaturasAId,
          cartaoId: cardId,
        },
      });
      expect(recCardRes.statusCode).toBe(201);
      expect(recCardRes.json().recurrence.cartaoId).toBe(cardId);
      expect(recCardRes.json().recurrence.contaId).toBeNull();

      // Safe-to-Spend em 2026-11-21 (10 dias restantes):
      // Receita 3000 - Fixa cartão 50 - Reserva (10% = 300) - Variáveis cartão (520) = 2130 / 10 = 213
      const safeBeforePay = await app.inject({
        method: 'GET',
        url: '/safe-to-spend?date=2026-11-21',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(safeBeforePay.statusCode).toBe(200);
      expect(safeBeforePay.json().breakdown.contasFixasPendentes).toBe(50);
      expect(safeBeforePay.json().breakdown.gastosVariaveisRealizados).toBe(520);
      expect(safeBeforePay.json().saldoLivreMes).toBe(2130);
      expect(safeBeforePay.json().quantoPossoGastarHoje).toBe(213);

      // Compra pós-fechamento (2026-11-27 > dia 25) deve cair na fatura de 2026-12!
      const buyDecRes = await app.inject({
        method: 'POST',
        url: '/transactions',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          tipo: 'DESP',
          valor: 100,
          descricao: 'Café Pós-Fechamento',
          cartaoId: cardId,
          categoriaId: catAlimentacaoAId,
          dataCompetencia: '2026-11-27',
        },
      });
      expect(buyDecRes.statusCode).toBe(201);

      const novInvoiceRes = await app.inject({
        method: 'GET',
        url: `/credit-cards/${cardId}/invoice?month=2026-11&date=2026-11-27`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(novInvoiceRes.statusCode).toBe(200);
      expect(novInvoiceRes.json().statusFatura).toBe('FECHADA');
      expect(novInvoiceRes.json().totalFatura).toBe(570); // 200 + 320 + 50
      expect(novInvoiceRes.json().alertaTetoStatus).toBe('ATINGIDO');
      expect(novInvoiceRes.json().limiteUtilizado).toBe(670); // 570 + 100 (dec)
      expect(novInvoiceRes.json().limiteDisponivel).toBe(2330);

      const decInvoiceRes = await app.inject({
        method: 'GET',
        url: `/credit-cards/${cardId}/invoice?month=2026-12&date=2026-11-27`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(decInvoiceRes.statusCode).toBe(200);
      expect(decInvoiceRes.json().statusFatura).toBe('ABERTA');
      expect(decInvoiceRes.json().totalFatura).toBe(150); // 100 pós-fechamento + 50 assinatura 2026-12

      // Impede exclusão do cartão em uso (409 CARD_IN_USE)
      const deleteInUseRes = await app.inject({
        method: 'DELETE',
        url: `/credit-cards/${cardId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(deleteInUseRes.statusCode).toBe(409);
      expect(deleteInUseRes.json().error).toBe('CARD_IN_USE');

      // Pagamento ACID da fatura de novembro (R$ 570)
      const payRes = await app.inject({
        method: 'POST',
        url: `/credit-cards/${cardId}/invoices/2026-11/pay`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          contaPagamentoId: contaPadraoAId,
          dataPagamento: '2026-11-28',
        },
      });
      expect(payRes.statusCode).toBe(200);
      expect(payRes.json().valorPago).toBe(570);
      expect(payRes.json().settledCount).toBe(3);

      // Conta paga R$ 570: 5000 -> 4430
      contaDb = await prisma.conta.findUniqueOrThrow({ where: { id: contaPadraoAId } });
      expect(Number(contaDb.saldoAtual)).toBe(4430);

      // Limite utilizado cai para apenas os 150 de dezembro (100 pós-fechamento + 50 assinatura)
      const cardsAfterPay = await app.inject({
        method: 'GET',
        url: '/credit-cards?date=2026-11-28',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(cardsAfterPay.statusCode).toBe(200);
      expect(cardsAfterPay.json().cards[0].limiteUtilizado).toBe(150);
      expect(cardsAfterPay.json().cards[0].limiteDisponivel).toBe(2850);

      // Safe-to-Spend em 2026-11-21 NÃO duplica os 570 pagos (520 variáveis + 50 fixa já estavam na competência; + 100 de 27/11 = 620 variáveis)
      const safeAfterPay = await app.inject({
        method: 'GET',
        url: '/safe-to-spend?date=2026-11-21',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(safeAfterPay.statusCode).toBe(200);
      expect(safeAfterPay.json().breakdown.contasFixasPagas).toBe(50);
      expect(safeAfterPay.json().breakdown.contasFixasPendentes).toBe(0);
      expect(safeAfterPay.json().breakdown.gastosVariaveisRealizados).toBe(620); // 520 + 100 (sem duplicar os 570 da fatura)

      // Impede alterar/excluir lançamento de cartão já quitado
      const settledId = buy1Res.json().transaction.id as string;
      const deleteSettled = await app.inject({
        method: 'DELETE',
        url: `/transactions/${settledId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(deleteSettled.statusCode).toBe(400);
      expect(deleteSettled.json().error).toBe('CARD_TRANSACTION_ALREADY_SETTLED');
    });
  },
);
