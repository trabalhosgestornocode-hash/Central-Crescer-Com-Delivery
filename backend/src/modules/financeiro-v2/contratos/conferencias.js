// Contratos de entrada da Central de Conferências (Execução 06C). Somente leitura.
// Campo desconhecido é recusado; organização e unidade NUNCA vêm daqui — vêm do contexto autenticado.
import { ESTADO_IMPORTACAO, ESTADO_PROPOSTA, OPERACAO_PROPOSTA, RELACAO_CORRESPONDENCIA, SISTEMA_FONTE, SITUACAO_CORRESPONDENCIA } from "../dominio/catalogos.js";
import { GRUPO, SITUACAO_PENDENCIA } from "../dominio/conferencias.js";
import { CODIGO, falhar } from "../dominio/erros.js";
import { exigirCompetencia } from "../dominio/tempo.js";
import { exigirInteiro, exigirTexto, exigirUmDe, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";

const opc = (v, fn) => (v === undefined || v === null || v === "" ? null : fn(v));
const pagina = (e) => ({
  pagina: e.pagina === undefined ? 1 : exigirInteiro(e.pagina, "pagina", { min: 1, max: 100000 }),
  tamanho: e.tamanho === undefined ? 20 : exigirInteiro(e.tamanho, "tamanho", { min: 1, max: 100 }),
});
/** Lista de valores de um catálogo ("A,B" ou ["A","B"]). */
const lista = (v, catalogo, campo) => {
  const itens = Array.isArray(v) ? v : String(v).split(",").filter(Boolean);
  if (!itens.length || itens.length > 20) falhar(CODIGO.ENTRADA_INVALIDA, `${campo}: informe de 1 a 20 valores.`, { campo });
  return [...new Set(itens.map((x) => exigirUmDe(x, catalogo, campo)))];
};

export function validarCompetenciaDaCentral(e = {}) {
  semCamposDesconhecidos(e, ["competencia"], "central");
  return { competencia: exigirCompetencia(e.competencia) };
}

export function validarFiltroDeDocumentos(e = {}) {
  semCamposDesconhecidos(e, ["competencia", "fonte", "estado", "pagina", "tamanho"], "documentos");
  return {
    competencia: opc(e.competencia, (v) => exigirCompetencia(v)), fonte: opc(e.fonte, (v) => exigirUmDe(v, SISTEMA_FONTE, "fonte")),
    estados: opc(e.estado, (v) => lista(v, ESTADO_IMPORTACAO, "estado")), ...pagina(e),
  };
}

export function validarFiltroDePropostas(e = {}) {
  semCamposDesconhecidos(e, ["competencia", "estado", "operacao", "pagina", "tamanho"], "propostas");
  return {
    competencia: exigirCompetencia(e.competencia), estados: opc(e.estado, (v) => lista(v, ESTADO_PROPOSTA, "estado")),
    operacao: opc(e.operacao, (v) => exigirUmDe(v, OPERACAO_PROPOSTA, "operacao")), ...pagina(e),
  };
}

export function validarFiltroDeCorrespondencias(e = {}) {
  semCamposDesconhecidos(e, ["competencia", "situacao", "relacao", "pagina", "tamanho"], "correspondencias");
  return {
    competencia: exigirCompetencia(e.competencia), situacoes: opc(e.situacao, (v) => lista(v, SITUACAO_CORRESPONDENCIA, "situacao")),
    relacao: opc(e.relacao, (v) => exigirUmDe(v, RELACAO_CORRESPONDENCIA, "relacao")), ...pagina(e),
  };
}

export function validarFiltroDePendencias(e = {}) {
  semCamposDesconhecidos(e, ["competencia", "grupo", "situacao", "pagina", "tamanho"], "pendencias");
  return {
    competencia: exigirCompetencia(e.competencia), grupo: opc(e.grupo, (v) => exigirUmDe(v, GRUPO, "grupo")),
    situacao: opc(e.situacao, (v) => exigirUmDe(v, [...Object.values(SITUACAO_PENDENCIA), "A_RESOLVER"], "situacao")), ...pagina(e),
  };
}

export function validarDetalhe(e = {}) {
  semCamposDesconhecidos(e, ["id"], "detalhe");
  return { id: exigirUuid(e.id, "id") };
}

/** A chave de uma pendência é "TIPO:identificador[:faceta]" — só caracteres seguros, tamanho limitado. */
export function validarDetalheDePendencia(e = {}) {
  semCamposDesconhecidos(e, ["competencia", "chave"], "detalheDePendencia");
  const chave = exigirTexto(e.chave, "chave", { max: 160 });
  if (!/^[A-Z_]+:[A-Za-z0-9_:.-]+$/.test(chave)) falhar(CODIGO.ENTRADA_INVALIDA, "Chave de pendência inválida.", { campo: "chave" });
  return { competencia: exigirCompetencia(e.competencia), chave };
}
