// MOVA CORE — 25/11: execução AUTOMÁTICA (política APLICAR_AUTOMATICO) da prestação de sangria e o recorte "um motor por operação".
// Núcleo REAL do Financeiro v2 (memória), modelo roteirizado. Dados SINTÉTICOS. Prova: com política automática, pessoa autorizada,
// proposta completa e sem aviso de risco, executa SEM "sim", com auditoria e texto do SERVIDOR; fornecedor novo, sem autorização,
// política de confirmação ou acima do limite ⇒ continua pedindo o "sim"; compra já paga não é preparada pela conversa (vai ao
// fluxo de documentos, que já executa); a prestação nunca é feita duas vezes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarMovaCore, criarOrcamentoMemoria, LIMITES_HOMOLOGACAO } from "../../src/modules/mova-core/index.js";
import { criarServicoDeOperacoes, ferramentasDeOperacao, TIPO_OPERACAO } from "../../src/modules/mova-core/operacoes.js";
import { executorDaPessoa } from "../../src/modules/mova-financeiro/aplicacao/portaOperacional.js";
import { TIPOS_DA_CONVERSA } from "../../src/modules/fv2-integracao/movaCoreConversa.js";
import { AGORA, ORG_A, UNI_A, montarComCadastros } from "../financeiro-v2/helpers/cenario.js";
import { clienteRoteirizado, usar, falar, PERFIL_FIN } from "./helpers.js";

const HOJE = "2026-10-15"; const DIA = "2026-10-14";
const politica = (nivel, limiteCentavos = 5000) => [{ id: "pol-sg", operacao: "PRESTACAO_DE_SANGRIA", organizacaoId: ORG_A, unidadeId: UNI_A, nivel, limiteCentavos, responsavel: "dono", motivo: "teste sintético de autonomia", vigenteDe: "2026-01-01", vigenteAte: null, revogadaEm: null }];
const refDaLeitura = (req) => { const m = /\\"ref\\":\\"([^\\"]+)\\"/.exec(JSON.stringify(req.messages.at(-1).content)); assert.ok(m, "a leitura devolveu a referência"); return m[1]; };

async function montar({ politicas, autorizado = true, fornecedor = "Doce Brownie Ltda", fala = "Pronto, a confirmação segue abaixo." }) {
  const m = await montarComCadastros(); const n = m.nucleo; const c = m.c;
  const doce = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Doce Brownie Ltda" });
  // fornecedor CONHECIDO = já tem conta no Financeiro (regra da resolução por leitura oficial)
  await n.registrarObrigacao(c, { contraparteId: doce.id, valorOriginalCentavos: 8100, categoria: "INSUMOS", descricao: "Brownies 2ª quinzena", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-20" });
  const leitura = { permissoesDoUsuario: async () => ["financeiro_v2.ver"], ler: (op, e, x) => n[op]({ ...c, unidadeId: e.unidadeId }, x) };
  const auditoria = [];
  const operacoes = criarServicoDeOperacoes({ porta: leitura, portaOperacional: executorDaPessoa({ nucleo: n, ctx: c }), politicas: async (org) => (org === ORG_A ? politicas : []),
    relogio: () => AGORA.getTime(), tipos: TIPOS_DA_CONVERSA, auditoria: { registrar: (x) => auditoria.push(x) } });
  const { sessao } = await n.abrirCaixa(c, { contaId: m.caixa.id, dataAbertura: DIA, saldoContadoCentavos: 10000 });
  await n.registrarOperacaoDeCaixa(c, { sessaoId: sessao.id, operacao: "SANGRIA", valorCentavos: 1500, data: DIA, descricao: "Comprar grampos" });
  const args = { tipo: "PRESTACAO_DE_SANGRIA", despesas: [{ valorCentavos: 1200, descricao: "Grampos", fornecedor, categoria: "Insumos" }], trocoCentavos: 300 };
  const roteiro = () => clienteRoteirizado([[usar("prestacao_de_sangrias", { somentePendentes: true })], (req) => [usar("preparar_operacao", { ...args, sangria: refDaLeitura(req) })], [falar(fala)]]);
  const turno = (core, texto) => core.responder({ organizacaoId: ORG_A, conversaId: "conv-a", participanteId: "p-a", usuarioId: "pessoa-1", unidadeId: UNI_A, unidadesPermitidas: [{ id: UNI_A, nome: "Alfa Centro" }],
    perfil: PERFIL_FIN, podeValores: true, texto, hoje: HOJE, autorizacaoDeEscrita: { pode: autorizado } });
  const novoCore = (cliente) => criarMovaCore({ porta: leitura, cliente, orcamento: criarOrcamentoMemoria(LIMITES_HOMOLOGACAO), operacoes, relogio: () => AGORA.getTime() });
  const sangria = async () => (await n.consultarPrestacaoDeSangrias(c)).itens[0];
  return { n, c, operacoes, auditoria, roteiro, turno, novoCore, sangria };
}

test("AUT-01 SANGRIA DOS GRAMPOS com política AUTOMÁTICA: executa sem 'sim'; despesa + troco; PRESTADA; auditado; texto do SERVIDOR", async () => {
  const t = await montar({ politicas: politica("APLICAR_AUTOMATICO") });
  const r = await t.turno(t.novoCore(t.roteiro()), "dos 15 da sangria dos grampos, gastei 12 e voltaram 3 de troco");
  assert.equal(r.motivo, "OPERACAO_AUTOMATICA", JSON.stringify(t.auditoria.slice(-2)));
  const textos = [r.texto, ...(r.blocos ?? [])].join("\n");
  assert.match(textos, /totalmente prestada/, "o que foi feito, escrito pelo servidor a partir da transação");
  const s = await t.sangria();
  assert.deepEqual([s.estado, s.pendenteCentavos, s.trocoDevolvidoCentavos, s.despesasCentavos], ["PRESTADA", 0, 300, 1200]);
  assert.ok(t.auditoria.some((a) => JSON.stringify(a).includes("EXECUCAO_AUTOMATICA")), "execução automática auditada");
  // duplicidade: a mesma mensagem de novo não presta duas vezes
  const r2 = await t.turno(t.novoCore(t.roteiro()), "dos 15 da sangria dos grampos, gastei 12 e voltaram 3 de troco");
  assert.notEqual(r2.motivo, "OPERACAO_AUTOMATICA");
  assert.equal((await t.sangria()).despesasCentavos, 1200, "nenhuma segunda despesa");
});

for (const [nome, cfg, motivo] of [
  ["fornecedor NOVO", { politicas: politica("APLICAR_AUTOMATICO"), fornecedor: "Papelaria Inédita" }, "FORNECEDOR_NOVO"],
  ["pessoa SEM autorização de escrita", { politicas: politica("APLICAR_AUTOMATICO"), autorizado: false }, "SEM_AUTORIZACAO_DE_ESCRITA"],
  ["política de CONFIRMAÇÃO", { politicas: politica("APLICAR_COM_CONFIRMACAO") }, null],
  ["acima do LIMITE da política", { politicas: politica("APLICAR_AUTOMATICO", 1000) }, null],
]) {
  test(`AUT-02 ${nome}: NÃO executa sozinho — fica aguardando o "sim" e nada entra no Financeiro`, async () => {
    const t = await montar({ ...cfg, fala: "Preparei. Confirma?" });
    const r = await t.turno(t.novoCore(t.roteiro()), "dos 15 da sangria dos grampos, gastei 12 e voltaram 3 de troco");
    assert.notEqual(r.motivo, "OPERACAO_AUTOMATICA");
    assert.equal((await t.sangria()).estado === "PRESTADA", false, "nada executado");
    if (motivo) assert.ok(t.auditoria.some((a) => JSON.stringify(a).includes(motivo)), `motivo auditado: ${motivo}`);
  });
}

test("AUT-03 um motor por operação: a conversa só prepara SANGRIA; compra já paga vai ao fluxo de documentos (recusa sem gravar)", async () => {
  const t = await montar({ politicas: politica("APLICAR_AUTOMATICO") });
  assert.deepEqual([...t.operacoes.tipos], [TIPO_OPERACAO.PRESTACAO_DE_SANGRIA]);
  const [ferramenta] = ferramentasDeOperacao(t.operacoes.tipos);
  assert.deepEqual(ferramenta.esquema.properties.tipo.enum, ["PRESTACAO_DE_SANGRIA"]);
  assert.match(ferramenta.descricao, /COMPROVANTE/);
  const r = await t.operacoes.preparar({ conversaChave: "k", sessao: { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "pessoa-1" }, autor: "p-a", tipo: "COMPRA_JA_PAGA", args: { valorCentavos: 25900 } });
  assert.deepEqual(r, { ok: false, motivo: "COMPRA_PELO_FLUXO_DE_DOCUMENTOS" });
});
