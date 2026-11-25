import type { ReservaEmergencia, Usuario } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../infra/database/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { hashPassword, verifyPassword } from '../../shared/security/password.js';
import {
  buildOtpAuthUri,
  deriveUserTotpSecret,
  verifyTotpCode,
} from '../../shared/security/totp.js';
import { decimalToNumber, toDecimalString } from '../../shared/utils/money.js';
import { DEFAULT_TARGET_ALLOCATIONS } from '../investments/investments.engine.js';
import { evaluateInvestmentTriggerStatus } from '../reserve/reserve.engine.js';
import type { RegisterInput, UpdateProfileInput, UserProfileDto } from './auth.schemas.js';

const DEFAULT_CATEGORIES: ReadonlyArray<{
  nome: string;
  tipo: 'RECEITA' | 'DESPESA';
  ehEssencial: boolean;
}> = [
  { nome: 'Salário', tipo: 'RECEITA', ehEssencial: false },
  { nome: 'Renda Extra', tipo: 'RECEITA', ehEssencial: false },
  { nome: 'Moradia', tipo: 'DESPESA', ehEssencial: true },
  { nome: 'Alimentação', tipo: 'DESPESA', ehEssencial: true },
  { nome: 'Saúde', tipo: 'DESPESA', ehEssencial: true },
  { nome: 'Transporte', tipo: 'DESPESA', ehEssencial: true },
  { nome: 'Contas Fixas', tipo: 'DESPESA', ehEssencial: true },
  { nome: 'Lazer', tipo: 'DESPESA', ehEssencial: false },
  { nome: 'Assinaturas', tipo: 'DESPESA', ehEssencial: false },
  { nome: 'Outros', tipo: 'DESPESA', ehEssencial: false },
];

function formatUserProfile(usuario: Usuario, reserva: ReservaEmergencia): UserProfileDto {
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    twoFactorEnabled: usuario.twoFactorEnabled,
    custoVidaMensal: decimalToNumber(usuario.custoVidaMensal),
    mesesReservaAlvo: usuario.mesesReservaAlvo,
    pctPaguePrimeiro: decimalToNumber(usuario.pctPaguePrimeiro),
    gatilhoInvestPct: decimalToNumber(usuario.gatilhoInvestPct),
    criadoEm: usuario.criadoEm.toISOString(),
    reserva: {
      id: reserva.id,
      contaCofreId: reserva.contaCofreId,
      valorMetaCalculado: decimalToNumber(reserva.valorMetaCalculado),
      saldoAcumulado: decimalToNumber(reserva.saldoAcumulado),
      travaResgateAtiva: reserva.travaResgateAtiva,
      statusGatilho: reserva.statusGatilho,
    },
  };
}

export async function registerUser(input: RegisterInput): Promise<UserProfileDto> {
  const email = input.email.trim().toLowerCase();
  const existing = await prisma.usuario.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    throw new AppError('E-mail já cadastrado.', 409, 'EMAIL_IN_USE');
  }

  const senhaHash = await hashPassword(input.senha);
  const metaCalculada = input.custoVidaMensal * input.mesesReservaAlvo;

  const result = await prisma.$transaction(async (tx) => {
    const usuario = await tx.usuario.create({
      data: {
        nome: input.nome,
        email,
        senhaHash,
        custoVidaMensal: toDecimalString(input.custoVidaMensal),
        mesesReservaAlvo: input.mesesReservaAlvo,
        pctPaguePrimeiro: toDecimalString(input.pctPaguePrimeiro),
        gatilhoInvestPct: toDecimalString(input.gatilhoInvestPct),
      },
    });

    await tx.conta.create({
      data: {
        usuarioId: usuario.id,
        nome: 'Conta Principal',
        tipo: 'CORRENTE',
        saldoAtual: '0.00',
        ehContaPadrao: true,
        ativa: true,
      },
    });

    const contaCofre = await tx.conta.create({
      data: {
        usuarioId: usuario.id,
        nome: 'Reserva de Emergência',
        tipo: 'COFRE',
        saldoAtual: '0.00',
        ehContaPadrao: false,
        ativa: true,
      },
    });

    const reserva = await tx.reservaEmergencia.create({
      data: {
        usuarioId: usuario.id,
        contaCofreId: contaCofre.id,
        valorMetaCalculado: toDecimalString(metaCalculada),
        saldoAcumulado: '0.00',
        travaResgateAtiva: true,
        statusGatilho: 'BLOQUEADO',
      },
    });

    await tx.categoria.createMany({
      data: DEFAULT_CATEGORIES.map((category) => ({
        usuarioId: usuario.id,
        nome: category.nome,
        tipo: category.tipo,
        ehEssencial: category.ehEssencial,
      })),
    });

    await tx.alocacaoAlvo.createMany({
      data: DEFAULT_TARGET_ALLOCATIONS.map((allocation) => ({
        usuarioId: usuario.id,
        classeAtivo: allocation.classeAtivo,
        percentualIdeal: toDecimalString(allocation.percentualIdeal),
      })),
    });

    return { usuario, reserva };
  });

  return formatUserProfile(result.usuario, result.reserva);
}

export async function authenticateUser(
  email: string,
  senha: string,
  codigoTotp?: string,
): Promise<UserProfileDto> {
  const normalizedEmail = email.trim().toLowerCase();
  const usuario = await prisma.usuario.findUnique({
    where: { email: normalizedEmail },
    include: { reservaEmergencia: true },
  });

  if (!usuario || !usuario.reservaEmergencia) {
    throw new AppError('Credenciais inválidas.', 401, 'INVALID_CREDENTIALS');
  }

  const passwordMatches = await verifyPassword(senha, usuario.senhaHash);
  if (!passwordMatches) {
    throw new AppError('Credenciais inválidas.', 401, 'INVALID_CREDENTIALS');
  }

  if (usuario.twoFactorEnabled) {
    if (!codigoTotp) {
      throw new AppError(
        'Informe o código de verificação em duas etapas (2FA).',
        401,
        'TWO_FACTOR_REQUIRED',
      );
    }

    const secret = deriveUserTotpSecret(env.JWT_SECRET, usuario.id, usuario.senhaHash);
    if (!verifyTotpCode(secret, codigoTotp)) {
      throw new AppError('Código 2FA inválido ou expirado.', 401, 'INVALID_TWO_FACTOR_CODE');
    }
  }

  return formatUserProfile(usuario, usuario.reservaEmergencia);
}

export async function setupTwoFactor(userId: string): Promise<{
  secret: string;
  otpauthUrl: string;
  twoFactorEnabled: boolean;
}> {
  const usuario = await prisma.usuario.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      senhaHash: true,
      twoFactorEnabled: true,
    },
  });

  if (!usuario) {
    throw new AppError('Usuário não encontrado.', 404, 'USER_NOT_FOUND');
  }

  const secret = deriveUserTotpSecret(env.JWT_SECRET, usuario.id, usuario.senhaHash);
  const otpauthUrl = buildOtpAuthUri(usuario.email, secret);

  return {
    secret,
    otpauthUrl,
    twoFactorEnabled: usuario.twoFactorEnabled,
  };
}

export async function enableTwoFactor(userId: string, codigoTotp: string): Promise<UserProfileDto> {
  const usuario = await prisma.usuario.findUnique({
    where: { id: userId },
    include: { reservaEmergencia: true },
  });

  if (!usuario || !usuario.reservaEmergencia) {
    throw new AppError('Usuário não encontrado.', 404, 'USER_NOT_FOUND');
  }

  const secret = deriveUserTotpSecret(env.JWT_SECRET, usuario.id, usuario.senhaHash);
  if (!verifyTotpCode(secret, codigoTotp)) {
    throw new AppError(
      'Código 2FA inválido. Confira o código de 6 dígitos no seu aplicativo autenticador.',
      400,
      'INVALID_TWO_FACTOR_CODE',
    );
  }

  const updated = await prisma.usuario.update({
    where: { id: userId },
    data: { twoFactorEnabled: true },
  });

  return formatUserProfile(updated, usuario.reservaEmergencia);
}

export async function disableTwoFactor(
  userId: string,
  senhaAtual: string,
): Promise<UserProfileDto> {
  const usuario = await prisma.usuario.findUnique({
    where: { id: userId },
    include: { reservaEmergencia: true },
  });

  if (!usuario || !usuario.reservaEmergencia) {
    throw new AppError('Usuário não encontrado.', 404, 'USER_NOT_FOUND');
  }

  const passwordMatches = await verifyPassword(senhaAtual, usuario.senhaHash);
  if (!passwordMatches) {
    throw new AppError('Senha atual incorreta.', 401, 'INVALID_CREDENTIALS');
  }

  const updated = await prisma.usuario.update({
    where: { id: userId },
    data: { twoFactorEnabled: false },
  });

  return formatUserProfile(updated, usuario.reservaEmergencia);
}

export async function ensureUserExists(userId: string): Promise<boolean> {
  const user = await prisma.usuario.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  return Boolean(user);
}

export async function getUserProfile(userId: string): Promise<UserProfileDto> {
  const usuario = await prisma.usuario.findUnique({
    where: { id: userId },
    include: { reservaEmergencia: true },
  });

  if (!usuario || !usuario.reservaEmergencia) {
    throw new AppError('Usuário não encontrado.', 404, 'USER_NOT_FOUND');
  }

  return formatUserProfile(usuario, usuario.reservaEmergencia);
}

export async function updateUserProfile(
  userId: string,
  input: UpdateProfileInput,
): Promise<UserProfileDto> {
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.usuario.findUnique({
      where: { id: userId },
      include: { reservaEmergencia: true },
    });

    if (!existing || !existing.reservaEmergencia) {
      throw new AppError('Usuário não encontrado.', 404, 'USER_NOT_FOUND');
    }

    const updatedUsuario = await tx.usuario.update({
      where: { id: userId },
      data: {
        ...(input.nome !== undefined ? { nome: input.nome } : {}),
        ...(input.custoVidaMensal !== undefined
          ? { custoVidaMensal: toDecimalString(input.custoVidaMensal) }
          : {}),
        ...(input.mesesReservaAlvo !== undefined
          ? { mesesReservaAlvo: input.mesesReservaAlvo }
          : {}),
        ...(input.pctPaguePrimeiro !== undefined
          ? { pctPaguePrimeiro: toDecimalString(input.pctPaguePrimeiro) }
          : {}),
        ...(input.gatilhoInvestPct !== undefined
          ? { gatilhoInvestPct: toDecimalString(input.gatilhoInvestPct) }
          : {}),
      },
    });

    const novaMeta =
      decimalToNumber(updatedUsuario.custoVidaMensal) * updatedUsuario.mesesReservaAlvo;
    const novoStatusGatilho = evaluateInvestmentTriggerStatus(
      decimalToNumber(existing.reservaEmergencia.saldoAcumulado),
      novaMeta,
      decimalToNumber(updatedUsuario.gatilhoInvestPct),
    );

    const updatedReserva = await tx.reservaEmergencia.update({
      where: { usuarioId: userId },
      data: {
        valorMetaCalculado: toDecimalString(novaMeta),
        statusGatilho: novoStatusGatilho,
      },
    });

    return { updatedUsuario, updatedReserva };
  });

  return formatUserProfile(result.updatedUsuario, result.updatedReserva);
}
