// ADMINISTRAÇÃO CORPORATIVA do Financeiro v2 no PostgreSQL (migração 0022). Tudo pelo pool da AUTORIDADE (papel próprio,
// nunca o da aplicação). Quem decide é o BANCO: só administrador financeiro corporativo ativo da empresa libera
// unidades em lote ou concede acessos; este arquivo valida a forma, chama a função e devolve o resultado.
// Não conecta em nada: recebe o pool pronto.
import { ACAO } from "../../dominio/contexto.js";
import { CODIGO, falhar } from "../../dominio/erros.js";
import { ehUuid } from "../../dominio/validacao.js";

const minusc = (x) => String(x).toLowerCase();
const exigirUuidMin = (v, campo) => { if (!ehUuid(v)) falhar(CODIGO.ENTRADA_INVALIDA, `${campo} inválido.`, { motivo: "ID_INVALIDO", campo }); return minusc(v); };
const exigirJustificativa = (v) => {
  if (typeof v !== "string" || v.trim().length < 20 || v.trim().length > 500) falhar(CODIGO.ENTRADA_INVALIDA, "Justificativa obrigatória (20 a 500 caracteres).", { motivo: "JUSTIFICATIVA_INSUFICIENTE" });
  return v.trim();
};
const CATALOGO = new Set(Object.values(ACAO));

/** Perfis de acesso prontos (o painel escolhe um; o catálogo de ações continua sendo o do núcleo). */
export const PERFIS_DE_ACESSO = Object.freeze({
  CONSULTA: [ACAO.VER],
  OPERADOR: [ACAO.VER, ACAO.REGISTRAR, ACAO.CORRIGIR, ACAO.CANCELAR],
  FINANCEIRO: [ACAO.VER, ACAO.REGISTRAR, ACAO.CORRIGIR, ACAO.CANCELAR, ACAO.CONCILIAR, ACAO.REVISAR, ACAO.IMPORTAR, ACAO.CONFIGURAR, ACAO.FECHAR, ACAO.DOCUMENTOS, ACAO.APROVAR, ACAO.APLICAR, ACAO.CONFIRMAR_IMPORTACAO, ACAO.RECLASSIFICAR, ACAO.VINCULAR_PAGAMENTO],
  // 23/11 (decisão do proprietário): TODAS as ações do catálogo, inclusive enviar documento, baixa por comprovante, conta a
  // partir de documento, juros, homologar, reabrir, conceder e revogar. Só o administrador corporativo concede (e nunca a si
  // mesmo: a regra do banco continua valendo); cada concessão exige justificativa e fica no histórico.
  COMPLETO: Object.values(ACAO),
});
// FINANCEIRO não inclui homologar, reabrir e conceder/revogar; COMPLETO inclui tudo (só para quem o proprietário indicar).
// Homologar, reabrir e conceder/revogar NÃO entram em perfil: homologar e reabrir seguem com segundo fator; conceder e
// revogar são do administrador corporativo (painel de ativação).

/** Erros do banco com `errcode` FV0xx viram recusa de negócio (sem expor o texto interno). */
function traduzir(e) {
  const c = e?.code ?? "";
  if (c === "FV043") return falhar(CODIGO.PERMISSAO_INSUFICIENTE, e.message.replace(/^Financeiro v2: /, ""), { motivo: "SEM_AUTORIDADE_CORPORATIVA" });
  if (c === "FV042" || c === "FV030") return falhar(CODIGO.ENTRADA_INVALIDA, e.message.replace(/^Financeiro v2: /, ""), { motivo: c === "FV030" ? "CONCESSAO_RECUSADA" : "ATO_RECUSADO" });
  throw e;
}

/** @param {{query:Function}} poolAutoridade */
export function criarAdministracaoCorporativaPostgres(poolAutoridade) {
  if (typeof poolAutoridade?.query !== "function") throw new Error("Administração corporativa: pool da autoridade ausente.");
  return Object.freeze({
    async ehAdministrador({ organizacaoId, contaId }) {
      const r = await poolAutoridade.query("select fv2_administrador_corporativo_ativo($1, $2) as ok", [exigirUuidMin(organizacaoId, "organizacaoId"), exigirUuidMin(contaId, "contaId")]);
      return r.rows[0]?.ok === true;
    },
    /** Primeiro administrador da empresa exige `segundoFatorEm` (ms) VERIFICADO pelo gateway; os seguintes não. */
    async definirAdministrador({ organizacaoId, contaId, ativo, atorContaId, justificativa, segundoFatorEm = null }) {
      try {
        const r = await poolAutoridade.query("select fv2_administrador_corporativo_definir($1, $2, $3, $4, $5, $6) as v", [
          exigirUuidMin(organizacaoId, "organizacaoId"), exigirUuidMin(contaId, "contaId"), ativo === true, exigirUuidMin(atorContaId, "atorContaId"), exigirJustificativa(justificativa),
          Number.isFinite(segundoFatorEm) ? new Date(segundoFatorEm).toISOString() : null]);
        return { versao: r.rows[0].v };
      } catch (e) { return traduzir(e); }
    },
    async painel({ organizacaoId, atorContaId }) {
      try {
        const r = await poolAutoridade.query("select * from fv2_painel_liberacoes($1, $2)", [exigirUuidMin(organizacaoId, "organizacaoId"), exigirUuidMin(atorContaId, "atorContaId")]);
        return r.rows.map((x) => ({ unidadeId: x.unidade_id, rotulo: x.rotulo, liberada: x.ativa === true && x.empresa_ativa === true, escrita: x.escrita_ativa === true && x.empresa_ativa === true }));
      } catch (e) { return traduzir(e); }
    },
    async acessosDaUnidade({ organizacaoId, unidadeId, atorContaId }) {
      try {
        const r = await poolAutoridade.query("select * from fv2_painel_acessos($1, $2, $3)", [exigirUuidMin(organizacaoId, "organizacaoId"), exigirUuidMin(unidadeId, "unidadeId"), exigirUuidMin(atorContaId, "atorContaId")]);
        return r.rows.map((x) => ({ perfilId: x.usuario_id, acoes: x.acoes, ativa: x.situacao === "ATIVA" }));
      } catch (e) { return traduzir(e); }
    },
    async listarAdministradores({ organizacaoId, atorContaId }) {
      try {
        const r = await poolAutoridade.query("select * from fv2_painel_administradores($1, $2)", [exigirUuidMin(organizacaoId, "organizacaoId"), exigirUuidMin(atorContaId, "atorContaId")]);
        return r.rows.map((x) => ({ contaId: x.conta_id, ativo: x.ativo, alteradoEm: x.alterado_em }));
      } catch (e) { return traduzir(e); }
    },
    /** Liga/desliga o Financeiro v2 (e a escrita) em várias unidades de UMA empresa, numa só transação. */
    async liberarEmLote({ organizacaoId, unidades, ativa, escrita = null, atorContaId, justificativa }) {
      if (!Array.isArray(unidades) || unidades.length < 1 || unidades.length > 50) falhar(CODIGO.ENTRADA_INVALIDA, "Escolha de 1 a 50 unidades.", { motivo: "UNIDADES_INVALIDAS" });
      if (typeof ativa !== "boolean" || (escrita !== null && typeof escrita !== "boolean")) falhar(CODIGO.ENTRADA_INVALIDA, "Estado inválido.", { motivo: "ESTADO_INVALIDO" });
      try {
        const r = await poolAutoridade.query("select fv2_liberacao_alterar_lote($1, $2::uuid[], $3, $4, $5, $6) as n", [
          exigirUuidMin(organizacaoId, "organizacaoId"), [...new Set(unidades.map((u, i) => exigirUuidMin(u, `unidades[${i}]`)))], ativa, escrita, exigirUuidMin(atorContaId, "atorContaId"), exigirJustificativa(justificativa)]);
        return { unidadesAlteradas: r.rows[0].n };
      } catch (e) { return traduzir(e); }
    },
    /** Concede (acoes não vazias) ou revoga (acoes vazias) o acesso de UMA pessoa a UMA unidade. Sem autoconcessão. */
    async conceder({ organizacaoId, unidadeId, perfilId, acoes, atorContaId, atorPerfilId, justificativa }) {
      if (!Array.isArray(acoes) || acoes.some((a) => !CATALOGO.has(a))) falhar(CODIGO.ENTRADA_INVALIDA, "Ação fora do catálogo financeiro.", { motivo: "ACAO_INVALIDA" });
      try {
        const r = await poolAutoridade.query("select fv2_conceder_por_administrador($1, $2, $3, $4::jsonb, $5, $6, $7) as v", [
          exigirUuidMin(organizacaoId, "organizacaoId"), exigirUuidMin(unidadeId, "unidadeId"), exigirUuidMin(perfilId, "perfilId"), JSON.stringify([...new Set(acoes)]),
          exigirUuidMin(atorContaId, "atorContaId"), exigirUuidMin(atorPerfilId, "atorPerfilId"), exigirJustificativa(justificativa)]);
        return { versao: r.rows[0].v };
      } catch (e) { return traduzir(e); }
    },
  });
}
