import type { Categoria } from '@prisma/client';
import { prisma } from '../../infra/database/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { decimalToNumber, toDecimalString } from '../../shared/utils/money.js';
import type {
  CategoryDto,
  CreateCategoryInput,
  ListCategoriesFilters,
  UpdateCategoryInput,
} from './categories.schemas.js';

function formatCategory(category: Categoria): CategoryDto {
  return {
    id: category.id,
    nome: category.nome,
    tipo: category.tipo,
    ehEssencial: category.ehEssencial,
    orcamentoMensal:
      category.orcamentoMensal !== null ? decimalToNumber(category.orcamentoMensal) : null,
  };
}

export async function listCategories(
  userId: string,
  filters: ListCategoriesFilters,
): Promise<CategoryDto[]> {
  const categories = await prisma.categoria.findMany({
    where: {
      usuarioId: userId,
      ...(filters.tipo !== undefined ? { tipo: filters.tipo } : {}),
      ...(filters.ehEssencial !== undefined ? { ehEssencial: filters.ehEssencial } : {}),
    },
    orderBy: [{ tipo: 'asc' }, { ehEssencial: 'desc' }, { nome: 'asc' }],
  });

  return categories.map(formatCategory);
}

export async function createCategory(
  userId: string,
  input: CreateCategoryInput,
): Promise<CategoryDto> {
  if (input.tipo === 'RECEITA' && input.ehEssencial) {
    throw new AppError(
      'Categorias de receita não podem ser marcadas como essenciais.',
      400,
      'INVALID_ESSENTIAL_CATEGORY',
    );
  }

  const created = await prisma.categoria.create({
    data: {
      usuarioId: userId,
      nome: input.nome,
      tipo: input.tipo,
      ehEssencial: input.tipo === 'RECEITA' ? false : input.ehEssencial,
      orcamentoMensal:
        input.orcamentoMensal !== undefined && input.orcamentoMensal !== null
          ? toDecimalString(input.orcamentoMensal)
          : null,
    },
  });

  return formatCategory(created);
}

export async function updateCategory(
  userId: string,
  categoryId: string,
  input: UpdateCategoryInput,
): Promise<CategoryDto> {
  const existing = await prisma.categoria.findFirst({
    where: { id: categoryId, usuarioId: userId },
  });

  if (!existing) {
    throw new AppError('Categoria não encontrada.', 404, 'CATEGORY_NOT_FOUND');
  }

  if (existing.tipo === 'RECEITA' && input.ehEssencial === true) {
    throw new AppError(
      'Categorias de receita não podem ser marcadas como essenciais.',
      400,
      'INVALID_ESSENTIAL_CATEGORY',
    );
  }

  const updated = await prisma.categoria.update({
    where: { id: existing.id },
    data: {
      ...(input.nome !== undefined ? { nome: input.nome } : {}),
      ...(input.ehEssencial !== undefined ? { ehEssencial: input.ehEssencial } : {}),
      ...(input.orcamentoMensal !== undefined
        ? {
            orcamentoMensal:
              input.orcamentoMensal !== null ? toDecimalString(input.orcamentoMensal) : null,
          }
        : {}),
    },
  });

  return formatCategory(updated);
}

export async function deleteCategory(userId: string, categoryId: string): Promise<void> {
  const existing = await prisma.categoria.findFirst({
    where: { id: categoryId, usuarioId: userId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError('Categoria não encontrada.', 404, 'CATEGORY_NOT_FOUND');
  }

  await prisma.categoria.delete({
    where: { id: existing.id },
  });
}
