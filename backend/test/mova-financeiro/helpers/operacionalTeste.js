import { criarConcessoesMemoria, criarNucleoFinanceiro } from "../../../src/modules/financeiro-v2/index.js";
import { criarOperacionalMova } from "../../../src/modules/fv2-integracao/operacionalMova.js";
export const ESCOPO = { organizacaoId: "dddddddd-0000-4000-8000-0000000000a2", unidadeId: "dddddddd-0000-4000-8000-0000000a2a01" };
export const ACAO_AMPLA_TESTE = "financeiro_v2.registrar";
/** Provedor com repositório falso mínimo e concessões em memória (sintéticas). */
export function montarProvedor({ acoes }) {
  const IDENT = "eeeeeeee-0000-4000-8000-0000000000c3";
  const rodadas = { n: 0 };
  const memoria = criarConcessoesMemoria([{ ...ESCOPO, usuarioId: IDENT, acoes }]);
  const provedor = criarOperacionalMova({
    repositorio: { leitura: async () => null, escrita: async () => null },
    rodar: async (fn) => { rodadas.n++; return fn(); },
    criarNucleoFinanceiro: () => ({ consultarContasAPagar: async () => ({ itens: [] }) }),
    criarConcessoesDoRepositorio: () => memoria,
  });
  return { provedor, rodadas, IDENT };
}
