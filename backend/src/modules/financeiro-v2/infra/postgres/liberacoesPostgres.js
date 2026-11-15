// Liberação por empresa/unidade no PostgreSQL (migração 0021). Leitura com o pool da APLICAÇÃO (função
// fv2_liberacao_estado, sem dado financeiro); escrita SÓ com o pool da AUTORIDADE (gateway), por fv2_liberacao_alterar.
// Quem cria os pools é a infraestrutura (com as duas barreiras de destino seguro); este arquivo não conecta em nada.
import { validarAtoDeLiberacao } from "../../integracao/liberacoes.js";

/** @param {{poolApp:{query:Function}}} p */
export function criarLiberacoesPostgres({ poolApp }) {
  if (typeof poolApp?.query !== "function") throw new Error("Liberações: pool da aplicação ausente.");
  return Object.freeze({
    async consultar({ organizacaoId, unidadeId }) {
      const r = await poolApp.query("select empresa, unidade, escrita from fv2_liberacao_estado($1, $2)", [organizacaoId, unidadeId]);
      return { empresa: r.rows[0]?.empresa === true, unidade: r.rows[0]?.unidade === true, escrita: r.rows[0]?.escrita === true };
    },
  });
}

/**
 * Alteração pela AUTORIDADE (gateway) depois de verificar identidade e segundo fator do ator.
 * @param {{query:Function}} poolAutoridade
 */
export async function alterarLiberacaoPostgres(poolAutoridade, ato) {
  const a = validarAtoDeLiberacao(ato);
  const r = await poolAutoridade.query("select fv2_liberacao_alterar($1, $2, $3, $4, $5, $6) as versao",
    [a.organizacaoId, a.unidadeId, a.ativa, a.ator, a.justificativa, new Date(a.segundoFatorEm).toISOString()]);
  return { versao: r.rows[0].versao };
}
