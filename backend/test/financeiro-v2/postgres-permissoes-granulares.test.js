// Execução 08B — AÇÕES GRANULARES (migração 0013) no caminho real: núcleo + adaptador + PostgreSQL isolado, sem
// concessões-fixture. Um núcleo "ingênuo" (que não confere a concessão gravada e recebe contexto alegando TUDO) prova que
// o BANCO recusa sozinho. Dados e identidades sintéticos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, ctx, montar, provisionarAdministrador, rejeita } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, saiposVendas } from "./helpers/arquivos.js";
import { abrirPool, motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const pular = { skip: motivoParaPular(), timeout: 300000 };
// Recusa do BANCO: erro de integridade (gatilho/WITH CHECK) ou acesso negado (UPDATE barrado pelo RLS, detectado pelo adaptador).
const recusadoPeloBanco = (p) => assert.rejects(p, (e) => [CODIGO.PERMISSAO_INSUFICIENTE, CODIGO.INTEGRIDADE_VIOLADA].includes(e.codigo));
const U = (n) => `dddddddd-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`;
const PERFIS = {
  aprovador: [ACAO.VER, ACAO.APROVAR], aplicador: [ACAO.VER, ACAO.APLICAR, ACAO.REGISTRAR], revogador: [ACAO.VER, ACAO.REVOGAR],
  importador: [ACAO.VER, ACAO.IMPORTAR], conciliador: [ACAO.VER, ACAO.CONCILIAR], leitor: [ACAO.VER],
  legado: [ACAO.VER, ACAO.REVISAR, ACAO.IMPORTAR, ACAO.REGISTRAR], // concessão "antiga": nada das ações novas
};

async function cenario() {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, exigirConcessaoPersistida: true });
  const ingenuo = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA }); // não confere concessão gravada
  const adm = ctx(ORG_A, UNI_A, TODAS);
  const ids = {};
  let i = 0;
  for (const [perfil, acoes] of Object.entries(PERFIS)) {
    ids[perfil] = U((i += 1));
    await n.concederAcesso(adm, { usuarioId: ids[perfil], acoes, justificativa: `Perfil ${perfil} (sintético).` });
  }
  const caixa = await m.nucleo.configurarContaFinanceira(adm, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const r = await m.nucleo.receberArquivoParaImportacao(adm, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", ...PERIODO_SETEMBRO, conteudo: saiposVendas([{ pedido: "G-1", data: "05/09/2026 12:00", itens: 2000, forma: "Dinheiro" }, { pedido: "G-2", data: "06/09/2026 12:00", itens: 3000, forma: "Dinheiro" }]) });
  const conf = await m.nucleo.confirmarImportacao(adm, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia });
  await m.nucleo.gerarPropostas(adm, { importacaoId: conf.importacao.id, contaCaixaId: caixa.id });
  const propostas = (await m.nucleo.consultarRegistros(adm, { tipo: "PROPOSTA" })).filter((p) => p.importacaoId === conf.importacao.id);
  const como = (perfil, acoes = TODAS) => ctx(ORG_A, UNI_A, acoes, ids[perfil]); // contexto que ALEGA as ações
  return { repositorio, m, n, ingenuo, adm, ids, propostas, como, caixa };
}

test("08B — aprovar ≠ aplicar; aplicar só com aprovação; concessão antiga não ganha ações novas (núcleo E banco)", pular, async () => {
  const { n, ingenuo, propostas, como } = await cenario();
  const [p1, p2] = propostas;
  // Núcleo com concessão gravada.
  await rejeita(n.aplicarProposta(como("aplicador", PERFIS.aplicador), { propostaId: p1.id }), CODIGO.TRANSICAO_INVALIDA); // sem aprovação
  await rejeita(n.aplicarProposta(como("aprovador", PERFIS.aprovador), { propostaId: p1.id }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(n.aprovarProposta(como("aplicador", PERFIS.aplicador), { propostaId: p1.id }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(n.aprovarProposta(como("legado", PERFIS.legado), { propostaId: p1.id }), CODIGO.PERMISSAO_INSUFICIENTE); // revisar não aprova mais
  await n.aprovarProposta(como("aprovador", PERFIS.aprovador), { propostaId: p1.id, justificativa: "Conferido (sintético)." });
  // Banco: núcleo ingênuo, contexto alegando TUDO — aprovador tentando aplicar e legado tentando aprovar.
  await assert.rejects(ingenuo.aplicarProposta(como("aprovador"), { propostaId: p1.id }), (e) => [CODIGO.PERMISSAO_INSUFICIENTE, CODIGO.INTEGRIDADE_VIOLADA].includes(e.codigo));
  await assert.rejects(ingenuo.aprovarProposta(como("legado"), { propostaId: p2.id }), (e) => [CODIGO.PERMISSAO_INSUFICIENTE, CODIGO.INTEGRIDADE_VIOLADA].includes(e.codigo));
  // Aplicador autorizado aplica a aprovada; repetir não duplica.
  await n.aplicarProposta(como("aplicador", PERFIS.aplicador), { propostaId: p1.id });
  const vendas = async () => (await n.consultarRegistros(como("leitor", PERFIS.leitor), { tipo: "VENDA" })).length;
  const antes = await vendas();
  await n.aplicarProposta(como("aplicador", PERFIS.aplicador), { propostaId: p1.id }).catch(() => null);
  assert.equal(await vendas(), antes);
});

test("08B — revogar ≠ conceder; importar não confirma nem homologa; conciliar não reabre; leitura não altera", pular, async () => {
  const { repositorio, n, ingenuo, ids, como, adm } = await cenario();
  // Revogador revoga, mas não concede (núcleo e banco).
  await n.revogarAcesso(como("revogador", PERFIS.revogador), { usuarioId: ids.leitor, justificativa: "Fim do acesso (sintético)." });
  await rejeita(n.concederAcesso(como("revogador", PERFIS.revogador), { usuarioId: ids.leitor, acoes: [ACAO.VER], justificativa: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(ingenuo.concederAcesso(como("revogador"), { usuarioId: ids.leitor, acoes: [ACAO.VER], justificativa: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
  // Quem só concede não revoga (administrador limitado).
  await n.concederAcesso(adm, { usuarioId: U(90), acoes: [ACAO.VER, ACAO.CONCEDER], justificativa: "Concedente limitado." });
  await rejeita(ingenuo.revogarAcesso(ctx(ORG_A, UNI_A, TODAS, U(90)), { usuarioId: ids.conciliador, justificativa: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
  // Importar não confirma nem homologa; conciliar não reabre.
  await n.alterarEstadoDaCompetencia(adm, { competencia: "2026-08", novoEstado: "FECHAMENTO_PRELIMINAR" });
  await recusadoPeloBanco(ingenuo.alterarEstadoDaCompetencia(como("importador"), { competencia: "2026-08", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "x", confirmar: true }));
  await n.alterarEstadoDaCompetencia(adm, { competencia: "2026-08", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Sintética.", confirmar: true });
  await recusadoPeloBanco(ingenuo.alterarEstadoDaCompetencia(como("conciliador"), { competencia: "2026-08", novoEstado: "ABERTA", justificativa: "x", confirmar: true }));
  await rejeita(n.alterarEstadoDaCompetencia(adm, { competencia: "2026-08", novoEstado: "ABERTA", confirmar: true }), CODIGO.TRANSICAO_INVALIDA); // sem justificativa
  // UPDATE barrado em silêncio pelo RLS NUNCA é sucesso: leitor tentando renomear conta → acesso negado.
  const [conta] = await n.consultarRegistros(adm, { tipo: "CONTA" });
  await n.concederAcesso(adm, { usuarioId: U(91), acoes: [ACAO.VER], justificativa: "Somente leitura (sintético)." });
  // Só leitura: a reserva da linha já não a alcança (recusa segura: "não encontrado" ou acesso negado — nunca sucesso).
  await assert.rejects(ingenuo.alterarContaFinanceira(ctx(ORG_A, UNI_A, TODAS, U(91)), { contaId: conta.id, nome: "Renomeada indevidamente", justificativa: "x" }), (e) => [CODIGO.NAO_ENCONTRADO, CODIGO.PERMISSAO_INSUFICIENTE].includes(e.codigo));
  // Gravação direta pelo adaptador (sem a reserva prévia): o RLS barra o UPDATE em silêncio; o adaptador vê a linha
  // intacta na versão esperada e devolve ACESSO NEGADO — nunca "sucesso" nem conflito a repetir.
  const { repo } = await repositorio.interno();
  await rejeita(repo.transacao((tx) => tx.atualizar("CONTA", { ...conta, nome: "Direto", versao: conta.versao + 1 }, conta.versao), { escopo: { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: U(91) } }), CODIGO.PERMISSAO_INSUFICIENTE);
  // Quem tem ALGUMA escrita mas não `configurar`: o banco recusa com erro explícito.
  await recusadoPeloBanco(ingenuo.alterarContaFinanceira(como("conciliador"), { contaId: conta.id, nome: "Renomeada indevidamente", justificativa: "x" }));
  assert.equal((await n.consultarRegistros(adm, { tipo: "CONTA" }))[0].nome, conta.nome);
});

test("08B — revogação concorrente com aplicação: nada é aplicado DEPOIS de a revogação ser gravada", pular, async () => {
  const { repositorio, n, ids, propostas, como, adm } = await cenario();
  const { urlAdmin } = await repositorio.interno();
  const dono = await abrirPool(urlAdmin, { max: 1 });
  for (const p of propostas) await n.aprovarProposta(como("aprovador", PERFIS.aprovador), { propostaId: p.id });
  for (const [i, p] of propostas.entries()) {
    if (i > 0) await n.concederAcesso(adm, { usuarioId: ids.aplicador, acoes: [ACAO.APLICAR], justificativa: `Volta a aplicar ${i}.` });
    await Promise.allSettled([
      n.aplicarProposta(como("aplicador", PERFIS.aplicador), { propostaId: p.id }),
      n.revogarAcesso(adm, { usuarioId: ids.aplicador, acoes: [ACAO.APLICAR], justificativa: `Retira aplicar ${i}.` }),
    ]);
    const { rows } = await dono.query(`select seq, registro_tipo, evento, depois->>'estado' as estado, depois->'acoes' as acoes from fv2_historico
      where (registro_tipo = 'PROPOSTA' and registro_id = $1) or (registro_tipo = 'CONCESSAO' and depois->>'usuarioId' = $2) order by seq`, [p.id, ids.aplicador]);
    const aplicada = rows.find((r) => r.registro_tipo === "PROPOSTA" && r.estado === "APLICADA");
    const retirada = rows.filter((r) => r.registro_tipo === "CONCESSAO" && !(r.acoes ?? []).includes(ACAO.APLICAR)).at(-1);
    assert.ok(retirada, "a revogação foi gravada");
    if (aplicada) assert.ok(Number(aplicada.seq) < Number(retirada.seq), `rodada ${i}: aplicação gravada depois da revogação`);
  }
});
