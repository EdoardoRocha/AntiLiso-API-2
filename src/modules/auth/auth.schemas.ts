import { z } from 'zod';
import { moneyNonNegativeSchema, percentSchema } from '../../shared/utils/money.js';

export const registerBodySchema = z.object({
  nome: z.string().trim().min(2, 'Nome deve ter ao menos 2 caracteres').max(120),
  email: z.string().trim().toLowerCase().email('E-mail inválido').max(180),
  senha: z.string().min(8, 'Senha deve ter no mínimo 8 caracteres').max(128),
  custoVidaMensal: moneyNonNegativeSchema.default(0),
  mesesReservaAlvo: z.number().int().min(3).max(12).default(6),
  pctPaguePrimeiro: percentSchema.default(15),
  gatilhoInvestPct: percentSchema.default(50),
});

export const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  senha: z.string().min(1, 'Senha é obrigatória'),
  codigoTotp: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Código 2FA deve conter 6 dígitos')
    .optional(),
});

export const totpCodeBodySchema = z.object({
  codigoTotp: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Código 2FA deve conter 6 dígitos'),
});

export const disableTwoFactorBodySchema = z.object({
  senhaAtual: z.string().min(1, 'Informe sua senha atual para desativar o 2FA'),
});

export const updateProfileBodySchema = z
  .object({
    nome: z.string().trim().min(2, 'Nome deve ter ao menos 2 caracteres').max(120).optional(),
    custoVidaMensal: moneyNonNegativeSchema.optional(),
    mesesReservaAlvo: z.number().int().min(3).max(12).optional(),
    pctPaguePrimeiro: percentSchema.optional(),
    gatilhoInvestPct: percentSchema.optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Informe ao menos um campo para atualização',
  });

export const userProfileSchema = z.object({
  id: z.string().uuid(),
  nome: z.string(),
  email: z.string().email(),
  twoFactorEnabled: z.boolean(),
  custoVidaMensal: z.number(),
  mesesReservaAlvo: z.number().int(),
  pctPaguePrimeiro: z.number(),
  gatilhoInvestPct: z.number(),
  criadoEm: z.string(),
  reserva: z.object({
    id: z.string().uuid(),
    contaCofreId: z.string().uuid(),
    valorMetaCalculado: z.number(),
    saldoAcumulado: z.number(),
    travaResgateAtiva: z.boolean(),
    statusGatilho: z.enum(['BLOQUEADO', 'LIBERADO']),
  }),
});

export type RegisterInput = z.infer<typeof registerBodySchema>;
export type LoginInput = z.infer<typeof loginBodySchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileBodySchema>;
export type TotpCodeInput = z.infer<typeof totpCodeBodySchema>;
export type DisableTwoFactorInput = z.infer<typeof disableTwoFactorBodySchema>;
export type UserProfileDto = z.infer<typeof userProfileSchema>;
