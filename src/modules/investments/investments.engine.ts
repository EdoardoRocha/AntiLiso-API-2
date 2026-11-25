import { roundCurrency } from '../safe-to-spend/safe-to-spend.engine.js';

export const ASSET_CLASSES = ['RF', 'FII', 'ACOES', 'INT', 'CRIPTO'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const RISK_ASSET_CLASSES: ReadonlySet<AssetClass> = new Set([
  'FII',
  'ACOES',
  'INT',
  'CRIPTO',
]);

export function isRiskAssetClass(classe: AssetClass): boolean {
  return RISK_ASSET_CLASSES.has(classe);
}

export const DEFAULT_TARGET_ALLOCATIONS: ReadonlyArray<{
  classeAtivo: AssetClass;
  percentualIdeal: number;
}> = [
  { classeAtivo: 'RF', percentualIdeal: 40 },
  { classeAtivo: 'FII', percentualIdeal: 20 },
  { classeAtivo: 'ACOES', percentualIdeal: 20 },
  { classeAtivo: 'INT', percentualIdeal: 15 },
  { classeAtivo: 'CRIPTO', percentualIdeal: 5 },
];

export interface AssetClassMetadata {
  classeAtivo: AssetClass;
  nome: string;
  nivelRisco: 'CONSERVADOR' | 'MODERADO' | 'ARROJADO';
  isRisco: boolean;
  resumoEducativo: string;
}

export const ASSET_CLASS_METADATA: Record<AssetClass, AssetClassMetadata> = {
  RF: {
    classeAtivo: 'RF',
    nome: 'Renda Fixa & Liquidez',
    nivelRisco: 'CONSERVADOR',
    isRisco: false,
    resumoEducativo:
      'Títulos públicos (Tesouro Selic/IPCA+), CDBs e LCIs. Base conservadora para liquidez, metas de médio prazo e amortecimento de volatilidade.',
  },
  FII: {
    classeAtivo: 'FII',
    nome: 'Fundos Imobiliários',
    nivelRisco: 'MODERADO',
    isRisco: true,
    resumoEducativo:
      'Cotas de imóveis logísticos, shoppings, lajes ou recebíveis imobiliários com foco em fluxo mensal de rendimentos.',
  },
  ACOES: {
    classeAtivo: 'ACOES',
    nome: 'Ações Nacionais',
    nivelRisco: 'ARROJADO',
    isRisco: true,
    resumoEducativo:
      'Participação em empresas listadas na B3 para crescimento de patrimônio e dividendos no longo prazo.',
  },
  INT: {
    classeAtivo: 'INT',
    nome: 'Internacional / ETFs Globais',
    nivelRisco: 'MODERADO',
    isRisco: true,
    resumoEducativo:
      'Exposição a moeda forte (dólar/euro) e índices globais como S&P 500 ou mercados mundiais para proteção cambial.',
  },
  CRIPTO: {
    classeAtivo: 'CRIPTO',
    nome: 'Criptoativos',
    nivelRisco: 'ARROJADO',
    isRisco: true,
    resumoEducativo:
      'Classe de altíssima volatilidade (Bitcoin, Ethereum e redes descentralizadas). Recomenda-se fatia pequena e visão de longo prazo.',
  },
};

export function roundQuantity(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function toQuantityDecimalString(value: number): string {
  return roundQuantity(value).toFixed(6);
}

export function decimalQuantityToNumber(
  value: { toFixed(digits?: number): string } | number | string,
): number {
  return Number(Number(value).toFixed(6));
}

export interface AllocationInput {
  id: string;
  classeAtivo: AssetClass;
  percentualIdeal: number;
}

export interface RawPortfolioAsset {
  id: string;
  alocacaoId: string;
  classeAtivo: AssetClass;
  tickerOuNome: string;
  quantidade: number;
  valorInvestido: number;
  saldoAtualMercado: number;
}

export interface ConsolidatedAssetItem {
  id: string;
  alocacaoId: string;
  classeAtivo: AssetClass;
  tickerOuNome: string;
  quantidade: number;
  valorInvestido: number;
  saldoAtualMercado: number;
  precoMedio: number;
  cotacaoAtual: number;
  lucroPrejuizo: number;
  rentabilidadePct: number;
  participacaoCarteiraPct: number;
}

export interface ConsolidatedClassSummary {
  alocacaoId: string;
  classeAtivo: AssetClass;
  nomeClasse: string;
  nivelRisco: 'CONSERVADOR' | 'MODERADO' | 'ARROJADO';
  isRisco: boolean;
  bloqueadaPorGatilho: boolean;
  resumoEducativo: string;
  percentualIdeal: number;
  percentualAtual: number;
  desvioPct: number;
  valorInvestido: number;
  saldoAtualMercado: number;
  lucroPrejuizo: number;
  rentabilidadePct: number;
  quantidadeAtivos: number;
  ativos: ConsolidatedAssetItem[];
}

export interface PortfolioConsolidationResult {
  valorInvestidoCarteira: number;
  patrimonioCarteira: number;
  lucroPrejuizoCarteira: number;
  rentabilidadeCarteiraPct: number;
  saldoContasLiquidas: number;
  saldoReservaEmergencia: number;
  patrimonioTotalGlobal: number;
  classes: ConsolidatedClassSummary[];
}

export function consolidatePortfolio(input: {
  allocations: ReadonlyArray<AllocationInput>;
  assets: ReadonlyArray<RawPortfolioAsset>;
  saldoContasLiquidas: number;
  saldoReservaEmergencia: number;
  statusGatilho: 'BLOQUEADO' | 'LIBERADO';
}): PortfolioConsolidationResult {
  const patrimonioCarteira = roundCurrency(
    input.assets.reduce((acc, asset) => acc + Math.max(0, asset.saldoAtualMercado), 0),
  );
  const valorInvestidoCarteira = roundCurrency(
    input.assets.reduce((acc, asset) => acc + Math.max(0, asset.valorInvestido), 0),
  );
  const lucroPrejuizoCarteira = roundCurrency(patrimonioCarteira - valorInvestidoCarteira);
  const rentabilidadeCarteiraPct =
    valorInvestidoCarteira > 0
      ? roundCurrency(
          ((patrimonioCarteira - valorInvestidoCarteira) / valorInvestidoCarteira) * 100,
        )
      : 0;

  const allocationByClass = new Map<AssetClass, AllocationInput>();
  for (const alloc of input.allocations) {
    allocationByClass.set(alloc.classeAtivo, alloc);
  }

  const classes: ConsolidatedClassSummary[] = ASSET_CLASSES.map((classeAtivo) => {
    const meta = ASSET_CLASS_METADATA[classeAtivo];
    const allocation = allocationByClass.get(classeAtivo);
    const alocacaoId = allocation?.id ?? '';
    const percentualIdeal = roundCurrency(allocation?.percentualIdeal ?? 0);

    const classAssets = input.assets.filter((asset) => asset.classeAtivo === classeAtivo);
    const ativos: ConsolidatedAssetItem[] = classAssets
      .map((asset) => {
        const qty = roundQuantity(Math.max(0, asset.quantidade));
        const invested = roundCurrency(Math.max(0, asset.valorInvestido));
        const market = roundCurrency(Math.max(0, asset.saldoAtualMercado));
        const lucroPrejuizo = roundCurrency(market - invested);
        const rentabilidadePct =
          invested > 0 ? roundCurrency(((market - invested) / invested) * 100) : 0;
        const precoMedio = qty > 0 ? roundCurrency(invested / qty) : 0;
        const cotacaoAtual = qty > 0 ? roundCurrency(market / qty) : 0;
        const participacaoCarteiraPct =
          patrimonioCarteira > 0 ? roundCurrency((market / patrimonioCarteira) * 100) : 0;

        return {
          id: asset.id,
          alocacaoId: asset.alocacaoId,
          classeAtivo: asset.classeAtivo,
          tickerOuNome: asset.tickerOuNome,
          quantidade: qty,
          valorInvestido: invested,
          saldoAtualMercado: market,
          precoMedio,
          cotacaoAtual,
          lucroPrejuizo,
          rentabilidadePct,
          participacaoCarteiraPct,
        };
      })
      .sort((a, b) => {
        if (b.saldoAtualMercado !== a.saldoAtualMercado) {
          return b.saldoAtualMercado - a.saldoAtualMercado;
        }
        return a.tickerOuNome.localeCompare(b.tickerOuNome);
      });

    const valorInvestido = roundCurrency(ativos.reduce((acc, a) => acc + a.valorInvestido, 0));
    const saldoAtualMercado = roundCurrency(
      ativos.reduce((acc, a) => acc + a.saldoAtualMercado, 0),
    );
    const lucroPrejuizo = roundCurrency(saldoAtualMercado - valorInvestido);
    const rentabilidadePct =
      valorInvestido > 0
        ? roundCurrency(((saldoAtualMercado - valorInvestido) / valorInvestido) * 100)
        : 0;
    const percentualAtual =
      patrimonioCarteira > 0 ? roundCurrency((saldoAtualMercado / patrimonioCarteira) * 100) : 0;
    const desvioPct = roundCurrency(percentualAtual - percentualIdeal);

    return {
      alocacaoId,
      classeAtivo,
      nomeClasse: meta.nome,
      nivelRisco: meta.nivelRisco,
      isRisco: meta.isRisco,
      bloqueadaPorGatilho: meta.isRisco && input.statusGatilho === 'BLOQUEADO',
      resumoEducativo: meta.resumoEducativo,
      percentualIdeal,
      percentualAtual,
      desvioPct,
      valorInvestido,
      saldoAtualMercado,
      lucroPrejuizo,
      rentabilidadePct,
      quantidadeAtivos: ativos.length,
      ativos,
    };
  });

  const saldoContasLiquidas = roundCurrency(input.saldoContasLiquidas);
  const saldoReservaEmergencia = roundCurrency(input.saldoReservaEmergencia);
  const patrimonioTotalGlobal = roundCurrency(
    saldoContasLiquidas + saldoReservaEmergencia + patrimonioCarteira,
  );

  return {
    valorInvestidoCarteira,
    patrimonioCarteira,
    lucroPrejuizoCarteira,
    rentabilidadeCarteiraPct,
    saldoContasLiquidas,
    saldoReservaEmergencia,
    patrimonioTotalGlobal,
    classes,
  };
}

export interface RebalanceClassInput {
  classeAtivo: AssetClass;
  nomeClasse: string;
  isRisco: boolean;
  percentualIdeal: number;
  saldoAtualMercado: number;
}

export interface RebalanceItemResult {
  classeAtivo: AssetClass;
  nomeClasse: string;
  percentualIdeal: number;
  percentualAntes: number;
  percentualDepois: number;
  saldoAntes: number;
  deficitAntes: number;
  valorSugeridoAporte: number;
  saldoProjetado: number;
  bloqueadaPorGatilho: boolean;
}

export interface RebalancePlanResult {
  valorAporte: number;
  modo: 'PRIORIZAR_RESERVA' | 'REBALANCEAMENTO_CARTEIRA';
  orientacaoResumo: string;
  valorSugeridoReserva: number;
  classePrioritaria: AssetClass | null;
  itens: RebalanceItemResult[];
}

export function calculateContributionRebalance(input: {
  valorAporte: number;
  statusGatilho: 'BLOQUEADO' | 'LIBERADO';
  faltaParaGatilhoReserva: number;
  classes: ReadonlyArray<RebalanceClassInput>;
}): RebalancePlanResult {
  const aporte = roundCurrency(Math.max(0, input.valorAporte));
  const totalAntes = roundCurrency(
    input.classes.reduce((acc, c) => acc + Math.max(0, c.saldoAtualMercado), 0),
  );

  if (input.statusGatilho === 'BLOQUEADO') {
    const gapReserva = roundCurrency(Math.max(0, input.faltaParaGatilhoReserva));
    const valorSugeridoReserva = gapReserva > 0 ? roundCurrency(Math.min(aporte, gapReserva)) : 0;
    const restanteParaRf = roundCurrency(Math.max(0, aporte - valorSugeridoReserva));
    const totalDepoisCarteira = roundCurrency(totalAntes + restanteParaRf);

    const itens: RebalanceItemResult[] = input.classes.map((c) => {
      const saldoAntes = roundCurrency(Math.max(0, c.saldoAtualMercado));
      const suggested = c.classeAtivo === 'RF' ? restanteParaRf : 0;
      const saldoProjetado = roundCurrency(saldoAntes + suggested);

      return {
        classeAtivo: c.classeAtivo,
        nomeClasse: c.nomeClasse,
        percentualIdeal: roundCurrency(c.percentualIdeal),
        percentualAntes: totalAntes > 0 ? roundCurrency((saldoAntes / totalAntes) * 100) : 0,
        percentualDepois:
          totalDepoisCarteira > 0 ? roundCurrency((saldoProjetado / totalDepoisCarteira) * 100) : 0,
        saldoAntes,
        deficitAntes: 0,
        valorSugeridoAporte: suggested,
        saldoProjetado,
        bloqueadaPorGatilho: c.isRisco,
      };
    });

    const orientacaoResumo =
      valorSugeridoReserva > 0 && restanteParaRf > 0
        ? `Gatilho da reserva pendente: destine ${valorSugeridoReserva.toFixed(2)} à Reserva de Emergência para desbloquear investimentos e direcione o excedente (${restanteParaRf.toFixed(2)}) à Renda Fixa & Liquidez.`
        : valorSugeridoReserva > 0
          ? `Gatilho da reserva pendente: priorize 100% deste aporte (${valorSugeridoReserva.toFixed(2)}) na Reserva de Emergência antes de aportar em classes de risco.`
          : `Gatilho da reserva pendente: configure sua Reserva de Emergência ou aloque este aporte (${restanteParaRf.toFixed(2)}) apenas em Renda Fixa & Liquidez.`;

    return {
      valorAporte: aporte,
      modo: 'PRIORIZAR_RESERVA',
      orientacaoResumo,
      valorSugeridoReserva,
      classePrioritaria: restanteParaRf > 0 ? 'RF' : null,
      itens,
    };
  }

  const totalNovo = roundCurrency(totalAntes + aporte);
  const rawDeficits = input.classes.map((c) => {
    const saldoAntes = Math.max(0, c.saldoAtualMercado);
    const idealValue = totalNovo * (Math.max(0, c.percentualIdeal) / 100);
    return Math.max(0, idealValue - saldoAntes);
  });

  const sumDeficits = rawDeficits.reduce((acc, d) => acc + d, 0);
  const weights =
    sumDeficits > 0 ? rawDeficits : input.classes.map((c) => Math.max(0, c.percentualIdeal));
  const sumWeights = weights.reduce((acc, w) => acc + w, 0);

  const aporteCents = Math.round(aporte * 100);
  const allocationsCents = new Array<number>(input.classes.length).fill(0);

  if (aporteCents > 0 && sumWeights > 0) {
    const shares = weights.map((weight, idx) => {
      const exact = (weight / sumWeights) * aporteCents;
      const floored = Math.floor(exact);
      return {
        idx,
        floored,
        remainder: exact - floored,
        weight,
        percentualIdeal: input.classes[idx]!.percentualIdeal,
      };
    });

    let remainingCents = aporteCents;
    for (const share of shares) {
      allocationsCents[share.idx] = share.floored;
      remainingCents -= share.floored;
    }

    shares.sort((a, b) => {
      if (Math.abs(b.remainder - a.remainder) > 1e-9) {
        return b.remainder - a.remainder;
      }
      if (Math.abs(b.weight - a.weight) > 1e-9) {
        return b.weight - a.weight;
      }
      return b.percentualIdeal - a.percentualIdeal;
    });

    for (let i = 0; i < remainingCents; i++) {
      const target = shares[i % shares.length]!;
      allocationsCents[target.idx] = (allocationsCents[target.idx] ?? 0) + 1;
    }
  }

  let priorityClass: AssetClass | null = null;
  let maxSuggested = -1;

  const itens: RebalanceItemResult[] = input.classes.map((c, idx) => {
    const saldoAntes = roundCurrency(Math.max(0, c.saldoAtualMercado));
    const suggested = roundCurrency((allocationsCents[idx] ?? 0) / 100);
    const saldoProjetado = roundCurrency(saldoAntes + suggested);

    if (suggested > maxSuggested && suggested > 0) {
      maxSuggested = suggested;
      priorityClass = c.classeAtivo;
    }

    return {
      classeAtivo: c.classeAtivo,
      nomeClasse: c.nomeClasse,
      percentualIdeal: roundCurrency(c.percentualIdeal),
      percentualAntes: totalAntes > 0 ? roundCurrency((saldoAntes / totalAntes) * 100) : 0,
      percentualDepois: totalNovo > 0 ? roundCurrency((saldoProjetado / totalNovo) * 100) : 0,
      saldoAntes,
      deficitAntes: roundCurrency(rawDeficits[idx] ?? 0),
      valorSugeridoAporte: suggested,
      saldoProjetado,
      bloqueadaPorGatilho: false,
    };
  });

  const priorityItem = itens.find((item) => item.classeAtivo === priorityClass) ?? null;
  const orientacaoResumo = priorityItem
    ? `Foque principalmente em ${priorityItem.nomeClasse} (${priorityItem.valorSugeridoAporte.toFixed(2)}) para aproximar sua carteira da alocação-alvo sem vender ativos.`
    : 'Sua carteira já está equilibrada conforme os percentuais-alvo.';

  return {
    valorAporte: aporte,
    modo: 'REBALANCEAMENTO_CARTEIRA',
    orientacaoResumo,
    valorSugeridoReserva: 0,
    classePrioritaria: priorityClass,
    itens,
  };
}

export const COMPOUND_HORIZONS_YEARS = [1, 5, 10, 20] as const;

export interface CompoundHorizonResult {
  anos: number;
  meses: number;
  totalAportado: number;
  jurosAcumulados: number;
  patrimonioFinal: number;
  rendaPassivaMensalEstimada: number;
  multiplicadorPatrimonio: number;
}

export interface CompoundSimulationResult {
  saldoInicial: number;
  aporteMensal: number;
  taxaAnualRealPct: number;
  taxaMensalEquivalentePct: number;
  metaPatrimonio: number | null;
  mesesParaMeta: number | null;
  anosParaMeta: number | null;
  horizons: CompoundHorizonResult[];
}

export function simulateCompoundInterest(input: {
  saldoInicial: number;
  aporteMensal: number;
  taxaAnualRealPct: number;
  metaPatrimonio?: number | null;
}): CompoundSimulationResult {
  const saldoInicial = roundCurrency(Math.max(0, input.saldoInicial));
  const aporteMensal = roundCurrency(Math.max(0, input.aporteMensal));
  const taxaAnualRealPct = Math.min(100, Math.max(0, Number(input.taxaAnualRealPct.toFixed(4))));
  const metaPatrimonio =
    input.metaPatrimonio && input.metaPatrimonio > 0 ? roundCurrency(input.metaPatrimonio) : null;

  const monthlyRate = taxaAnualRealPct <= 0 ? 0 : Math.pow(1 + taxaAnualRealPct / 100, 1 / 12) - 1;
  const taxaMensalEquivalentePct = Number((monthlyRate * 100).toFixed(4));

  const projectAtMonths = (months: number): CompoundHorizonResult => {
    const totalAportado = roundCurrency(saldoInicial + aporteMensal * months);
    const patrimonioFinal =
      monthlyRate === 0
        ? totalAportado
        : roundCurrency(
            saldoInicial * Math.pow(1 + monthlyRate, months) +
              aporteMensal * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate),
          );
    const jurosAcumulados = roundCurrency(Math.max(0, patrimonioFinal - totalAportado));
    const rendaPassivaMensalEstimada = roundCurrency(patrimonioFinal * monthlyRate);
    const multiplicadorPatrimonio =
      totalAportado > 0 ? roundCurrency(patrimonioFinal / totalAportado) : 0;

    return {
      anos: months / 12,
      meses: months,
      totalAportado,
      jurosAcumulados,
      patrimonioFinal,
      rendaPassivaMensalEstimada,
      multiplicadorPatrimonio,
    };
  };

  const horizons = COMPOUND_HORIZONS_YEARS.map((years) => projectAtMonths(years * 12));

  let mesesParaMeta: number | null = null;
  let anosParaMeta: number | null = null;

  if (metaPatrimonio !== null) {
    if (saldoInicial >= metaPatrimonio) {
      mesesParaMeta = 0;
      anosParaMeta = 0;
    } else if (aporteMensal > 0 || monthlyRate > 0) {
      for (let month = 1; month <= 1200; month++) {
        const projected = projectAtMonths(month).patrimonioFinal;
        if (projected >= metaPatrimonio) {
          mesesParaMeta = month;
          anosParaMeta = Number((month / 12).toFixed(1));
          break;
        }
      }
    }
  }

  return {
    saldoInicial,
    aporteMensal,
    taxaAnualRealPct: Number(taxaAnualRealPct.toFixed(2)),
    taxaMensalEquivalentePct,
    metaPatrimonio,
    mesesParaMeta,
    anosParaMeta,
    horizons,
  };
}
