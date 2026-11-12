// Contratos de entrada das importações e da preparação da conciliação. Estritos como os demais (campo desconhecido = erro).
// Organização, unidade e usuário nunca vêm no comando: vêm do contexto montado pelo adaptador de sessão.
import { CODIGO, falhar } from "../dominio/erros.js";
import { RELACAO_CORRESPONDENCIA, SISTEMA_FONTE } from "../dominio/catalogos.js";
import { exigirData } from "../dominio/tempo.js";
import { exigirTexto, exigirUmDe, exigirUuid, semCamposDesconhecidos, uuidOpcional } from "../dominio/validacao.js";
import { TAMANHO_MAXIMO_BYTES } from "./cofre.js";

const MIME = /^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9][a-z0-9.+-]{0,60}$/;
const TIPO_RELATORIO = /^[A-Z][A-Z0-9_]{2,79}$/;
const DIAS_MAXIMOS_DO_PERIODO = 92;

function periodo(inicio, fim) {
  const i = exigirData(inicio, "periodoInicio");
  const f = exigirData(fim, "periodoFim");
  if (f < i) falhar(CODIGO.IMPORTACAO_INVALIDA, "O período termina antes de começar.");
  if (Date.parse(`${f}T00:00:00Z`) - Date.parse(`${i}T00:00:00Z`) > DIAS_MAXIMOS_DO_PERIODO * 86400000) {
    falhar(CODIGO.IMPORTACAO_INVALIDA, `Período de importação maior que ${DIAS_MAXIMOS_DO_PERIODO} dias.`);
  }
  return { periodoInicio: i, periodoFim: f };
}

export function validarRecebimentoDeArquivo(e) {
  semCamposDesconhecidos(e, ["fonte", "tipoRelatorio", "tipoMime", "conteudo", "periodoInicio", "periodoFim", "substituiImportacaoId", "descricao"], "arquivo");
  if (!(e.conteudo instanceof Uint8Array) || e.conteudo.byteLength === 0) falhar(CODIGO.IMPORTACAO_INVALIDA, "Arquivo ausente ou vazio.", { campo: "conteudo" });
  if (e.conteudo.byteLength > TAMANHO_MAXIMO_BYTES) falhar(CODIGO.IMPORTACAO_INVALIDA, "Arquivo maior que o limite do cofre.", { campo: "conteudo" });
  if (typeof e.tipoMime !== "string" || !MIME.test(e.tipoMime)) falhar(CODIGO.IMPORTACAO_INVALIDA, "Tipo de arquivo inválido.", { campo: "tipoMime" });
  if (typeof e.tipoRelatorio !== "string" || !TIPO_RELATORIO.test(e.tipoRelatorio)) falhar(CODIGO.IMPORTACAO_INVALIDA, "Tipo de relatório inválido.", { campo: "tipoRelatorio" });
  return {
    fonte: exigirUmDe(e.fonte, SISTEMA_FONTE, "fonte"),
    tipoRelatorio: e.tipoRelatorio,
    tipoMime: e.tipoMime,
    conteudo: e.conteudo,
    ...periodo(e.periodoInicio, e.periodoFim),
    substituiImportacaoId: uuidOpcional(e.substituiImportacaoId, "substituiImportacaoId"),
    descricao: exigirTexto(e.descricao, "descricao", { opcional: true }),
  };
}

export function validarConfirmacaoDeImportacao(e) {
  semCamposDesconhecidos(e, ["importacaoId", "impressaoPrevia", "aceitarPendencias", "justificativa"], "confirmacao");
  if (typeof e.impressaoPrevia !== "string" || !/^[0-9a-f]{64}$/.test(e.impressaoPrevia)) {
    falhar(CODIGO.IMPORTACAO_INVALIDA, "A confirmação precisa citar a impressão da prévia revisada.", { campo: "impressaoPrevia" });
  }
  if (e.aceitarPendencias !== undefined && typeof e.aceitarPendencias !== "boolean") falhar(CODIGO.ENTRADA_INVALIDA, "aceitarPendencias deve ser verdadeiro ou falso.");
  return {
    importacaoId: exigirUuid(e.importacaoId, "importacaoId"),
    impressaoPrevia: e.impressaoPrevia,
    aceitarPendencias: e.aceitarPendencias === true,
    justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500, opcional: true }),
  };
}

export function validarReferenciaDeImportacao(e) {
  semCamposDesconhecidos(e, ["importacaoId", "justificativa"], "importacao");
  return { importacaoId: exigirUuid(e.importacaoId, "importacaoId"), justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500, opcional: true }) };
}

export function validarPeriodo(e) {
  semCamposDesconhecidos(e, ["periodoInicio", "periodoFim"], "periodo");
  return periodo(e.periodoInicio, e.periodoFim);
}

export function validarGeracaoDeCandidatas(e) {
  semCamposDesconhecidos(e, ["relacao", "periodoInicio", "periodoFim"], "geracao");
  const relacao = exigirUmDe(e.relacao, RELACAO_CORRESPONDENCIA, "relacao");
  if (relacao === RELACAO_CORRESPONDENCIA.MANUAL) falhar(CODIGO.CONCILIACAO_INVALIDA, "Correspondência manual é criada por criarCorrespondenciaCandidata.");
  return { relacao, ...periodo(e.periodoInicio, e.periodoFim) };
}

export function validarLeituraDeDocumento(e) {
  semCamposDesconhecidos(e, ["documentoId"], "leitura");
  return { documentoId: exigirUuid(e.documentoId, "documentoId") };
}
