// MOVA CORE — F5: CORPO INICIAL de conhecimento do sistema Crescer com Delivery, extraído da documentação versionada do repositório.
// Tudo entra PENDENTE (sugerido por "repositorio:docs"): o funcionamento pode ser explicado como "documentação em revisão";
// regras, políticas e decisões só valem depois da aprovação de uma pessoa responsável (scripts/mova-core/conhecimento.mjs).
// Nada aqui é valor financeiro dinâmico: saldos, contas, vendas e pendências vêm das ferramentas oficiais.
import { readFileSync } from "node:fs";

// o corpo é DADO versionado (não código): dados/conhecimento-do-sistema.json
const CORPO = JSON.parse(readFileSync(new URL("./dados/conhecimento-do-sistema.json", import.meta.url), "utf8"));
export const VERSAO_DO_CORPO = CORPO.versao;
export const CONHECIMENTO_DO_SISTEMA = Object.freeze(CORPO.itens.map((x) => Object.freeze(x)));

/** Carrega o corpo como PENDENTE (idempotente pela chave: só cria versão nova se o conteúdo mudou). */
export async function carregarConhecimentoDoSistema(servico, { por = "repositorio:docs", responsavel = "Proprietário (a definir na aprovação)" } = {}) {
  const atuais = await servico.listar({});
  const criados = [];
  for (const x of CONHECIMENTO_DO_SISTEMA) {
    const mesma = atuais.filter((y) => y.chave === x.chave && y.organizacaoId == null).sort((a, b) => b.versao - a.versao)[0];
    if (mesma && mesma.conteudo === x.conteudo && mesma.titulo === x.titulo) continue;
    criados.push(await servico.sugerir({ ...x, organizacaoId: null, unidadeId: null, responsavel, sugeridoPor: por }));
  }
  return { criados: criados.length, total: CONHECIMENTO_DO_SISTEMA.length };
}
