// Cenário SINTÉTICO para os testes do Financeiro v2. Nenhum identificador, nome ou valor aqui é real.
//
// O mesmo conjunto de testes roda em dois adaptadores de persistência:
//   padrão                      → memória (rápido, sem dependência externa);
//   FV2_REPOSITORIO=postgres    → PostgreSQL local isolado (helpers/postgres.js); cada montar() ganha um banco novo.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { ACAO, ErroFinanceiro, criarCofreMemoria, criarNucleoFinanceiro, criarRegistroDeAcessosNegadosMemoria, criarRepositorioMemoria } from "../../../src/modules/financeiro-v2/index.js";
import { EM_POSTGRES, repositorioPostgresDeTeste } from "./postgres.js";

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

export const ESCOPOS_PADRAO = Object.freeze([{ organizacaoId: ORG_A, unidadeId: UNI_A }, { organizacaoId: ORG_A, unidadeId: UNI_A2 }, { organizacaoId: ORG_B, unidadeId: UNI_B }]);

/**
 * Monta um núcleo sobre o adaptador da rodada.
 * `plano`: modelo de plano de contas implantado automaticamente em cada escopo no primeiro uso ("ACAITERIA" por padrão).
 *          Passe `false` para testar o comportamento SEM plano de contas.
 */
export function montar({
  escopos = ESCOPOS_PADRAO, repositorio, plano = "ACAITERIA", relogio = () => AGORA,
  cofre = criarCofreMemoria(), acessosNegados = criarRegistroDeAcessosNegadosMemoria(), estabelecimentosDaUnidade = null,
  concessoesDeTeste = true,
} = {}) {
  const repo = repositorio ?? (EM_POSTGRES ? repositorioPostgresDeTeste(escopos, { concessoesDeTeste }) : criarRepositorioMemoria());
  // 08C: com FV2_CONFERIR_CARGA=1, TODA consulta otimizada (Vendas, Recebimentos, Central, Pendências, Fechamento e a guarda
  // de homologação) também calcula com a carga completa e falha se o resultado diferir — a suíte inteira vira prova de equivalência.
  const real = criarNucleoFinanceiro({ repositorio: repo, escoposAutorizados: escopos, relogio, cofre, acessosNegados, estabelecimentosDaUnidade, conferirCargaDirigida: process.env.FV2_CONFERIR_CARGA === "1" });
  if (!plano) return { nucleo: real, repositorio: repo, cofre, acessosNegados };
  const implantados = new Map();
  const garantirPlano = (c) => {
    const chave = `${c?.organizacaoId}|${c?.unidadeId}`.toLowerCase();
    if (!escopos.some((e) => `${e.organizacaoId}|${e.unidadeId}`.toLowerCase() === chave)) return Promise.resolve();
    if (!implantados.has(chave)) implantados.set(chave, real.implantarPlanoDeContas(ctx(c.organizacaoId, c.unidadeId), { modelo: plano }));
    return implantados.get(chave);
  };
  // Preparação de cenário (não é regra do núcleo): todo escopo de teste nasce com o plano de contas implantado.
  const nucleo = Object.freeze(Object.fromEntries(Object.entries(real).map(([nome, op]) => [nome, async (c, ...resto) => {
    if (nome !== "provisionarAdministradorInicial") await garantirPlano(c);
    return op(c, ...resto);
  }])));
  return { nucleo, repositorio: repo, cofre, acessosNegados };
}

/** Autoridade de provisionamento SINTÉTICA (07B): atesta com HMAC de uma chave do teste e declara MFA (aal2). */
export const ATESTANTE = "eeeeeeee-0000-4000-8000-000000000001";
export function autoridadeSintetica({ nivelAutenticacao = "aal2", autoridadeId = ATESTANTE } = {}) {
  const chave = randomBytes(32);
  const assinar = (ato) => createHmac("sha256", chave).update(JSON.stringify([ato.organizacaoId, ato.unidadeId, ato.usuarioId, [...ato.acoes].sort()])).digest("hex");
  return { assinar, verificar: async (ato) => ({ ok: ato.atestado === assinar(ato), autoridadeId, nivelAutenticacao }) };
}

/**
 * Provisiona o ADMINISTRADOR INICIAL pelo caminho real (autoridade atestando), para os testes de concessão: quem concede
 * precisa ter a concessão GRAVADA (07B). Funciona nos dois adaptadores.
 */
export async function provisionarAdministrador(repositorio, { organizacaoId = ORG_A, unidadeId = UNI_A, usuarioId = USUARIO, acoes = TODAS, escopos = ESCOPOS_PADRAO, nivelAutenticacao = "aal2" } = {}) {
  const autoridade = autoridadeSintetica({ nivelAutenticacao });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: escopos, relogio: () => AGORA, autoridadeDeProvisionamento: autoridade });
  const ato = { organizacaoId, unidadeId, usuarioId, acoes, justificativa: "Administrador inicial sintético.", evidencia: "Ato sintético de teste" };
  return n.provisionarAdministradorInicial({ ...ato, atestado: autoridade.assinar(ato) });
}

/** Núcleo com conta bancária, caixa físico e um fornecedor no escopo A. */
export async function montarComCadastros(opcoes) {
  const m = montar(opcoes);
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

/**
 * 08E (F-1) — leva a competência até a homologação PELO CAMINHO CERTO: preliminar; documenta cada pendência que exige
 * documentação (decisão + o que falta — dados SINTÉTICOS de teste); e, se houver ressalva, passa por "com pendências
 * documentadas". Não resolve nem esconde nada: pendência bloqueante continua bloqueando a homologação.
 */
export async function prepararHomologacao(n, c, competencia) {
  const atual = await n.consultarCompetencia(c, { competencia });
  if (atual.estado === "FECHAMENTO_HOMOLOGADO") return null;
  if (atual.estado === "ABERTA") await n.alterarEstadoDaCompetencia(c, { competencia, novoEstado: "FECHAMENTO_PRELIMINAR" });
  const f = await n.consultarFechamento(c, { competencia });
  for (const p of [...f.avaliacaoDasPendencias.naoDocumentadas, ...f.avaliacaoDasPendencias.semEvidencia]) {
    await n.documentarPendenciaDoFechamento(c, { competencia, pendencia: { chave: p.chave, descricao: p.titulo ?? "Pendência", impacto: "Ressalva do cenário sintético.", decisao: "Admitida como ressalva no cenário sintético.", documentacaoFaltante: "Documento do cenário sintético não fornecido." } });
  }
  const f2 = await n.consultarFechamento(c, { competencia });
  // 08E: só passa por "com pendências documentadas" quando o que resta são ressalvas admissíveis; com bloqueante, fica
  // no preliminar (a homologação seguinte é que falha, como o teste espera).
  if (f2.avaliacaoDasPendencias.podeRegistrarComPendencias && f2.estado !== "FECHAMENTO_COM_PENDENCIAS") {
    await n.alterarEstadoDaCompetencia(c, { competencia, novoEstado: "FECHAMENTO_COM_PENDENCIAS" });
  }
  return n.consultarFechamento(c, { competencia });
}
export const homologarComRessalvas = async (n, c, competencia, extra = {}) => {
  await prepararHomologacao(n, c, competencia);
  return n.alterarEstadoDaCompetencia(c, { competencia, novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Conferência sintética.", confirmar: true, ...extra });
};

export async function rejeita(promessaOuFn, codigo) {
  await assert.rejects(typeof promessaOuFn === "function" ? promessaOuFn : () => promessaOuFn, (e) => {
    assert.ok(e instanceof ErroFinanceiro, `esperava ErroFinanceiro, veio ${e?.name}: ${e?.message}`);
    assert.equal(e.codigo, codigo, `${e.codigo}: ${e.message}`);
    return true;
  });
}

export const sha = (semente) => String(semente).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, "0");

/** Soma dos lançamentos por registro: prova de que nenhum componente entra duas vezes numa composição. */
export const semRepeticao = (composicao) => new Set(composicao.itens.map((i) => i.registroId)).size === composicao.itens.length;
