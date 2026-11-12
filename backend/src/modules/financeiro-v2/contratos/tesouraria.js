// Contratos de entrada da tesouraria (Execução 06A): filtros das consultas e comandos de saldo informado e caixa físico.
// Campo desconhecido é recusado; organização e unidade NUNCA vêm daqui — vêm do contexto autenticado.
import { CODIGO, falhar } from "../dominio/erros.js";
import { CANAL, OPERACAO_CAIXA, PROCESSADOR } from "../dominio/catalogos.js";
import { exigirCentavos } from "../dominio/dinheiro.js";
import { diasEntre, exigirCompetencia, exigirData } from "../dominio/tempo.js";
import { GRANULARIDADE, REFERENCIA_SALDO, SITUACAO_A_PAGAR, SITUACAO_A_RECEBER, TIPO_DE_RECEBIVEL } from "../dominio/tesouraria.js";
import { exigirInteiro, exigirTexto, exigirUmDe, exigirUuid, semCamposDesconhecidos, uuidOpcional } from "../dominio/validacao.js";

const MAX_DIAS = 400;
const opc = (v, fn) => (v === undefined || v === null || v === "" ? null : fn(v));
const pagina = (e) => ({ pagina: e.pagina === undefined ? 1 : exigirInteiro(e.pagina, "pagina", { min: 1, max: 100000 }), tamanho: e.tamanho === undefined ? 50 : exigirInteiro(e.tamanho, "tamanho", { min: 1, max: 100 }) });
const faixa = (de, ate, campo) => {
  if (de && ate && ate < de) falhar(CODIGO.DATA_INVALIDA, `${campo}: o fim não pode ser anterior ao início.`, { campo });
};

export function validarFiltroAPagar(e = {}) {
  semCamposDesconhecidos(e, ["competencia", "vencimentoDe", "vencimentoAte", "contraparteId", "categoria", "situacao", "pagina", "tamanho"], "contasAPagar");
  const f = {
    competencia: opc(e.competencia, (v) => exigirCompetencia(v)), vencimentoDe: opc(e.vencimentoDe, (v) => exigirData(v, "vencimentoDe")),
    vencimentoAte: opc(e.vencimentoAte, (v) => exigirData(v, "vencimentoAte")), contraparteId: uuidOpcional(e.contraparteId || undefined, "contraparteId"),
    categoria: opc(e.categoria, (v) => exigirTexto(v, "categoria", { max: 80 })), situacao: opc(e.situacao, (v) => exigirUmDe(v, SITUACAO_A_PAGAR, "situacao")), ...pagina(e),
  };
  faixa(f.vencimentoDe, f.vencimentoAte, "vencimento");
  return f;
}

export function validarFiltroAReceber(e = {}) {
  semCamposDesconhecidos(e, ["competencia", "previstoDe", "previstoAte", "processador", "canal", "tipo", "situacao", "pagina", "tamanho"], "contasAReceber");
  const f = {
    competencia: opc(e.competencia, (v) => exigirCompetencia(v)), previstoDe: opc(e.previstoDe, (v) => exigirData(v, "previstoDe")), previstoAte: opc(e.previstoAte, (v) => exigirData(v, "previstoAte")),
    processador: opc(e.processador, (v) => exigirUmDe(v, PROCESSADOR, "processador")), canal: opc(e.canal, (v) => exigirUmDe(v, CANAL, "canal")),
    tipo: opc(e.tipo, (v) => exigirUmDe(v, TIPO_DE_RECEBIVEL, "tipo")), situacao: opc(e.situacao, (v) => exigirUmDe(v, SITUACAO_A_RECEBER, "situacao")), ...pagina(e),
  };
  faixa(f.previstoDe, f.previstoAte, "previsto");
  return f;
}

function periodo(e) {
  const inicio = exigirData(e.inicio, "inicio");
  const fim = exigirData(e.fim, "fim");
  faixa(inicio, fim, "periodo");
  if (diasEntre(inicio, fim) > MAX_DIAS) falhar(CODIGO.DATA_INVALIDA, `O período consultado não pode passar de ${MAX_DIAS} dias.`, { campo: "fim" });
  return { inicio, fim };
}

export function validarFiltroCaixaEBancos(e = {}) {
  semCamposDesconhecidos(e, ["inicio", "fim", "contaId", "pagina", "tamanho"], "caixaEBancos");
  return { ...periodo(e), contaId: uuidOpcional(e.contaId || undefined, "contaId"), ...pagina(e) };
}

export function validarFiltroFluxo(e = {}) {
  semCamposDesconhecidos(e, ["inicio", "fim", "granularidade"], "fluxoDeCaixa");
  return { ...periodo(e), granularidade: e.granularidade === undefined ? GRANULARIDADE.DIA : exigirUmDe(e.granularidade, GRANULARIDADE, "granularidade") };
}

export function validarFiltroCalendario(e = {}) {
  semCamposDesconhecidos(e, ["mes"], "calendario");
  return { mes: exigirCompetencia(e.mes, "mes") };
}

export function validarFiltroResumo(e = {}) {
  semCamposDesconhecidos(e, ["competencia"], "resumoFinanceiro");
  return { competencia: exigirCompetencia(e.competencia) };
}

export function validarDetalheDeTitulo(e = {}) {
  semCamposDesconhecidos(e, ["id"], "detalhe");
  return { id: exigirUuid(e.id, "id") };
}

/**
 * Saldo INFORMADO de uma conta (extrato, contagem) com a REFERÊNCIA do momento: INICIO_DO_DIA (padrão — "saldo anterior")
 * ou FIM_DO_DIA ("saldo final", já inclui os movimentos do dia). Banco pode estar negativo; caixa físico não.
 */
export function validarSaldoDeConta(e) {
  semCamposDesconhecidos(e, ["contaId", "data", "referencia", "valorCentavos", "documentoId", "observacao"], "saldoDeConta");
  return {
    contaId: exigirUuid(e.contaId, "contaId"), data: exigirData(e.data, "data"),
    referencia: e.referencia === undefined ? REFERENCIA_SALDO.INICIO_DO_DIA : exigirUmDe(e.referencia, REFERENCIA_SALDO, "referencia"),
    valorCentavos: exigirCentavos(e.valorCentavos, "valorCentavos"),
    documentoId: uuidOpcional(e.documentoId, "documentoId"), observacao: exigirTexto(e.observacao, "observacao", { max: 300, opcional: true }),
  };
}

export function validarAberturaDeCaixa(e) {
  semCamposDesconhecidos(e, ["contaId", "dataAbertura", "saldoContadoCentavos", "observacao"], "aberturaDeCaixa");
  return {
    contaId: exigirUuid(e.contaId, "contaId"), dataAbertura: exigirData(e.dataAbertura, "dataAbertura"),
    saldoAberturaCentavos: exigirCentavos(e.saldoContadoCentavos, "saldoContadoCentavos", { naoNegativo: true }),
    observacao: exigirTexto(e.observacao, "observacao", { max: 300, opcional: true }),
  };
}

/** Sangria/suprimento com `contraContaId` é transferência interna (ex.: caixa → banco); sem ela, é dinheiro que saiu/entrou de fora. */
export function validarOperacaoDeCaixa(e) {
  semCamposDesconhecidos(e, ["sessaoId", "operacao", "valorCentavos", "data", "descricao", "contraContaId"], "operacaoDeCaixa");
  const operacao = exigirUmDe(e.operacao, OPERACAO_CAIXA, "operacao");
  const contraContaId = uuidOpcional(e.contraContaId, "contraContaId");
  if (contraContaId && ![OPERACAO_CAIXA.SANGRIA, OPERACAO_CAIXA.SUPRIMENTO].includes(operacao)) {
    falhar(CODIGO.ENTRADA_INVALIDA, "Só sangria e suprimento aceitam conta de contrapartida.", { campo: "contraContaId" });
  }
  return {
    sessaoId: exigirUuid(e.sessaoId, "sessaoId"), operacao, valorCentavos: exigirCentavos(e.valorCentavos, "valorCentavos", { positivo: true }),
    data: exigirData(e.data, "data"), descricao: exigirTexto(e.descricao, "descricao", { max: 200 }), contraContaId,
  };
}

export function validarFechamentoDeCaixa(e) {
  semCamposDesconhecidos(e, ["sessaoId", "dataFechamento", "contadoCentavos", "justificativa", "confirmar"], "fechamentoDeCaixa");
  if (e.confirmar !== true) falhar(CODIGO.ENTRADA_INVALIDA, "O fechamento de caixa exige confirmação explícita.", { campo: "confirmar" });
  return {
    sessaoId: exigirUuid(e.sessaoId, "sessaoId"), dataFechamento: exigirData(e.dataFechamento, "dataFechamento"),
    contadoCentavos: exigirCentavos(e.contadoCentavos, "contadoCentavos", { naoNegativo: true }),
    justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500, opcional: true }),
  };
}
