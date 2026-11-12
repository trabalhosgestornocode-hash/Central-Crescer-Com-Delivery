// Contratos de entrada das consultas de Vendas e Recebimentos (Execução 06B). Somente leitura.
// Campo desconhecido é recusado; organização e unidade NUNCA vêm daqui — vêm do contexto autenticado.
import { CODIGO, falhar } from "../dominio/erros.js";
import { CANAL, FORMA_PAGAMENTO, PROCESSADOR } from "../dominio/catalogos.js";
import { exigirCentavos } from "../dominio/dinheiro.js";
import { diasEntre, exigirCompetencia, exigirData } from "../dominio/tempo.js";
import { DIVERGENCIA_VENDA, FORMA_DESCONHECIDA, SEM_CANAL, SEM_PROCESSADOR, SITUACAO_OPERACAO, SITUACAO_RECEBIMENTO, TIPO_COMPONENTE } from "../dominio/vendasRecebimentos.js";
import { exigirInteiro, exigirTexto, exigirUmDe, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";

const MAX_DIAS = 400;
const opc = (v, fn) => (v === undefined || v === null || v === "" ? null : fn(v));
const BASE = ["competencia", "inicio", "fim", "canal", "forma", "processador", "situacao", "valorMinimoCentavos", "valorMaximoCentavos", "identificador", "pagina", "tamanho"];

/**
 * Filtro comum. Exige competência OU período (início e fim, até 400 dias): consulta sem recorte de tempo não existe —
 * é o controle de volume. Página até 100 itens.
 */
function filtroBase(e, extras, contexto, situacoes = SITUACAO_OPERACAO) {
  semCamposDesconhecidos(e, [...BASE, ...extras], contexto);
  const f = {
    competencia: opc(e.competencia, (v) => exigirCompetencia(v)),
    inicio: opc(e.inicio, (v) => exigirData(v, "inicio")), fim: opc(e.fim, (v) => exigirData(v, "fim")),
    canal: opc(e.canal, (v) => exigirUmDe(v, [...Object.values(CANAL), SEM_CANAL], "canal")),
    forma: opc(e.forma, (v) => exigirUmDe(v, [...Object.values(FORMA_PAGAMENTO), FORMA_DESCONHECIDA], "forma")),
    processador: opc(e.processador, (v) => exigirUmDe(v, [...Object.values(PROCESSADOR), SEM_PROCESSADOR], "processador")),
    situacao: opc(e.situacao, (v) => exigirUmDe(v, situacoes, "situacao")),
    valorMinimoCentavos: opc(e.valorMinimoCentavos, (v) => exigirCentavos(v, "valorMinimoCentavos", { naoNegativo: true })),
    valorMaximoCentavos: opc(e.valorMaximoCentavos, (v) => exigirCentavos(v, "valorMaximoCentavos", { naoNegativo: true })),
    identificador: opc(e.identificador, (v) => exigirTexto(v, "identificador", { max: 60 })),
    pagina: e.pagina === undefined ? 1 : exigirInteiro(e.pagina, "pagina", { min: 1, max: 100000 }),
    tamanho: e.tamanho === undefined ? 25 : exigirInteiro(e.tamanho, "tamanho", { min: 1, max: 100 }),
  };
  if (!f.competencia && !(f.inicio && f.fim)) falhar(CODIGO.ENTRADA_INVALIDA, "Informe a competência ou o período (início e fim).", { campo: "competencia" });
  if ((f.inicio && !f.fim) || (f.fim && !f.inicio)) falhar(CODIGO.ENTRADA_INVALIDA, "O período precisa de início e fim.", { campo: f.inicio ? "fim" : "inicio" });
  if (f.inicio && f.fim && f.fim < f.inicio) falhar(CODIGO.DATA_INVALIDA, "periodo: o fim não pode ser anterior ao início.", { campo: "periodo" });
  if (f.inicio && f.fim && diasEntre(f.inicio, f.fim) > MAX_DIAS) falhar(CODIGO.DATA_INVALIDA, `O período consultado não pode passar de ${MAX_DIAS} dias.`, { campo: "fim" });
  if (f.valorMinimoCentavos !== null && f.valorMaximoCentavos !== null && f.valorMaximoCentavos < f.valorMinimoCentavos) {
    falhar(CODIGO.VALOR_INVALIDO, "O valor máximo não pode ser menor que o mínimo.", { campo: "valorMaximoCentavos" });
  }
  return f;
}

export const validarFiltroDeVendas = (e = {}) => filtroBase(e, [], "vendas");
export const validarFiltroDePagamentos = (e = {}) => filtroBase(e, [], "pagamentos");
export function validarFiltroDeTaxas(e = {}) {
  const f = filtroBase(e, ["tipoComponente"], "taxasEDescontos");
  return { ...f, tipoComponente: opc(e.tipoComponente, (v) => exigirUmDe(v, TIPO_COMPONENTE, "tipoComponente")) };
}
export function validarFiltroDeRecebiveis(e = {}) {
  const f = filtroBase(e, ["recebimento"], "recebiveis");
  return { ...f, recebimento: opc(e.recebimento, (v) => exigirUmDe(v, SITUACAO_RECEBIMENTO, "recebimento")) };
}
export function validarFiltroDeDivergencias(e = {}) {
  const f = filtroBase(e, ["codigo"], "divergencias");
  return { ...f, codigo: opc(e.codigo, (v) => exigirUmDe(v, DIVERGENCIA_VENDA, "codigo")) };
}
export function validarDetalheDeVenda(e = {}) {
  semCamposDesconhecidos(e, ["id"], "detalheDeVenda");
  return { id: exigirUuid(e.id, "id") };
}
