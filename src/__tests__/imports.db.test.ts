import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { prisma } from '../infra/database/prisma.js';
import { ACCESS_COOKIE_NAME } from '../shared/middlewares/authenticate.js';

describe.runIf(process.env.RUN_DB_TESTS === 'true')(
  'Etapa 8 — Importação OFX/CSV e Deduplicação Automática (RF-02)',
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
    let catTransporteAId = '';
    let cardAId = '';

    beforeAll(async () => {
      app = await buildApp({ logger: false });

      const [regA, regB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            nome: 'RF02 User A',
            email: `rf02-a-${randomUUID()}@antiliso.local`,
            senha: 'SenhaForte@2026',
            pctPaguePrimeiro: 10,
          },
        }),
        app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            nome: 'RF02 User B',
            email: `rf02-b-${randomUUID()}@antiliso.local`,
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
      catTransporteAId = catsA.find((c) => c.nome === 'Transporte')!.id;

      await prisma.conta.update({
        where: { id: contaPadraoAId },
        data: { saldoAtual: '1000.00' },
      });

      const cardRes = await app.inject({
        method: 'POST',
        url: '/credit-cards',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          nome: 'Nubank RF02',
          contaPagamentoId: contaPadraoAId,
          limiteTotal: 2000,
          tetoMensalAlerta: 400,
          diaFechamento: 25,
          diaVencimento: 5,
        },
      });
      expect(cardRes.statusCode).toBe(201);
      cardAId = cardRes.json().card.id as string;

      // Cria regra de aprendizado prévia (RF-03) para testar sugestão em lote no preview
      const ruleRes = await app.inject({
        method: 'POST',
        url: '/categories/rules',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          termoChave: 'ifood',
          categoriaId: catAlimentacaoAId,
        },
      });
      expect(ruleRes.statusCode).toBe(201);
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

    it('bloqueia importação em conta COFRE e valida isolamento multi-tenant', async () => {
      const vaultRes = await app.inject({
        method: 'POST',
        url: '/imports/preview',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          fileName: 'extrato.csv',
          content: 'Data;Descrição;Valor\n10/11/2026;Padaria;-20,00',
          targetType: 'CONTA',
          contaId: contaCofreAId,
        },
      });
      expect(vaultRes.statusCode).toBe(400);
      expect(vaultRes.json().error).toBe('VAULT_IMPORT_BLOCKED');

      const foreignAccountRes = await app.inject({
        method: 'POST',
        url: '/imports/preview',
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
        payload: {
          fileName: 'extrato.csv',
          content: 'Data;Descrição;Valor\n10/11/2026;Padaria;-20,00',
          targetType: 'CONTA',
          contaId: contaPadraoAId,
        },
      });
      expect(foreignAccountRes.statusCode).toBe(404);

      const foreignCardRes = await app.inject({
        method: 'POST',
        url: '/imports/preview',
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
        payload: {
          fileName: 'fatura.csv',
          content: 'date,title,amount\n2026-11-10,Padaria,20.00',
          targetType: 'CARTAO',
          cartaoId: cardAId,
        },
      });
      expect(foreignCardRes.statusCode).toBe(404);
    });

    it('importa extrato OFX em conta líquida com sugestão RF-03, atualiza saldo e garante idempotência total no reenvio', async () => {
      const ofxContent = `OFXHEADER:100
<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20261105120000[-3:BRT]
<TRNAMT>4000.00
<FITID>BANK-SAL-01
<MEMO>Salário Empresa Tech
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261106190000[-3:BRT]
<TRNAMT>-75.50
<FITID>BANK-IFOOD-01
<MEMO>IFOOD *BURGER KING
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261107080000[-3:BRT]
<TRNAMT>-120.00
<FITID>BANK-EXAME-01
<MEMO>DROGARIA RAIA
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

      const previewRes = await app.inject({
        method: 'POST',
        url: '/imports/preview',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          fileName: 'novembro.ofx',
          content: ofxContent,
          targetType: 'CONTA',
          contaId: contaPadraoAId,
        },
      });
      expect(previewRes.statusCode).toBe(200);
      const preview = previewRes.json();
      expect(preview.format).toBe('OFX');
      expect(preview.summary).toMatchObject({
        totalRows: 3,
        readyCount: 3,
        exactDuplicateCount: 0,
        fuzzyDuplicateCount: 0,
        ignoredCount: 0,
        estimatedReceitas: 4000,
        estimatedDespesas: 195.5,
        estimatedNetImpact: 3804.5,
      });

      // Linha 0: Salário por nome da categoria; Linha 1: iFood pela RegraAprendizado
      expect(preview.items[0].categoriaSugeridaId).toBe(catSalarioAId);
      expect(preview.items[1].categoriaSugeridaId).toBe(catAlimentacaoAId);
      expect(preview.items[1].suggestionSource).toBe('RULE');

      const commitPayload = {
        targetType: 'CONTA',
        contaId: contaPadraoAId,
        items: preview.items.map((item: (typeof preview.items)[number], idx: number) => ({
          dataCompetencia: item.dataCompetencia,
          descricao: item.descricao,
          valor: item.valor,
          tipo: item.tipo,
          categoriaId: idx === 2 ? catTransporteAId : item.categoriaSugeridaId,
          hashDedup: item.hashDedup,
        })),
      };

      const commitRes = await app.inject({
        method: 'POST',
        url: '/imports/commit',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: commitPayload,
      });
      expect(commitRes.statusCode).toBe(201);
      expect(commitRes.json()).toMatchObject({
        targetType: 'CONTA',
        targetId: contaPadraoAId,
        importedCount: 3,
        skippedDuplicateCount: 0,
        totalReceitasImportadas: 4000,
        totalDespesasImportadas: 195.5,
        netBalanceDelta: 3804.5,
        cardAlert: null,
      });

      // Saldo: 1000 + 3804.50 = 4804.50
      const contaAfterFirst = await prisma.conta.findUniqueOrThrow({
        where: { id: contaPadraoAId },
      });
      expect(Number(contaAfterFirst.saldoAtual)).toBe(4804.5);

      // Reimportar o mesmo OFX deve marcar tudo como DUPLICADO_HASH
      const secondPreviewRes = await app.inject({
        method: 'POST',
        url: '/imports/preview',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          fileName: 'novembro.ofx',
          content: ofxContent,
          targetType: 'CONTA',
          contaId: contaPadraoAId,
        },
      });
      expect(secondPreviewRes.statusCode).toBe(200);
      expect(secondPreviewRes.json().summary.readyCount).toBe(0);
      expect(secondPreviewRes.json().summary.exactDuplicateCount).toBe(3);

      // Mesmo se forçar commit dos mesmos itens, é 100% idempotente e não altera saldo
      const secondCommitRes = await app.inject({
        method: 'POST',
        url: '/imports/commit',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: commitPayload,
      });
      expect(secondCommitRes.statusCode).toBe(201);
      expect(secondCommitRes.json()).toMatchObject({
        importedCount: 0,
        skippedDuplicateCount: 3,
        netBalanceDelta: 0,
      });

      const contaAfterSecond = await prisma.conta.findUniqueOrThrow({
        where: { id: contaPadraoAId },
      });
      expect(Number(contaAfterSecond.saldoAtual)).toBe(4804.5);

      // Aprendizado RF-03 gravado para "drogaria" -> catTransporteAId (escolhida manualmente no commit)
      const learnedRule = await prisma.regraAprendizado.findUnique({
        where: {
          usuarioId_termoChave: {
            usuarioId: userAId,
            termoChave: 'drogaria',
          },
        },
      });
      expect(learnedRule?.categoriaId).toBe(catTransporteAId);
    });

    it('detecta possível duplicata contra lançamento manual Quick-Add (±1 dia) e preserva compras gêmeas do extrato', async () => {
      // Usuário lança manualmente no Quick-Add um café de R$ 18,00 no dia 2026-11-10
      const quickRes = await app.inject({
        method: 'POST',
        url: '/transactions/quick-add',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          texto: 'Café expresso 18 pix',
          dataCompetencia: '2026-11-10',
        },
      });
      expect(quickRes.statusCode).toBe(201);

      // Extrato CSV traz: 1) Café dia 11 (-18,00), 2) Passagem (-5,50), 3) Passagem (-5,50)
      const csvContent = `\uFEFFData;Descrição;Valor
11/11/2026;Padaria Cafe Expresso;-18,00
12/11/2026;Metro SP;-5,50
12/11/2026;Metro SP;-5,50`;

      const previewRes = await app.inject({
        method: 'POST',
        url: '/imports/preview',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          fileName: 'extrato-parcial.csv',
          content: csvContent,
          targetType: 'CONTA',
          contaId: contaPadraoAId,
        },
      });
      expect(previewRes.statusCode).toBe(200);
      const preview = previewRes.json();

      expect(preview.summary).toMatchObject({
        totalRows: 3,
        readyCount: 2,
        fuzzyDuplicateCount: 1,
        exactDuplicateCount: 0,
      });

      expect(preview.items[0].status).toBe('POSSIVEL_DUPLICATA_MANUAL');
      expect(preview.items[0].selectedByDefault).toBe(false);
      expect(preview.items[0].matchedManualTransaction?.id).toBe(quickRes.json().transaction.id);

      expect(preview.items[1].status).toBe('NOVO');
      expect(preview.items[2].status).toBe('NOVO');
      expect(preview.items[1].hashDedup).not.toBe(preview.items[2].hashDedup);

      // Importa apenas os 2 selecionados por padrão (as duas passagens idênticas)
      const selected = preview.items.filter(
        (i: (typeof preview.items)[number]) => i.selectedByDefault,
      );
      const commitRes = await app.inject({
        method: 'POST',
        url: '/imports/commit',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          targetType: 'CONTA',
          contaId: contaPadraoAId,
          items: selected.map((item: (typeof preview.items)[number]) => ({
            dataCompetencia: item.dataCompetencia,
            descricao: item.descricao,
            valor: item.valor,
            tipo: item.tipo,
            categoriaId: catTransporteAId,
            hashDedup: item.hashDedup,
          })),
        },
      });
      expect(commitRes.statusCode).toBe(201);
      expect(commitRes.json().importedCount).toBe(2);
      expect(commitRes.json().totalDespesasImportadas).toBe(11);
    });

    it('importa fatura CSV no Cartão sem alterar saldo em conta, ignora pagamento recebido, dispara alerta de teto e impacta Safe-to-Spend', async () => {
      const contaAntes = await prisma.conta.findUniqueOrThrow({ where: { id: contaPadraoAId } });
      const saldoAntes = Number(contaAntes.saldoAtual);

      const safeBefore = await app.inject({
        method: 'GET',
        url: '/safe-to-spend?date=2026-11-21',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(safeBefore.statusCode).toBe(200);
      const variaveisAntes = safeBefore.json().breakdown.gastosVariaveisRealizados as number;

      const cardCsv = `date,category,title,amount
2026-11-02,pagamento,Pagamento recebido,-900.00
2026-11-15,lazer,Restaurante Sabor,280.00
2026-11-18,eletronicos,Loja Tech,200.00`;

      const previewRes = await app.inject({
        method: 'POST',
        url: '/imports/preview',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          fileName: 'fatura-nubank-nov.csv',
          content: cardCsv,
          targetType: 'CARTAO',
          cartaoId: cardAId,
        },
      });
      expect(previewRes.statusCode).toBe(200);
      const preview = previewRes.json();

      expect(preview.summary).toMatchObject({
        totalRows: 3,
        readyCount: 2,
        ignoredCount: 1,
        estimatedDespesas: 480,
        estimatedNetImpact: 480,
      });
      expect(preview.items[0].status).toBe('IGNORADO_CREDITO_CARTAO');
      expect(preview.items[0].canImport).toBe(false);

      const selected = preview.items.filter(
        (i: (typeof preview.items)[number]) => i.selectedByDefault,
      );
      const commitRes = await app.inject({
        method: 'POST',
        url: '/imports/commit',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          targetType: 'CARTAO',
          cartaoId: cardAId,
          items: selected.map((item: (typeof preview.items)[number]) => ({
            dataCompetencia: item.dataCompetencia,
            descricao: item.descricao,
            valor: item.valor,
            tipo: 'DESP',
            categoriaId: catAlimentacaoAId,
            hashDedup: item.hashDedup,
          })),
        },
      });
      expect(commitRes.statusCode).toBe(201);
      expect(commitRes.json()).toMatchObject({
        targetType: 'CARTAO',
        targetId: cardAId,
        importedCount: 2,
        netBalanceDelta: 0,
        cardAlert: {
          cardId: cardAId,
          month: '2026-11',
          totalFatura: 480,
          tetoMensalAlerta: 400,
          status: 'ATINGIDO',
        },
      });

      // Saldo bancário continua absolutamente igual
      const contaDepois = await prisma.conta.findUniqueOrThrow({ where: { id: contaPadraoAId } });
      expect(Number(contaDepois.saldoAtual)).toBe(saldoAntes);

      // Limite utilizado do cartão = 480 (PENDENTE)
      const cardsRes = await app.inject({
        method: 'GET',
        url: '/credit-cards?date=2026-11-21',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(cardsRes.statusCode).toBe(200);
      expect(cardsRes.json().cards[0].limiteUtilizado).toBe(480);

      // Safe-to-Spend passa a considerar os R$ 480 imediatamente pela competência
      const safeAfter = await app.inject({
        method: 'GET',
        url: '/safe-to-spend?date=2026-11-21',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(safeAfter.statusCode).toBe(200);
      expect(safeAfter.json().breakdown.gastosVariaveisRealizados).toBe(variaveisAntes + 480);
    });
  },
);
