// Cenário SINTÉTICO para os testes do Financeiro v2. Nenhum identificador, nome ou valor aqui é real.
import assert from "node:assert/strict";
import { ACAO, ErroFinanceiro, criarNucleoFinanceiro, criarRepositorioMemoria } from "../../../src/modules/financeiro-v2/index.js";

export const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
export const UNI_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
export const UNI_A2 = "aaaaaaaa-0000-4000-8000-0000000000a2";
export const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
export const UNI_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
export const USUARIO = "cccccccc-0000-4000-8000-000000000001";
export const OUTRO_USUARIO = "cccccccc-0000-4000-8000-000000000002";

export const TODAS = Object.values(ACAO);
export const ctx = (organizacaoId = ORG_A, unidadeId = UNI_A, permissoes = TODAS, usuarioId = USUARIO) => ({ organizacaoId, unidadeId, usuarioId, permissoes });

/** Relógio fixo: 15/10/2026 12:00 em Brasília. */
export const AGORA = new Date("2026-10-15T15:00:00.000Z");

export function montar({ escopos = [{ organizacaoId: ORG_A, unidadeId: UNI_A }, { organizacaoId: ORG_A, unidadeId: UNI_A2 }, { organizacaoId: ORG_B, unidadeId: UNI_B }], repositorio = criarRepositorioMemoria() } = {}) {
  const nucleo = criarNucleoFinanceiro({ repositorio, escoposAutorizados: escopos, relogio: () => AGORA });
  return { nucleo, repositorio };
}

/** Núcleo com conta bancária, caixa físico e um fornecedor no escopo A. */
export async function montarComCadastros() {
  const m = montar();
  const c = ctx();
  const banco = await m.nucleo.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco Sintético", instituicao: "Banco Teste" });
  const caixa = await m.nucleo.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa da loja" });
  const fornecedor = await m.nucleo.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Fornecedor Sintético" });
  return { ...m, c, banco, caixa, fornecedor };
}

export const obrigacao = (fornecedorId, extra = {}) => ({
  contraparteId: fornecedorId, valorOriginalCentavos: 100000, categoria: "INSUMOS", descricao: "Compra sintética",
  competencia: "2026-09", dataEmissao: "2026-09-05", vencimento: "2026-09-20", ...extra,
});

export const saida = (contaId, valorCentavos, extra = {}) => ({ contaId, dataEfetiva: "2026-09-20", sentido: "SAIDA", valorCentavos, natureza: "PAGAMENTO", ...extra });
export const entrada = (contaId, valorCentavos, extra = {}) => ({ contaId, dataEfetiva: "2026-09-22", sentido: "ENTRADA", valorCentavos, natureza: "RECEBIMENTO", ...extra });

export async function rejeita(promessaOuFn, codigo) {
  await assert.rejects(typeof promessaOuFn === "function" ? promessaOuFn : () => promessaOuFn, (e) => {
    assert.ok(e instanceof ErroFinanceiro, `esperava ErroFinanceiro, veio ${e?.name}: ${e?.message}`);
    assert.equal(e.codigo, codigo);
    return true;
  });
}

export const sha = (semente) => String(semente).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, "0");
