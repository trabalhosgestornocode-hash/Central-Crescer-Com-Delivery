// Para QUAL conexão da unidade uma autorização OAuth (ou um vínculo) vale — decidido no backend, nunca pelo navegador.
//
//   * Unidade SEM separação (fora de IFOOD_FINANCIAL_HOMOLOGATION_UNITS): comportamento de sempre — uma conexão `legado` que serve a todos
//     os apps. A conexão nova nasce `legado` (idêntico ao anterior à migration 124).
//   * Unidade COM separação (na allowlist do Financial de homologação, ex.: Subway North Shopping): Financial de homologação e Order de
//     produção são conexões INDEPENDENTES. A conexão `legado` existente tem de ser rotulada (operacoes/ifood-conexao-rotular.sql) ANTES de
//     receber o primeiro app Order — senão o Order cairia na conexão de teste.
//
// Sem seleção ambígua: ver escolherConexao (finalidade exata, ou a única legada, ou erro).

import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import { IFOOD_APP_ORDER } from "./ifood.constants.js";
import { FINALIDADES, escolherConexao, finalidadeDaLinha, finalidadeDoApp } from "./ifoodFinalidade.js";
import { unidadeEmHomologacaoFinancial } from "./ifoodFinancialHomologacao.js";

/**
 * @param {{appType: string, vivas: object[], separa: boolean, temCredencialOrder?: (conexaoId: string) => Promise<boolean>}} p
 * @returns {Promise<{acao: 'usar', conexao: object} | {acao: 'criar', finalidade: string}>}
 */
export async function decidirDestinoOAuth({ appType, vivas, separa, temCredencialOrder = async () => false }) {
  const finalidade = finalidadeDoApp(appType);
  const destino = escolherConexao(vivas, finalidade);
  if (destino) {
    // Order numa conexão `legado` de unidade com separação, que ainda NÃO tem credencial Order: seria a conexão de teste. Reautorizar um
    // Order que já existe (ex.: a Saci, se um dia entrar na lista) segue normal.
    if (appType === IFOOD_APP_ORDER && separa && finalidadeDaLinha(destino) === FINALIDADES.LEGADO
        && !(await temCredencialOrder(destino.id))) {
      throw ifoodErro(IFOOD_ERROS.IFOOD_CONEXAO_LEGADA_ROTULAR);
    }
    return { acao: "usar", conexao: destino };
  }
  const vivasReais = (vivas ?? []).filter((c) => c && c.status !== "revogada");
  if (vivasReais.length === 0) return { acao: "criar", finalidade: separa ? finalidade : FINALIDADES.LEGADO };
  // Há conexão(ões) viva(s) e nenhuma serve a este app.
  if (vivasReais.some((c) => finalidadeDaLinha(c) === FINALIDADES.LEGADO)) throw ifoodErro(IFOOD_ERROS.IFOOD_CONEXAO_LEGADA_ROTULAR);
  if (separa) return { acao: "criar", finalidade };
  throw ifoodErro(IFOOD_ERROS.IFOOD_FINALIDADE_NAO_SUPORTADA);
}

// Conexões vivas da unidade. Repositório sem a listagem: usa a seleção por finalidade (repositórios de teste).
async function conexoesVivas({ repo, organizacaoId, unidadeId, appType }) {
  if (typeof repo.listarConexoesVivas === "function") return repo.listarConexoesVivas({ organizacaoId, unidadeId });
  const c = await repo.obterConexaoViva({ organizacaoId, unidadeId, finalidade: finalidadeDoApp(appType) });
  return c ? [c] : [];
}

/**
 * Destino do OAuth de uma unidade: a conexão da FINALIDADE do app, ou a criar. A unidade "separa" as conexões quando tem loja de teste no
 * Financial de homologação (IFOOD_FINANCIAL_HOMOLOGATION_UNITS): é a ÚNICA ponte entre essa lista e o OAuth, e ela só decide a qual conexão o
 * app Order se liga — nunca qual credencial/app é usado (isso continua no token service).
 * Falha (sem tocar no iFood) se for ambíguo ou exigir rotulagem.
 */
export async function destinoDoOAuth({ repo, organizacaoId, unidadeId, appType }) {
  const vivas = await conexoesVivas({ repo, organizacaoId, unidadeId, appType });
  return decidirDestinoOAuth({
    appType, vivas, separa: unidadeEmHomologacaoFinancial(unidadeId),
    temCredencialOrder: async (conexaoId) => !!(await repo.obterCredencial({ conexaoId, appType: IFOOD_APP_ORDER })),
  });
}
