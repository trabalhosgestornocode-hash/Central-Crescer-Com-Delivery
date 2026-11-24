// MOVA CORE — F5: base de CONHECIMENTO corporativo. Memória e PostgreSQL isolado (migração 0021). Dados sintéticos.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { criarServicoDeConhecimento, criarRepositorioDeConhecimentoMemoria, criarRepositorioDeConhecimentoPostgres, pareceDadoDinamico, ferramentasDeConhecimento, ErroDeConhecimento } from "../../src/modules/mova-core/conhecimento.js";
import { CONHECIMENTO_DO_SISTEMA, carregarConhecimentoDoSistema } from "../../src/modules/mova-core/conhecimentoDoSistema.js";
import { criarBancoMova, descartarBancoMova, motivoParaPularMova } from "../mova-financeiro/helpers/banco.js";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001"; const ORG_B = "bbbbbbbb-0000-4000-8000-000000000001";
const UNI = "aaaaaaaa-0000-4000-8000-000000000011"; const UNI_2 = "aaaaaaaa-0000-4000-8000-000000000012";
const HOJE = "2026-11-24";
const BASE = { tipo: "PROCEDIMENTO", titulo: "Como conferir o caixa", conteudo: "Conte o dinheiro e compare com o esperado na tela de fechamento do caixa.", origem: "teste", responsavel: "Gerente", sugeridoPor: "ana" };
const erro = (codigo) => (e) => e instanceof ErroDeConhecimento && e.codigo === codigo;
const buscar = (s, pergunta, extra = {}) => s.buscar({ organizacaoId: ORG, unidadeId: UNI, pergunta, hoje: HOJE, ...extra });

test("CN-01 conhecimento NÃO guarda dado dinâmico; sugestão sempre PENDENTE; sugestão da IA marcada", async () => {
  for (const [conteudo, tipo] of [["O saldo do Inter hoje é R$ 4.520,10 e não pode baixar disso.", "FUNCIONAMENTO"], ["A conta da Coca vence amanhã, lembre de pagar.", "PROCEDIMENTO"], ["Devemos R$ 3.000 ao Atacadão.", "REGRA_FINANCEIRA"], ["Compramos brownies por R$ 259,00.", "FUNCIONAMENTO"], ["A política vale R$ 500,00.", "POLITICA"]]) {
    assert.ok(pareceDadoDinamico({ conteudo, tipo }), conteudo);
  }
  assert.equal(pareceDadoDinamico({ conteudo: "Limite de R$ 1.000,00 por pagamento; acima, revisão humana.", tipo: "POLITICA" }), null);
  const s = criarServicoDeConhecimento();
  await assert.rejects(s.sugerir({ ...BASE, chave: "caixa.saldo", conteudo: "O saldo do caixa é R$ 230,00 hoje, conferido.", tipo: "FUNCIONAMENTO" }), erro("DADO_DINAMICO"));
  await assert.rejects(s.sugerir({ ...BASE, chave: "x.sem-origem", origem: "" }), erro("SEM_ORIGEM"));
  const a = await s.sugerir({ ...BASE, chave: "caixa.conferir" });
  assert.deepEqual([a.estado, a.versao, a.sugeridoPelaIa], ["PENDENTE", 1, false]);
  const ia = await s.sugerir({ ...BASE, chave: "caixa.conferir", sugeridoPor: "MOVA (pedido de ana)" });
  assert.deepEqual([ia.estado, ia.versao, ia.sugeridoPelaIa], ["PENDENTE", 2, true]);
});

test("CN-02 aprovação HUMANA com permissão, nunca de quem sugeriu nem da IA; nova versão SUBSTITUI a anterior; trilha completa", async () => {
  const s = criarServicoDeConhecimento();
  const v1 = await s.sugerir({ ...BASE, chave: "regra.prazo", tipo: "REGRA_FINANCEIRA", conteudo: "Prestação de contas da sangria em até 48 horas." });
  await assert.rejects(s.aprovar({ id: v1.id, por: "bruno", podeAprovar: false }), erro("SEM_PERMISSAO"));
  await assert.rejects(s.aprovar({ id: v1.id, por: "MOVA", podeAprovar: true }), erro("APROVADOR_HUMANO"));
  await assert.rejects(s.aprovar({ id: v1.id, por: "ana", podeAprovar: true }), erro("APROVADOR_E_AUTOR"));
  assert.equal((await s.aprovar({ id: v1.id, por: "bruno", podeAprovar: true })).estado, "APROVADO");
  const v2 = await s.sugerir({ ...BASE, chave: "regra.prazo", tipo: "REGRA_FINANCEIRA", conteudo: "Prestação de contas da sangria em até 24 horas." });
  let [r] = await buscar(s, "qual o prazo da prestação de contas da sangria");
  assert.deepEqual([r.ref, r.autoridade], ["regra.prazo@v1", "REGRA_APROVADA"], "a v2 pendente NÃO vale como regra");
  await s.aprovar({ id: v2.id, por: "bruno", podeAprovar: true });
  [r] = await buscar(s, "qual o prazo da prestação de contas da sangria");
  assert.deepEqual([r.ref, r.aprovadoPor], ["regra.prazo@v2", "bruno"]);
  assert.deepEqual((await s.listar({})).map((x) => [x.versao, x.estado]).sort(), [[1, "SUBSTITUIDO"], [2, "APROVADO"]]);
  assert.deepEqual((await s.eventos(v1.id)).map((e) => e.acao), ["SUGERIDO", "APROVADO", "SUBSTITUIDO"]);
});

test("CN-03 busca: normativo pendente nunca aparece; documental pendente = 'em revisão'; revogação vale na hora; vigência; escopo da unidade sobrepõe o geral; outra empresa não vê", async () => {
  const s = criarServicoDeConhecimento();
  await s.sugerir({ ...BASE, chave: "politica.limite", tipo: "POLITICA", titulo: "Limite do MOVA", conteudo: "Limite de R$ 1.000,00 por pagamento pelo MOVA; acima, revisão humana." });
  assert.equal((await buscar(s, "qual o limite de pagamento do mova")).length, 0, "política pendente não é oficial");
  const doc = await s.sugerir({ ...BASE, chave: "caixa.conferir" });
  const [d] = await buscar(s, "como conferir o caixa");
  assert.equal(d.autoridade, "DOCUMENTACAO_EM_REVISAO");
  await s.revogar({ id: doc.id, por: "bruno", podeAprovar: true, motivo: "procedimento mudou" });
  assert.equal((await buscar(s, "como conferir o caixa")).length, 0, "revogado some imediatamente");
  await s.sugerir({ ...BASE, chave: "caixa.futuro", titulo: "Conferência nova do caixa", vigenteDe: "2027-01-01" });
  assert.equal((await buscar(s, "conferência nova do caixa")).length, 0, "vigência futura");
  const geral = await s.sugerir({ ...BASE, chave: "loja.horario", tipo: "PARTICULARIDADE_DA_UNIDADE", titulo: "Horário de abertura da loja", conteudo: "A loja abre às 10h.", organizacaoId: ORG });
  const daUnidade = await s.sugerir({ ...BASE, chave: "loja.horario", tipo: "PARTICULARIDADE_DA_UNIDADE", titulo: "Horário de abertura da loja", conteudo: "Esta loja abre às 11h aos domingos.", organizacaoId: ORG, unidadeId: UNI });
  for (const x of [geral, daUnidade]) await s.aprovar({ id: x.id, por: "bruno", podeAprovar: true });
  assert.match((await buscar(s, "horário de abertura da loja"))[0].conteudo, /11h/, "unidade sobrepõe a empresa");
  assert.match((await buscar(s, "horário de abertura da loja", { unidadeId: UNI_2 }))[0].conteudo, /10h/);
  assert.equal((await buscar(s, "horário de abertura da loja", { organizacaoId: ORG_B })).length, 0, "outra empresa");
});

test("CN-04 CORPO do sistema: carga idempotente; as 8 perguntas gerais encontram o conhecimento certo; política só vira regra depois da aprovação", async () => {
  const s = criarServicoDeConhecimento();
  assert.deepEqual(await carregarConhecimentoDoSistema(s), { criados: CONHECIMENTO_DO_SISTEMA.length, total: CONHECIMENTO_DO_SISTEMA.length });
  assert.equal((await carregarConhecimentoDoSistema(s)).criados, 0, "recarregar não cria versão nova");
  const esperado = {
    "Por que nosso faturamento líquido é diferente do dinheiro recebido?": "metodologia.faturamento-liquido-x-recebido",
    "Como funciona a nossa rotina de pagamento dos entregadores?": "funcionamento.entregadores-proprios",
    "Por que essa conta aparece nessa categoria?": "funcionamento.categoria-de-uma-conta",
    "O que falta para fechar o mês?": "procedimento.o-que-falta-fechar-o-mes",
    "Como devo registrar uma compra que já paguei?": "procedimento.compra-ja-paga",
    "O que acontece quando fazemos uma sangria?": "procedimento.sangria",
    "Quais informações temos sobre esse fornecedor?": "funcionamento.fornecedores",
    "Como posso reduzir nossos custos operacionais?": "metodologia.reduzir-custos",
    "como vinculo meu whatsapp ao mova?": "mova.vincular-whatsapp",
    "de onde vem o faturamento do ifood?": null, // decisão pendente não aparece; o funcionamento sim
  };
  for (const [pergunta, chave] of Object.entries(esperado)) {
    const r = await buscar(s, pergunta);
    if (chave) assert.ok(r.slice(0, 2).some((x) => x.chave === chave), `${pergunta} ⇒ ${r.map((x) => x.chave).join(", ")}`);
    else assert.ok(!r.some((x) => x.chave === "decisao.ifood-pelo-demonstrativo") && r.some((x) => x.chave.includes("ifood")), `${pergunta} ⇒ ${r.map((x) => x.chave).join(", ")}`);
    assert.ok(r.every((x) => x.autoridade === "DOCUMENTACAO_EM_REVISAO"), "tudo do corpo ainda está em revisão");
  }
  const pol = (await s.listar({})).find((x) => x.chave === "politica.mova-pagamento-por-comprovante");
  assert.ok(!(await buscar(s, "qual o limite da política de pagamento por comprovante do açaí")).some((x) => x.chave === pol.chave));
  await s.aprovar({ id: pol.id, por: "proprietario", podeAprovar: true });
  const [p] = (await buscar(s, "qual o limite da política de pagamento por comprovante do açaí")).filter((x) => x.chave === pol.chave);
  assert.equal(p.autoridade, "REGRA_APROVADA");
});

test("CN-05 ferramentas do modelo: busca devolve trechos + parâmetros como fatos; sugerir cria PENDENTE marcado como IA; não existe ferramenta de aprovar", async () => {
  const s = criarServicoDeConhecimento();
  const pol = await s.sugerir({ ...BASE, chave: "politica.limite", tipo: "POLITICA", titulo: "Limite do MOVA", conteudo: "Limite de R$ 1.000,00 por pagamento pelo MOVA; acima, revisão humana." });
  await s.aprovar({ id: pol.id, por: "bruno", podeAprovar: true });
  const [buscarF, sugerirF] = ferramentasDeConhecimento();
  assert.deepEqual(ferramentasDeConhecimento().map((f) => f.nome), ["buscar_conhecimento", "sugerir_conhecimento"]);
  const sessao = { conhecimento: s, organizacaoId: ORG, unidadeId: UNI, hoje: HOJE, usuarioId: "ana", requisicaoId: "r1" };
  const r = await buscarF.executar({ args: { pergunta: "qual o limite de pagamento do mova" }, sessao });
  assert.deepEqual([r.dados.itens[0].autoridade, r.fatos[0].valorCentavos], ["REGRA_APROVADA", 100000]);
  const vazio = await buscarF.executar({ args: { pergunta: "receita de bolo de cenoura" }, sessao });
  assert.equal(vazio.situacao, "SEM_REGISTROS");
  const sug = await sugerirF.executar({ args: { chave: "caixa.troco-minimo", tipo: "PROCEDIMENTO", titulo: "Troco mínimo na abertura", conteudo: "Abrir o caixa sempre com troco em notas pequenas." }, sessao });
  assert.equal(sug.dados.registrado, "SUGESTAO_PENDENTE");
  const x = (await s.listar({ organizacaoId: ORG })).find((y) => y.chave === "caixa.troco-minimo");
  assert.deepEqual([x.estado, x.sugeridoPelaIa, x.organizacaoId], ["PENDENTE", true, ORG]);
  const din = await sugerirF.executar({ args: { chave: "caixa.saldo", tipo: "FUNCIONAMENTO", titulo: "Saldo", conteudo: "O saldo do caixa hoje é R$ 230,00." }, sessao });
  assert.equal(din.erro, "DADO_DINAMICO");
});

// ---------------------------------------------------------------- PostgreSQL (0021)
const PULAR = motivoParaPularMova();
const tp = (nome, fn) => test(nome, { skip: PULAR }, fn);
const bancos = [];
after(async () => { for (const b of bancos) await descartarBancoMova(b).catch(() => {}); });
async function banco() { const b = await criarBancoMova(); bancos.push(b); return b; }

tp("CN-PG-1 no banco: corpo carregado, busca pelo índice de texto em português, aprovação, substituição, revogação e trilha", async () => {
  const { pool } = await banco();
  const s = criarServicoDeConhecimento({ repositorio: criarRepositorioDeConhecimentoPostgres(pool) });
  await carregarConhecimentoDoSistema(s);
  assert.equal((await carregarConhecimentoDoSistema(s)).criados, 0);
  const r = await buscar(s, "Como funciona a nossa rotina de pagamento dos entregadores?");
  assert.equal(r[0].chave, "funcionamento.entregadores-proprios");
  const pol = (await s.listar({})).find((x) => x.chave === "politica.mova-pagamento-por-comprovante");
  await s.aprovar({ id: pol.id, por: "proprietario", podeAprovar: true });
  const v2 = await s.sugerir({ ...CONHECIMENTO_DO_SISTEMA.find((x) => x.chave === pol.chave), conteudo: "Limite de R$ 800,00 por pagamento pelo MOVA; acima, revisão humana.", responsavel: "Proprietário", sugeridoPor: "gerente" });
  await s.aprovar({ id: v2.id, por: "proprietario", podeAprovar: true });
  const { rows } = await pool.query("select versao, estado from mova.core_conhecimento where chave = $1 order by versao", [pol.chave]);
  assert.deepEqual(rows.map((x) => [x.versao, x.estado]), [[1, "SUBSTITUIDO"], [2, "APROVADO"]]);
  await s.revogar({ id: v2.id, por: "proprietario", podeAprovar: true, motivo: "política suspensa" });
  assert.ok(!(await buscar(s, "limite da política de pagamento por comprovante")).some((x) => x.chave === pol.chave));
  assert.deepEqual((await s.eventos(v2.id)).map((e) => e.acao), ["SUGERIDO", "APROVADO", "REVOGADO"]);
});

tp("CN-PG-2 barreiras do banco: aprovado sem aprovador ou aprovado por quem sugeriu é recusado; só UM aprovado por chave (duas aprovações simultâneas: uma vence); trilha sem UPDATE para a aplicação", async () => {
  const { pool } = await banco();
  const repo = criarRepositorioDeConhecimentoPostgres(pool);
  const s = criarServicoDeConhecimento({ repositorio: repo });
  const a = await s.sugerir({ ...BASE, chave: "regra.x", tipo: "REGRA_FINANCEIRA", conteudo: "Toda compra acima do limite de R$ 500,00 exige duas cotações." });
  await assert.rejects(pool.query("update mova.core_conhecimento set estado = 'APROVADO' where id = $1", [a.id]), /check/i);
  await assert.rejects(pool.query("update mova.core_conhecimento set estado = 'APROVADO', aprovado_por = 'ana', aprovado_em = now() where id = $1", [a.id]), /check/i, "quem sugeriu não aprova");
  const b = await s.sugerir({ ...BASE, chave: "regra.x", tipo: "REGRA_FINANCEIRA", conteudo: "Toda compra acima do limite de R$ 300,00 exige duas cotações.", sugeridoPor: "carla" });
  const rs = await Promise.allSettled([s.aprovar({ id: a.id, por: "bruno", podeAprovar: true }), s.aprovar({ id: b.id, por: "bruno", podeAprovar: true })]);
  const { rows } = await pool.query("select count(*)::int as n from mova.core_conhecimento where chave = 'regra.x' and estado = 'APROVADO'");
  assert.equal(rows[0].n, 1, JSON.stringify(rs.map((x) => x.status)));
  const g = await pool.query("select has_table_privilege('mova_app', 'mova.core_conhecimento_evento', 'UPDATE') as u, has_table_privilege('mova_app', 'mova.core_conhecimento_evento', 'INSERT') as i, has_table_privilege('mova_app', 'mova.core_conhecimento', 'DELETE') as d");
  assert.deepEqual([g.rows[0].u, g.rows[0].i, g.rows[0].d], [false, true, false]);
});

tp("CN-PG-3 rollback oficial da 0021: recusa com conhecimento APROVADO; sem aprovado, remove as duas tabelas", async () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "database", "mova-financeiro", "recuperacao", "reverter-0021.sql"), "utf8");
  const { pool } = await banco();
  await pool.query("create table if not exists mova.mova_migracao (nome text primary key, sha256 text not null)");
  await pool.query("insert into mova.mova_migracao values ('0021_mova_core_conhecimento.sql', 'x') on conflict do nothing");
  await pool.query("delete from mova.mova_migracao where nome > '0021_mova_core_conhecimento.sql'");
  const s = criarServicoDeConhecimento({ repositorio: criarRepositorioDeConhecimentoPostgres(pool) });
  const a = await s.sugerir({ ...BASE, chave: "caixa.conferir" });
  await s.aprovar({ id: a.id, por: "bruno", podeAprovar: true });
  await assert.rejects(pool.query(sql), /APROVADO/);
  await s.revogar({ id: a.id, por: "bruno", podeAprovar: true, motivo: "desfazer a instalação" });
  await pool.query(sql);
  const { rows } = await pool.query("select to_regclass('mova.core_conhecimento') as c, to_regclass('mova.core_conhecimento_evento') as e");
  assert.deepEqual([rows[0].c, rows[0].e], [null, null]);
});
