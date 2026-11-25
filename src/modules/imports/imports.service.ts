import { Prisma } from '@prisma/client';
import { prisma } from '../../infra/database/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { decimalToNumber, toDecimalString } from '../../shared/utils/money.js';
import { normalizeLearningText, rankMatchingRule } from '../categories/learning-rules.engine.js';
import { recordCategoryLearning } from '../categories/learning-rules.service.js';
import type { CardCeilingAlertDto } from '../credit-cards/credit-cards.schemas.js';
import { computeCardAlertForTransaction } from '../credit-cards/credit-cards.service.js';
import { roundCurrency } from '../safe-to-spend/safe-to-spend.engine.js';
import {
  detectImportFormat,
  matchFuzzyManualDuplicates,
  parseCsvStatement,
  parseOfxStatement,
  type ExistingManualTxCandidate,
} from './imports.engine.js';
import type {
  CommitImportInput,
  CommitImportItemInput,
  CommitImportResponseDto,
  ImportPreviewItemDto,
  ImportPreviewStatus,
  PreviewImportInput,
  PreviewImportResponseDto,
} from './imports.schemas.js';

type DbClient = Prisma.TransactionClient | typeof prisma;

function parseDateStrictUtc(isoDate: string): Date {
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== isoDate) {
    throw new AppError(`Data inválida: ${isoDate}`, 400, 'INVALID_DATE');
  }
  return parsed;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolveImportTarget(
  db: DbClient,
  userId: string,
  targetType: 'CONTA' | 'CARTAO',
  contaId?: string | null,
  cartaoId?: string | null,
): Promise<{ targetId: string; targetNome: string }> {
  if (targetType === 'CONTA') {
    const account = await db.conta.findFirst({
      where: { id: contaId ?? '', usuarioId: userId },
      select: { id: true, nome: true, tipo: true, ativa: true },
    });

    if (!account) {
      throw new AppError('Conta não encontrada.', 404, 'ACCOUNT_NOT_FOUND');
    }
    if (!account.ativa) {
      throw new AppError('A conta selecionada está inativa.', 400, 'INACTIVE_ACCOUNT');
    }
    if (account.tipo === 'COFRE') {
      throw new AppError(
        'Contas do tipo Cofre não aceitam importação direta de extratos.',
        400,
        'VAULT_IMPORT_BLOCKED',
      );
    }

    return { targetId: account.id, targetNome: account.nome };
  }

  const card = await db.cartaoCredito.findFirst({
    where: { id: cartaoId ?? '', usuarioId: userId },
    select: { id: true, nome: true },
  });

  if (!card) {
    throw new AppError('Cartão de crédito não encontrado.', 404, 'CARD_NOT_FOUND');
  }

  return { targetId: card.id, targetNome: card.nome };
}

interface BatchSuggestionResult {
  categoriaId: string;
  categoriaNome: string;
  source: 'RULE' | 'CATEGORY_NAME';
}

async function createBatchCategorySuggester(userId: string) {
  const [rules, categories] = await Promise.all([
    prisma.regraAprendizado.findMany({
      where: { usuarioId: userId },
      include: { categoria: { select: { id: true, nome: true, tipo: true } } },
    }),
    prisma.categoria.findMany({
      where: { usuarioId: userId },
      select: { id: true, nome: true, tipo: true },
    }),
  ]);

  const rulesByType = {
    RECEITA: rules.filter((r) => r.categoria.tipo === 'RECEITA'),
    DESPESA: rules.filter((r) => r.categoria.tipo === 'DESPESA'),
  };

  const categoriesByType = {
    RECEITA: categories
      .filter((c) => c.tipo === 'RECEITA')
      .map((c) => ({ ...c, normalized: normalizeLearningText(c.nome) }))
      .filter((c) => c.normalized.length > 0)
      .sort((a, b) => b.nome.length - a.nome.length),
    DESPESA: categories
      .filter((c) => c.tipo === 'DESPESA')
      .map((c) => ({ ...c, normalized: normalizeLearningText(c.nome) }))
      .filter((c) => c.normalized.length > 0)
      .sort((a, b) => b.nome.length - a.nome.length),
  };

  return (descricao: string, tipo: 'REC' | 'DESP'): BatchSuggestionResult | null => {
    const expectedType = tipo === 'REC' ? 'RECEITA' : 'DESPESA';
    const matchedRule = rankMatchingRule(descricao, rulesByType[expectedType]);
    if (matchedRule) {
      return {
        categoriaId: matchedRule.categoriaId,
        categoriaNome: matchedRule.categoria.nome,
        source: 'RULE',
      };
    }

    const normalizedInput = normalizeLearningText(descricao);
    if (!normalizedInput) {
      return null;
    }

    for (const category of categoriesByType[expectedType]) {
      const pattern = new RegExp(`(?:^|\\s)${escapeRegex(category.normalized)}(?:\\s|$)`);
      if (pattern.test(normalizedInput)) {
        return {
          categoriaId: category.id,
          categoriaNome: category.nome,
          source: 'CATEGORY_NAME',
        };
      }
    }

    return null;
  };
}

export async function previewImport(
  userId: string,
  input: PreviewImportInput,
): Promise<PreviewImportResponseDto> {
  const { targetId, targetNome } = await resolveImportTarget(
    prisma,
    userId,
    input.targetType,
    input.contaId,
    input.cartaoId,
  );

  const format = input.format ?? detectImportFormat(input.fileName, input.content);
  const parsedRows =
    format === 'OFX'
      ? parseOfxStatement(input.content, input.targetType, targetId)
      : parseCsvStatement(input.content, input.targetType, targetId);

  const candidateHashes = Array.from(
    new Set(
      parsedRows
        .map((row) => row.hashDedup)
        .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0),
    ),
  );

  const existingHashRecords =
    candidateHashes.length > 0
      ? await prisma.transacao.findMany({
          where: {
            usuarioId: userId,
            hashDedup: { in: candidateHashes },
          },
          select: { hashDedup: true },
        })
      : [];

  const exactDuplicateHashes = new Set(
    existingHashRecords
      .map((record) => record.hashDedup)
      .filter((hash): hash is string => hash !== null),
  );

  // Load potential manual transactions (Quick-Add / manual) within ±1 day window of parsed dates
  const validNonExactDates = parsedRows
    .filter(
      (row) => row.kind === 'VALIDO' && row.hashDedup && !exactDuplicateHashes.has(row.hashDedup),
    )
    .map((row) => row.dataCompetencia)
    .sort();

  let manualCandidates: ExistingManualTxCandidate[] = [];
  if (validNonExactDates.length > 0) {
    const minDate = parseDateStrictUtc(validNonExactDates[0]!);
    const maxDate = parseDateStrictUtc(validNonExactDates[validNonExactDates.length - 1]!);
    const windowStart = new Date(minDate.getTime() - 86_400_000);
    const windowEndInclusive = new Date(maxDate.getTime() + 86_400_000);

    const manualRows = await prisma.transacao.findMany({
      where: {
        usuarioId: userId,
        ...(input.targetType === 'CONTA' ? { contaId: targetId } : { cartaoId: targetId }),
        tipo: { in: ['REC', 'DESP'] },
        dataCompetencia: {
          gte: windowStart,
          lte: windowEndInclusive,
        },
        OR: [{ hashDedup: null }, { NOT: { hashDedup: { startsWith: 'imp:' } } }],
      },
      select: {
        id: true,
        descricao: true,
        valor: true,
        tipo: true,
        dataCompetencia: true,
      },
    });

    manualCandidates = manualRows
      .filter(
        (row): row is typeof row & { tipo: 'REC' | 'DESP' } =>
          row.tipo === 'REC' || row.tipo === 'DESP',
      )
      .map((row) => ({
        id: row.id,
        descricao: row.descricao,
        valor: decimalToNumber(row.valor),
        tipo: row.tipo,
        dataCompetencia: row.dataCompetencia.toISOString().slice(0, 10),
      }));
  }

  const fuzzyMatches = matchFuzzyManualDuplicates(
    parsedRows,
    exactDuplicateHashes,
    manualCandidates,
  );
  const suggestCategory = await createBatchCategorySuggester(userId);

  let readyCount = 0;
  let exactDuplicateCount = 0;
  let fuzzyDuplicateCount = 0;
  let ignoredCount = 0;
  let estimatedReceitas = 0;
  let estimatedDespesas = 0;

  const items: ImportPreviewItemDto[] = parsedRows.map((row, rowIndex) => {
    let status: ImportPreviewStatus;
    let statusReason: string | null = row.ignoreReason;
    const matchedManualTransaction = fuzzyMatches.get(rowIndex) ?? null;

    if (row.kind === 'IGNORADO_CREDITO_CARTAO') {
      status = 'IGNORADO_CREDITO_CARTAO';
      ignoredCount++;
    } else if (row.kind === 'IGNORADO_VALOR_ZERO') {
      status = 'IGNORADO_VALOR_ZERO';
      ignoredCount++;
    } else if (row.hashDedup && exactDuplicateHashes.has(row.hashDedup)) {
      status = 'DUPLICADO_HASH';
      statusReason = 'Lançamento já importado anteriormente.';
      exactDuplicateCount++;
    } else if (matchedManualTransaction) {
      status = 'POSSIVEL_DUPLICATA_MANUAL';
      statusReason = `Possível duplicata do lançamento manual "${matchedManualTransaction.descricao}" (${matchedManualTransaction.dataCompetencia}).`;
      fuzzyDuplicateCount++;
    } else {
      status = 'NOVO';
      readyCount++;
      if (row.tipo === 'REC') {
        estimatedReceitas = roundCurrency(estimatedReceitas + row.valor);
      } else {
        estimatedDespesas = roundCurrency(estimatedDespesas + row.valor);
      }
    }

    const canImport = status === 'NOVO' || status === 'POSSIVEL_DUPLICATA_MANUAL';
    const suggestion = canImport ? suggestCategory(row.descricao, row.tipo) : null;

    return {
      rowIndex,
      lineNumber: row.lineNumber,
      status,
      selectedByDefault: status === 'NOVO',
      canImport,
      statusReason,
      dataCompetencia: row.dataCompetencia,
      descricao: row.descricao,
      valor: row.valor,
      tipo: row.tipo,
      hashDedup: row.hashDedup,
      categoriaSugeridaId: suggestion?.categoriaId ?? null,
      categoriaSugeridaNome: suggestion?.categoriaNome ?? null,
      suggestionSource: suggestion?.source ?? null,
      matchedManualTransaction,
    };
  });

  const estimatedNetImpact =
    input.targetType === 'CONTA'
      ? roundCurrency(estimatedReceitas - estimatedDespesas)
      : roundCurrency(estimatedDespesas);

  return {
    format,
    targetType: input.targetType,
    targetId,
    targetNome,
    summary: {
      totalRows: items.length,
      readyCount,
      exactDuplicateCount,
      fuzzyDuplicateCount,
      ignoredCount,
      estimatedReceitas,
      estimatedDespesas,
      estimatedNetImpact,
    },
    items,
  };
}

export async function commitImport(
  userId: string,
  input: CommitImportInput,
): Promise<CommitImportResponseDto> {
  // Deduplicate hashes within the submitted payload itself
  const seenPayloadHashes = new Set<string>();
  const uniqueItems: CommitImportItemInput[] = [];
  let payloadDuplicateCount = 0;

  for (const item of input.items) {
    if (seenPayloadHashes.has(item.hashDedup)) {
      payloadDuplicateCount++;
      continue;
    }
    seenPayloadHashes.add(item.hashDedup);
    uniqueItems.push(item);
  }

  // Strictly validate all dates
  for (const item of uniqueItems) {
    parseDateStrictUtc(item.dataCompetencia);
  }

  // Validate categories in a single batch query
  const categoryIds = Array.from(
    new Set(
      uniqueItems
        .map((item) => item.categoriaId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  );

  if (categoryIds.length > 0) {
    const ownedCategories = await prisma.categoria.findMany({
      where: { usuarioId: userId, id: { in: categoryIds } },
      select: { id: true, tipo: true },
    });

    const categoryTypeMap = new Map(ownedCategories.map((c) => [c.id, c.tipo]));

    for (const item of uniqueItems) {
      if (!item.categoriaId) {
        continue;
      }
      const catType = categoryTypeMap.get(item.categoriaId);
      if (!catType) {
        throw new AppError('Categoria selecionada não encontrada.', 404, 'CATEGORY_NOT_FOUND');
      }
      const isCompatible =
        (item.tipo === 'REC' && catType === 'RECEITA') ||
        (item.tipo === 'DESP' && catType === 'DESPESA');
      if (!isCompatible) {
        throw new AppError(
          `Categoria incompatível para lançamento de ${item.tipo === 'REC' ? 'receita' : 'despesa'} ("${item.descricao}").`,
          400,
          'INCOMPATIBLE_CATEGORY_TYPE',
        );
      }
    }
  }

  let resolvedTargetId = '';
  let insertedItems: CommitImportItemInput[] = [];
  let dbDuplicateCount = 0;

  await prisma.$transaction(async (tx) => {
    const { targetId } = await resolveImportTarget(
      tx,
      userId,
      input.targetType,
      input.contaId,
      input.cartaoId,
    );
    resolvedTargetId = targetId;

    const existingRecords = await tx.transacao.findMany({
      where: {
        usuarioId: userId,
        hashDedup: { in: uniqueItems.map((item) => item.hashDedup) },
      },
      select: { hashDedup: true },
    });

    const existingHashes = new Set(
      existingRecords
        .map((record) => record.hashDedup)
        .filter((hash): hash is string => hash !== null),
    );

    const toInsert = uniqueItems.filter((item) => !existingHashes.has(item.hashDedup));
    dbDuplicateCount = uniqueItems.length - toInsert.length;

    if (toInsert.length === 0) {
      insertedItems = [];
      return;
    }

    await tx.transacao.createMany({
      data: toInsert.map((item) => ({
        usuarioId: userId,
        contaId: input.targetType === 'CONTA' ? targetId : null,
        contaDestinoId: null,
        cartaoId: input.targetType === 'CARTAO' ? targetId : null,
        categoriaId: item.categoriaId ?? null,
        tipo: input.targetType === 'CARTAO' ? 'DESP' : item.tipo,
        valor: toDecimalString(roundCurrency(item.valor)),
        descricao: item.descricao,
        dataCompetencia: parseDateStrictUtc(item.dataCompetencia),
        status: input.targetType === 'CARTAO' ? 'PENDENTE' : 'PAGO',
        hashDedup: item.hashDedup,
      })),
    });

    if (input.targetType === 'CONTA') {
      const receitas = toInsert
        .filter((item) => item.tipo === 'REC')
        .reduce((acc, item) => acc + item.valor, 0);
      const despesas = toInsert
        .filter((item) => item.tipo === 'DESP')
        .reduce((acc, item) => acc + item.valor, 0);
      const netDelta = roundCurrency(receitas - despesas);

      if (Math.abs(netDelta) >= 0.005) {
        await tx.conta.update({
          where: { id: targetId },
          data: {
            saldoAtual: {
              increment: toDecimalString(netDelta),
            },
          },
        });
      }
    }

    for (const item of toInsert) {
      if (item.categoriaId) {
        await recordCategoryLearning(tx, userId, item.descricao, item.categoriaId);
      }
    }

    insertedItems = toInsert;
  });

  const totalReceitasImportadas = roundCurrency(
    insertedItems.filter((item) => item.tipo === 'REC').reduce((acc, item) => acc + item.valor, 0),
  );
  const totalDespesasImportadas = roundCurrency(
    insertedItems.filter((item) => item.tipo === 'DESP').reduce((acc, item) => acc + item.valor, 0),
  );
  const netBalanceDelta =
    input.targetType === 'CONTA'
      ? roundCurrency(totalReceitasImportadas - totalDespesasImportadas)
      : 0;

  let cardAlert: CardCeilingAlertDto | null = null;
  if (input.targetType === 'CARTAO' && insertedItems.length > 0) {
    const latestDate = insertedItems
      .map((item) => item.dataCompetencia)
      .sort()
      .at(-1)!;
    cardAlert = await computeCardAlertForTransaction(userId, resolvedTargetId, latestDate);
  }

  return {
    targetType: input.targetType,
    targetId: resolvedTargetId,
    importedCount: insertedItems.length,
    skippedDuplicateCount: payloadDuplicateCount + dbDuplicateCount,
    totalReceitasImportadas,
    totalDespesasImportadas,
    netBalanceDelta,
    cardAlert,
  };
}
