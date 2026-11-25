import { prisma } from '../../infra/database/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { decimalToNumber } from '../../shared/utils/money.js';
import { decimalQuantityToNumber } from '../investments/investments.engine.js';

export interface LgpdUserExportPayload {
  exportVersion: string;
  exportedAt: string;
  lgpdNotice: string;
  usuario: {
    id: string;
    nome: string;
    email: string;
    twoFactorEnabled: boolean;
    custoVidaMensal: number;
    mesesReservaAlvo: number;
    pctPaguePrimeiro: number;
    gatilhoInvestPct: number;
    criadoEm: string;
  };
  contas: Array<{
    id: string;
    nome: string;
    tipo: string;
    saldoAtual: number;
    ehContaPadrao: boolean;
    ativa: boolean;
  }>;
  cartoesCredito: Array<{
    id: string;
    contaPagamentoId: string;
    nome: string;
    limiteTotal: number;
    tetoMensalAlerta: number;
    diaFechamento: number;
    diaVencimento: number;
  }>;
  categorias: Array<{
    id: string;
    nome: string;
    tipo: string;
    ehEssencial: boolean;
    orcamentoMensal: number | null;
  }>;
  regrasAprendizado: Array<{
    id: string;
    categoriaId: string;
    termoChave: string;
    hitsConfianca: number;
  }>;
  recorrencias: Array<{
    id: string;
    categoriaId: string;
    contaId: string | null;
    cartaoId: string | null;
    descricao: string;
    valorEstimado: number;
    diaVencimento: number;
    ativa: boolean;
  }>;
  transacoes: Array<{
    id: string;
    contaId: string | null;
    contaDestinoId: string | null;
    cartaoId: string | null;
    categoriaId: string | null;
    recorrenciaId: string | null;
    tipo: string;
    valor: number;
    descricao: string;
    dataCompetencia: string;
    status: string;
    hashDedup: string | null;
    criadoEm: string;
  }>;
  reservaEmergencia: {
    id: string;
    contaCofreId: string;
    valorMetaCalculado: number;
    saldoAcumulado: number;
    travaResgateAtiva: boolean;
    statusGatilho: string;
    atualizadoEm: string;
  } | null;
  movimentosReserva: Array<{
    id: string;
    transacaoOrigemId: string | null;
    tipo: string;
    valor: number;
    justificativaResgate: string | null;
    dataMovimento: string;
  }>;
  alocacoesAlvo: Array<{
    id: string;
    classeAtivo: string;
    percentualIdeal: number;
    atualizadoEm: string;
  }>;
  ativosCarteira: Array<{
    id: string;
    alocacaoId: string;
    tickerOuNome: string;
    quantidade: number;
    valorInvestido: number;
    saldoAtualMercado: number;
  }>;
  alertasNotificacoes: Array<{
    id: string;
    tipoAlerta: string;
    mensagem: string;
    canal: string;
    lido: boolean;
    enviadoEm: string;
  }>;
}

export async function buildUserExportPayload(userId: string): Promise<LgpdUserExportPayload> {
  const [
    usuario,
    contas,
    cartoesCredito,
    categorias,
    regrasAprendizado,
    recorrencias,
    transacoes,
    reservaEmergencia,
    alocacoesAlvo,
    ativosCarteira,
    alertasNotificacoes,
  ] = await Promise.all([
    prisma.usuario.findUnique({
      where: { id: userId },
      select: {
        id: true,
        nome: true,
        email: true,
        twoFactorEnabled: true,
        custoVidaMensal: true,
        mesesReservaAlvo: true,
        pctPaguePrimeiro: true,
        gatilhoInvestPct: true,
        criadoEm: true,
      },
    }),
    prisma.conta.findMany({
      where: { usuarioId: userId },
      orderBy: [{ tipo: 'asc' }, { nome: 'asc' }],
    }),
    prisma.cartaoCredito.findMany({
      where: { usuarioId: userId },
      orderBy: { nome: 'asc' },
    }),
    prisma.categoria.findMany({
      where: { usuarioId: userId },
      orderBy: [{ tipo: 'asc' }, { nome: 'asc' }],
    }),
    prisma.regraAprendizado.findMany({
      where: { usuarioId: userId },
      orderBy: { termoChave: 'asc' },
    }),
    prisma.recorrencia.findMany({
      where: { usuarioId: userId },
      orderBy: { diaVencimento: 'asc' },
    }),
    prisma.transacao.findMany({
      where: { usuarioId: userId },
      orderBy: [{ dataCompetencia: 'desc' }, { criadoEm: 'desc' }],
    }),
    prisma.reservaEmergencia.findUnique({
      where: { usuarioId: userId },
      include: {
        movimentos: {
          orderBy: { dataMovimento: 'desc' },
        },
      },
    }),
    prisma.alocacaoAlvo.findMany({
      where: { usuarioId: userId },
      orderBy: { classeAtivo: 'asc' },
    }),
    prisma.ativoCarteira.findMany({
      where: { usuarioId: userId },
      orderBy: { tickerOuNome: 'asc' },
    }),
    prisma.alertaNotificacao.findMany({
      where: { usuarioId: userId },
      orderBy: { enviadoEm: 'desc' },
    }),
  ]);

  if (!usuario) {
    throw new AppError('Usuário não encontrado.', 404, 'USER_NOT_FOUND');
  }

  return {
    exportVersion: '1.0',
    exportedAt: new Date().toISOString(),
    lgpdNotice:
      'Exportação integral de dados pessoais e financeiros conforme Lei nº 13.709/2018 (LGPD). Credenciais de senha são omitidas por segurança.',
    usuario: {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      twoFactorEnabled: usuario.twoFactorEnabled,
      custoVidaMensal: decimalToNumber(usuario.custoVidaMensal),
      mesesReservaAlvo: usuario.mesesReservaAlvo,
      pctPaguePrimeiro: decimalToNumber(usuario.pctPaguePrimeiro),
      gatilhoInvestPct: decimalToNumber(usuario.gatilhoInvestPct),
      criadoEm: usuario.criadoEm.toISOString(),
    },
    contas: contas.map((c) => ({
      id: c.id,
      nome: c.nome,
      tipo: c.tipo,
      saldoAtual: decimalToNumber(c.saldoAtual),
      ehContaPadrao: c.ehContaPadrao,
      ativa: c.ativa,
    })),
    cartoesCredito: cartoesCredito.map((card) => ({
      id: card.id,
      contaPagamentoId: card.contaPagamentoId,
      nome: card.nome,
      limiteTotal: decimalToNumber(card.limiteTotal),
      tetoMensalAlerta: decimalToNumber(card.tetoMensalAlerta),
      diaFechamento: card.diaFechamento,
      diaVencimento: card.diaVencimento,
    })),
    categorias: categorias.map((cat) => ({
      id: cat.id,
      nome: cat.nome,
      tipo: cat.tipo,
      ehEssencial: cat.ehEssencial,
      orcamentoMensal: cat.orcamentoMensal !== null ? decimalToNumber(cat.orcamentoMensal) : null,
    })),
    regrasAprendizado: regrasAprendizado.map((r) => ({
      id: r.id,
      categoriaId: r.categoriaId,
      termoChave: r.termoChave,
      hitsConfianca: r.hitsConfianca,
    })),
    recorrencias: recorrencias.map((rec) => ({
      id: rec.id,
      categoriaId: rec.categoriaId,
      contaId: rec.contaId,
      cartaoId: rec.cartaoId,
      descricao: rec.descricao,
      valorEstimado: decimalToNumber(rec.valorEstimado),
      diaVencimento: rec.diaVencimento,
      ativa: rec.ativa,
    })),
    transacoes: transacoes.map((tx) => ({
      id: tx.id,
      contaId: tx.contaId,
      contaDestinoId: tx.contaDestinoId,
      cartaoId: tx.cartaoId,
      categoriaId: tx.categoriaId,
      recorrenciaId: tx.recorrenciaId,
      tipo: tx.tipo,
      valor: decimalToNumber(tx.valor),
      descricao: tx.descricao,
      dataCompetencia: tx.dataCompetencia.toISOString().slice(0, 10),
      status: tx.status,
      hashDedup: tx.hashDedup,
      criadoEm: tx.criadoEm.toISOString(),
    })),
    reservaEmergencia: reservaEmergencia
      ? {
          id: reservaEmergencia.id,
          contaCofreId: reservaEmergencia.contaCofreId,
          valorMetaCalculado: decimalToNumber(reservaEmergencia.valorMetaCalculado),
          saldoAcumulado: decimalToNumber(reservaEmergencia.saldoAcumulado),
          travaResgateAtiva: reservaEmergencia.travaResgateAtiva,
          statusGatilho: reservaEmergencia.statusGatilho,
          atualizadoEm: reservaEmergencia.atualizadoEm.toISOString(),
        }
      : null,
    movimentosReserva: (reservaEmergencia?.movimentos ?? []).map((mov) => ({
      id: mov.id,
      transacaoOrigemId: mov.transacaoOrigemId,
      tipo: mov.tipo,
      valor: decimalToNumber(mov.valor),
      justificativaResgate: mov.justificativaResgate,
      dataMovimento: mov.dataMovimento.toISOString(),
    })),
    alocacoesAlvo: alocacoesAlvo.map((a) => ({
      id: a.id,
      classeAtivo: a.classeAtivo,
      percentualIdeal: decimalToNumber(a.percentualIdeal),
      atualizadoEm: a.atualizadoEm.toISOString(),
    })),
    ativosCarteira: ativosCarteira.map((asset) => ({
      id: asset.id,
      alocacaoId: asset.alocacaoId,
      tickerOuNome: asset.tickerOuNome,
      quantidade: decimalQuantityToNumber(asset.quantidade),
      valorInvestido: decimalToNumber(asset.valorInvestido),
      saldoAtualMercado: decimalToNumber(asset.saldoAtualMercado),
    })),
    alertasNotificacoes: alertasNotificacoes.map((alert) => ({
      id: alert.id,
      tipoAlerta: alert.tipoAlerta,
      mensagem: alert.mensagem,
      canal: alert.canal,
      lido: alert.lido,
      enviadoEm: alert.enviadoEm.toISOString(),
    })),
  };
}

function escapeCsvCell(
  raw: string | number | boolean | null | undefined,
  sanitizeText = true,
): string {
  if (raw === null || raw === undefined) {
    return '';
  }
  let text = String(raw);
  if (sanitizeText && typeof raw === 'string' && /^[=+\-@]/.test(text.trimStart())) {
    text = `'${text}`;
  }
  const escaped = text.replace(/"/g, '""');
  return `"${escaped}"`;
}

export function serializeExportToCsv(payload: LgpdUserExportPayload): string {
  const rows: string[] = [
    [
      'entidade',
      'id',
      'data_referencia',
      'tipo_ou_classe',
      'descricao_ou_nome',
      'valor',
      'status_ou_detalhe',
      'metadados_json',
    ]
      .map((col) => escapeCsvCell(col, false))
      .join(';'),
  ];

  const pushRow = (
    entidade: string,
    id: string,
    dataRef: string,
    tipoOuClasse: string,
    descricaoOuNome: string,
    valor: number | string | null,
    statusOuDetalhe: string,
    metadados: unknown,
  ) => {
    rows.push(
      [
        escapeCsvCell(entidade, false),
        escapeCsvCell(id, false),
        escapeCsvCell(dataRef, false),
        escapeCsvCell(tipoOuClasse, true),
        escapeCsvCell(descricaoOuNome, true),
        escapeCsvCell(valor === null ? '' : valor, false),
        escapeCsvCell(statusOuDetalhe, true),
        escapeCsvCell(JSON.stringify(metadados), false),
      ].join(';'),
    );
  };

  pushRow(
    'USUARIOS',
    payload.usuario.id,
    payload.usuario.criadoEm,
    payload.usuario.twoFactorEnabled ? '2FA_ATIVO' : '2FA_INATIVO',
    payload.usuario.nome,
    payload.usuario.custoVidaMensal,
    payload.usuario.email,
    payload.usuario,
  );

  for (const conta of payload.contas) {
    pushRow(
      'CONTAS',
      conta.id,
      '',
      conta.tipo,
      conta.nome,
      conta.saldoAtual,
      conta.ativa ? 'ATIVA' : 'INATIVA',
      conta,
    );
  }

  for (const card of payload.cartoesCredito) {
    pushRow(
      'CARTOES_CREDITO',
      card.id,
      '',
      'CARTAO',
      card.nome,
      card.limiteTotal,
      `fech:${card.diaFechamento}/venc:${card.diaVencimento}`,
      card,
    );
  }

  for (const cat of payload.categorias) {
    pushRow(
      'CATEGORIAS',
      cat.id,
      '',
      cat.tipo,
      cat.nome,
      cat.orcamentoMensal,
      cat.ehEssencial ? 'ESSENCIAL' : 'OPCIONAL',
      cat,
    );
  }

  for (const rule of payload.regrasAprendizado) {
    pushRow(
      'REGRAS_APRENDIZADO',
      rule.id,
      '',
      'REGRA',
      rule.termoChave,
      rule.hitsConfianca,
      rule.categoriaId,
      rule,
    );
  }

  for (const rec of payload.recorrencias) {
    pushRow(
      'RECORRENCIAS',
      rec.id,
      '',
      `DIA_${rec.diaVencimento}`,
      rec.descricao,
      rec.valorEstimado,
      rec.ativa ? 'ATIVA' : 'PAUSADA',
      rec,
    );
  }

  for (const tx of payload.transacoes) {
    pushRow(
      'TRANSACOES',
      tx.id,
      tx.dataCompetencia,
      tx.tipo,
      tx.descricao,
      tx.valor,
      tx.status,
      tx,
    );
  }

  if (payload.reservaEmergencia) {
    const res = payload.reservaEmergencia;
    pushRow(
      'RESERVA_EMERGENCIA',
      res.id,
      res.atualizadoEm,
      res.statusGatilho,
      'Meta Reserva de Emergência',
      res.saldoAcumulado,
      `meta:${res.valorMetaCalculado}`,
      res,
    );
  }

  for (const mov of payload.movimentosReserva) {
    pushRow(
      'MOVIMENTOS_RESERVA',
      mov.id,
      mov.dataMovimento,
      mov.tipo,
      mov.justificativaResgate ?? 'Aporte na reserva',
      mov.valor,
      mov.tipo,
      mov,
    );
  }

  for (const alloc of payload.alocacoesAlvo) {
    pushRow(
      'ALOCACAO_ALVO',
      alloc.id,
      alloc.atualizadoEm,
      alloc.classeAtivo,
      alloc.classeAtivo,
      alloc.percentualIdeal,
      'ALVO_PCT',
      alloc,
    );
  }

  for (const asset of payload.ativosCarteira) {
    pushRow(
      'ATIVOS_CARTEIRA',
      asset.id,
      '',
      asset.alocacaoId,
      asset.tickerOuNome,
      asset.saldoAtualMercado,
      `qtd:${asset.quantidade}`,
      asset,
    );
  }

  for (const alert of payload.alertasNotificacoes) {
    pushRow(
      'ALERTAS_NOTIFICACOES',
      alert.id,
      alert.enviadoEm,
      alert.tipoAlerta,
      alert.mensagem,
      null,
      `${alert.canal}:${alert.lido ? 'LIDO' : 'NAO_LIDO'}`,
      alert,
    );
  }

  return `\uFEFF${rows.join('\r\n')}`;
}
