import { Prisma } from '@prisma/client';
import { prisma } from '../../infra/database/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  extractLearningTerm,
  normalizeLearningText,
  rankMatchingRule,
} from './learning-rules.engine.js';
import type {
  CategorySuggestionDto,
  CreateLearningRuleInput,
  LearningRuleDto,
} from './learning-rules.schemas.js';

type RuleWithCategory = Prisma.RegraAprendizadoGetPayload<{
  include: { categoria: { select: { id: true; nome: true; tipo: true } } };
}>;

function formatLearningRule(rule: RuleWithCategory): LearningRuleDto {
  return {
    id: rule.id,
    termoChave: rule.termoChave,
    hitsConfianca: rule.hitsConfianca,
    categoriaId: rule.categoriaId,
    categoriaNome: rule.categoria.nome,
    categoriaTipo: rule.categoria.tipo,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function recordCategoryLearning(
  tx: Prisma.TransactionClient,
  userId: string,
  descricao: string,
  categoriaId: string,
): Promise<void> {
  const termoChave = extractLearningTerm(descricao);
  if (!termoChave) {
    return;
  }

  const existing = await tx.regraAprendizado.findUnique({
    where: {
      usuarioId_termoChave: {
        usuarioId: userId,
        termoChave,
      },
    },
  });

  if (!existing) {
    await tx.regraAprendizado.create({
      data: {
        usuarioId: userId,
        categoriaId,
        termoChave,
        hitsConfianca: 1,
      },
    });
    return;
  }

  if (existing.categoriaId === categoriaId) {
    await tx.regraAprendizado.update({
      where: { id: existing.id },
      data: { hitsConfianca: { increment: 1 } },
    });
    return;
  }

  await tx.regraAprendizado.update({
    where: { id: existing.id },
    data: {
      categoriaId,
      hitsConfianca: 1,
    },
  });
}

export async function suggestCategoryForDescription(
  userId: string,
  descricao: string,
  tipo: 'REC' | 'DESP',
): Promise<CategorySuggestionDto | null> {
  const expectedCategoryType = tipo === 'REC' ? 'RECEITA' : 'DESPESA';

  const rules = await prisma.regraAprendizado.findMany({
    where: {
      usuarioId: userId,
      categoria: {
        tipo: expectedCategoryType,
      },
    },
    include: {
      categoria: { select: { id: true, nome: true, tipo: true } },
    },
  });

  const matchedRule = rankMatchingRule(descricao, rules);
  if (matchedRule) {
    return {
      categoriaId: matchedRule.categoriaId,
      categoriaNome: matchedRule.categoria.nome,
      source: 'RULE',
      termoChave: matchedRule.termoChave,
      hitsConfianca: matchedRule.hitsConfianca,
    };
  }

  const categories = await prisma.categoria.findMany({
    where: {
      usuarioId: userId,
      tipo: expectedCategoryType,
    },
    select: { id: true, nome: true },
  });

  const normalizedInput = normalizeLearningText(descricao);
  if (!normalizedInput) {
    return null;
  }

  const sortedCategories = [...categories].sort((a, b) => b.nome.length - a.nome.length);
  for (const category of sortedCategories) {
    const normalizedCat = normalizeLearningText(category.nome);
    if (!normalizedCat) {
      continue;
    }

    const pattern = new RegExp(`(?:^|\\s)${escapeRegex(normalizedCat)}(?:\\s|$)`);
    if (pattern.test(normalizedInput)) {
      return {
        categoriaId: category.id,
        categoriaNome: category.nome,
        source: 'CATEGORY_NAME',
        termoChave: null,
        hitsConfianca: null,
      };
    }
  }

  return null;
}

export async function listLearningRules(userId: string): Promise<LearningRuleDto[]> {
  const rules = await prisma.regraAprendizado.findMany({
    where: { usuarioId: userId },
    include: {
      categoria: { select: { id: true, nome: true, tipo: true } },
    },
    orderBy: [{ hitsConfianca: 'desc' }, { termoChave: 'asc' }],
  });

  return rules.map(formatLearningRule);
}

export async function upsertLearningRule(
  userId: string,
  input: CreateLearningRuleInput,
): Promise<LearningRuleDto> {
  const termoChave = normalizeLearningText(input.termoChave);
  if (termoChave.length < 2 || termoChave.length > 80) {
    throw new AppError(
      'Termo-chave deve ter entre 2 e 80 caracteres válidos.',
      400,
      'INVALID_LEARNING_TERM',
    );
  }

  const category = await prisma.categoria.findFirst({
    where: { id: input.categoriaId, usuarioId: userId },
    select: { id: true },
  });

  if (!category) {
    throw new AppError('Categoria não encontrada.', 404, 'CATEGORY_NOT_FOUND');
  }

  const existing = await prisma.regraAprendizado.findUnique({
    where: {
      usuarioId_termoChave: {
        usuarioId: userId,
        termoChave,
      },
    },
  });

  if (!existing) {
    const created = await prisma.regraAprendizado.create({
      data: {
        usuarioId: userId,
        categoriaId: input.categoriaId,
        termoChave,
        hitsConfianca: 1,
      },
      include: {
        categoria: { select: { id: true, nome: true, tipo: true } },
      },
    });
    return formatLearningRule(created);
  }

  const updated = await prisma.regraAprendizado.update({
    where: { id: existing.id },
    data:
      existing.categoriaId === input.categoriaId
        ? { hitsConfianca: { increment: 1 } }
        : { categoriaId: input.categoriaId, hitsConfianca: 1 },
    include: {
      categoria: { select: { id: true, nome: true, tipo: true } },
    },
  });

  return formatLearningRule(updated);
}

export async function deleteLearningRule(userId: string, ruleId: string): Promise<void> {
  const existing = await prisma.regraAprendizado.findFirst({
    where: { id: ruleId, usuarioId: userId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError('Regra de aprendizado não encontrada.', 404, 'LEARNING_RULE_NOT_FOUND');
  }

  await prisma.regraAprendizado.delete({
    where: { id: existing.id },
  });
}
