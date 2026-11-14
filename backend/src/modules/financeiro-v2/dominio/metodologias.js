// Execução 06D — metodologias de apuração VERSIONADAS.
//
// A metodologia é parte do código (o motor de dominio/apuracao.js implementa uma versão por vez). Este catálogo publica
// o que cada versão significa, desde quando vale e quais critérios de fechamento exige. Regras:
//   - uma versão nova NUNCA recalcula competências homologadas: a versão homologada guarda o retrato da apuração e a
//     metodologia usada (VERSAO_FECHAMENTO); reapurar com outra metodologia exige reabertura formal (revisão);
//   - homologar com uma metodologia diferente da que o motor aplica é recusado (o retrato não seria reproduzível).
import { CODIGO, falhar } from "./erros.js";
import { METODOLOGIA } from "./apuracao.js";
import { exigirCompetencia } from "./tempo.js";

export const METODOLOGIAS = Object.freeze([
  Object.freeze({
    codigo: METODOLOGIA.nome,
    versao: METODOLOGIA.versao,
    nome: "DRE Gerencial — Resultado Gerencial Sem Ajuste de Estoque",
    vigenteDesde: "2026-01",
    vigenteAte: null,
    publicadaEm: "2026-11-12",
    resumo: "Receita pelo bruto próprio da venda; deduções, custos e despesas pela categoria do plano de contas; compras de insumos como custo do mês (sem ajuste de estoque); patrimoniais fora do resultado.",
    criteriosDeFechamento: Object.freeze([
      "Importações da competência concluídas e operações importadas aplicadas ou rejeitadas com justificativa.",
      "Nenhuma classificação provisória (a classificar) que altere o resultado.",
      "Divergências entre relatórios explicadas; divergências de conciliação com resolução comprovada por documento.",
      "Saldos informados conferem com os calculados.",
      "Sem receita em duplicidade (agregado diário e pedidos no mesmo dia).",
      "Recebíveis válidos ainda não pagos NÃO bloqueiam (são posição financeira, não resultado).",
      "Sem política de materialidade aprovada: nenhuma tolerância em reais ou percentual.",
    ]),
  }),
]);

export const identificadorDa = (m) => `${m.codigo}@${m.versao}`;

/** Metodologia vigente para uma competência (a de vigência mais recente que a cobre). */
export function metodologiaVigente(competencia) {
  exigirCompetencia(competencia);
  const candidatas = METODOLOGIAS.filter((m) => m.vigenteDesde <= competencia && (!m.vigenteAte || competencia <= m.vigenteAte));
  const m = candidatas.sort((a, b) => (a.vigenteDesde < b.vigenteDesde ? 1 : -1))[0];
  if (!m) falhar(CODIGO.TRANSICAO_INVALIDA, "Não há metodologia vigente publicada para esta competência.", { competencia });
  return m;
}

/** Confere que a metodologia pedida (se houver) é a que o motor aplica a esta competência. */
export function exigirMetodologiaAplicavel(competencia, pedida) {
  const vigente = metodologiaVigente(competencia);
  if (vigente.codigo !== METODOLOGIA.nome || vigente.versao !== METODOLOGIA.versao) {
    falhar(CODIGO.TRANSICAO_INVALIDA, "A metodologia vigente não é a implementada pelo motor: publique a versão antes de homologar.", { vigente: identificadorDa(vigente) });
  }
  if (pedida && pedida !== identificadorDa(vigente)) {
    falhar(CODIGO.TRANSICAO_INVALIDA, "A metodologia informada não é a vigente para esta competência: homologar com outra versão exige revisão formal.", { pedida: String(pedida).slice(0, 80), vigente: identificadorDa(vigente) });
  }
  return vigente;
}
