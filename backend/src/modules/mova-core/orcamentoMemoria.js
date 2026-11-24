// MOVA CORE — orçamento em MEMÓRIA com o MESMO contrato do orçamento renovável (reservar / concluir / falhar / resumo), para o
// ambiente isolado e a avaliação. Limites de homologação (decisão 24/11): US$ 10/mês, US$ 1/dia, US$ 0,10/requisição, 6 etapas.
// A reserva de cada chamada é o PIOR CASO (reservaPiorCaso): não depende de cache para respeitar o teto.
import { reservaPiorCaso } from "../mova-financeiro/infra/orcamentoRenovavel.js";
import { custoRealMicrousd } from "./custo.js";

export const LIMITES_HOMOLOGACAO = Object.freeze({ mensalMicrousd: 10_000_000, diarioMicrousd: 1_000_000, requisicaoMicrousd: 100_000, maxPassos: 6 });

export class ErroDeOrcamento extends Error { constructor(codigo) { super(codigo); this.codigo = codigo; } }

export function criarOrcamentoMemoria(limites = LIMITES_HOMOLOGACAO, { totalMicrousd = Infinity } = {}) {
  const lancamentos = new Map();
  let n = 0;
  const soma = (f) => [...lancamentos.values()].filter(f).reduce((a, l) => a + l.custo, 0);
  return Object.freeze({
    ambiente: "ISOLADO", // F2: o modo sombra só aceita orçamento isolado (nunca o renovável de produção)
    reservar({ modelo, requisicaoId, tokensDePrompt, maxTokens }) {
      const r = reservaPiorCaso({ modelo, tokensDePrompt, maxTokens });
      const req = [...lancamentos.values()].filter((l) => l.requisicaoId === requisicaoId);
      if (soma(() => true) + r > Math.min(limites.mensalMicrousd, totalMicrousd)) throw new ErroDeOrcamento("ORCAMENTO_MENSAL_ESGOTADO");
      if (soma(() => true) + r > limites.diarioMicrousd) throw new ErroDeOrcamento("ORCAMENTO_DIARIO_ESGOTADO");
      if (req.reduce((a, l) => a + l.custo, 0) + r > limites.requisicaoMicrousd) throw new ErroDeOrcamento("ORCAMENTO_REQUISICAO_ESGOTADO");
      if (req.length >= limites.maxPassos) throw new ErroDeOrcamento("PASSOS_ESGOTADOS");
      const id = ++n;
      lancamentos.set(id, { requisicaoId, custo: r, reserva: r, estado: "RESERVADA" });
      return id;
    },
    concluir(id, { modelo, uso }) {
      const l = lancamentos.get(id);
      l.custo = custoRealMicrousd({ modelo, uso }); l.estado = "CONCLUIDA";
      if (l.custo > l.reserva) l.excedeuReserva = true; // nunca deveria acontecer (teste OR-02)
      return l.custo;
    },
    falhar(id, { possivelmenteFaturada = false } = {}) { const l = lancamentos.get(id); l.estado = "FALHOU"; if (!possivelmenteFaturada) l.custo = 0; },
    resumo() {
      const ls = [...lancamentos.values()];
      return { chamadas: ls.length, gastoMicrousd: soma((l) => l.estado === "CONCLUIDA"), reservadoMicrousd: soma((l) => l.estado === "RESERVADA"), excedeuReserva: ls.filter((l) => l.excedeuReserva).length };
    },
  });
}
