// Migração 0023 + rotas /corporativo — ATIVAÇÃO SIMPLES do Financeiro v2 por administrador financeiro corporativo.
// PostgreSQL isolado, modo co-localizado (o de produção), identidades e dados SINTÉTICOS. Cobre: primeiro administrador
// (uma vez, com 2º fator), demais sem atestante, liberação em lote por unidade, escrita individual por unidade (a chave
// geral não basta), concessão sem autoconcessão, revogação imediata, isolamento entre duas unidades e entre empresas,
// auditoria e as operações manuais (conta, caixa, receita, despesa, recebível).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { criarAdaptadorDaPlataforma, criarAdministracaoCorporativaPostgres, criarLiberacoesPostgres, criarRepositorioPostgres, verificadorHs256 } from "../../src/modules/financeiro-v2/index.js";
import { criarRotasFinanceiroV2 } from "../../src/modules/fv2-integracao/rotas.js";
import { criarConcessoesDaSessao } from "../../src/modules/fv2-integracao/portasPlataforma.js";
import { criarMfaPeloProvedor } from "../../src/modules/fv2-integracao/mfaPeloProvedor.js";
import { criarAutoridadeCoLocalizada } from "../../src/modules/fv2-integracao/autoridadeCoLocalizada.js";
import { ORG_A, ORG_B, UNI_A, UNI_A2, UNI_B } from "./helpers/cenario.js";
import { abrirPool, criarBancoDeTeste, motivoParaPular } from "./helpers/postgres.js";
import { SEGREDO_SINTETICO, tokenSintetico } from "./helpers/tokens.js";

const pular = { skip: motivoParaPular(), timeout: 300000 };
const ADMIN = "eeeeeeee-0000-4000-8000-0000000000c1"; // conta do administrador corporativo (e da empresa)
const PESSOA_ADMIN = "eeeeeeee-0000-4000-8000-0000000000a1";
const ADMIN2 = "eeeeeeee-0000-4000-8000-0000000000c2"; // segundo administrador da empresa
const PESSOA_ADMIN2 = "eeeeeeee-0000-4000-8000-0000000000a2";
const CONTA_OP = "eeeeeeee-0000-4000-8000-0000000000c3"; // operadora (Saci e North)
const PESSOA_OP = "eeeeeeee-0000-4000-8000-0000000000a3";
const CONTA_SO_NORTH = "eeeeeeee-0000-4000-8000-0000000000c4";
const PESSOA_SO_NORTH = "eeeeeeee-0000-4000-8000-0000000000a4";
const CONTA_COMP = "eeeeeeee-0000-4000-8000-0000000000c5"; // conta compartilhada (2 pessoas)
const PESSOA_COMP = "eeeeeeee-0000-4000-8000-0000000000a5";
const CONTA_FORA = "eeeeeeee-0000-4000-8000-0000000000c6"; // administradora da plataforma, mas NÃO administradora financeira
const PESSOA_FORA = "eeeeeeee-0000-4000-8000-0000000000a6";
const CONTA_B = "eeeeeeee-0000-4000-8000-0000000000c7"; // outra empresa
const PESSOA_B = "eeeeeeee-0000-4000-8000-0000000000a7";
const ESCOPOS = [{ organizacaoId: ORG_A, unidadeId: UNI_A }, { organizacaoId: ORG_A, unidadeId: UNI_A2 }, { organizacaoId: ORG_B, unidadeId: UNI_B }];
const J = "Justificativa sintética com mais de vinte caracteres.";

const provedor = verificadorHs256(SEGREDO_SINTETICO);
const obterUsuario = async (t) => { const p = provedor(t); return p && p.exp * 1000 > Date.now() ? { id: p.sub } : null; };
const PESSOAS = {
  [PESSOA_ADMIN]: { conta: ADMIN, org: ORG_A, unidades: [UNI_A, UNI_A2] },
  [PESSOA_ADMIN2]: { conta: ADMIN2, org: ORG_A, unidades: [UNI_A, UNI_A2] },
  [PESSOA_OP]: { conta: CONTA_OP, org: ORG_A, unidades: [UNI_A, UNI_A2] },
  [PESSOA_SO_NORTH]: { conta: CONTA_SO_NORTH, org: ORG_A, unidades: [UNI_A2] },
  [PESSOA_COMP]: { conta: CONTA_COMP, org: ORG_A, unidades: [UNI_A] },
  [PESSOA_FORA]: { conta: CONTA_FORA, org: ORG_A, unidades: [UNI_A] },
  [PESSOA_B]: { conta: CONTA_B, org: ORG_B, unidades: [UNI_B] },
};
const ADMINS_DA_PLATAFORMA = [ADMIN, ADMIN2, CONTA_FORA]; // papel organization_admin na ORG_A
const vinculos = {
  contaDoPerfil: async ({ perfilId }) => PESSOAS[perfilId]?.conta ?? null,
  perfisAtivosDaConta: async ({ contaId }) => (contaId === CONTA_COMP ? 2 : Object.values(PESSOAS).filter((p) => p.conta === contaId).length),
  unidadesDoPerfil: async ({ perfilId, organizacaoId }) => (PESSOAS[perfilId]?.org === organizacaoId ? PESSOAS[perfilId].unidades : []),
  nomesDosPerfis: async ({ perfilIds }) => new Map(perfilIds.map((x) => [x, `Pessoa ${x.slice(-2)}`])),
};
const administracao = {
  autoridadeSobre: async ({ contaId, organizacaoId }) => ((organizacaoId === ORG_A && ADMINS_DA_PLATAFORMA.includes(contaId)) || (organizacaoId === ORG_B && contaId === CONTA_B) ? { tipo: "ADMIN_EMPRESA" } : null),
  contaDoPerfil: vinculos.contaDoPerfil,
  administradoresDaEmpresa: async ({ organizacaoId }) => (organizacaoId === ORG_A ? ADMINS_DA_PLATAFORMA : [CONTA_B]),
  unidadesDaEmpresa: async ({ organizacaoId }) => (organizacaoId === ORG_A ? [{ unidadeId: UNI_A, nome: "Subway Saci (sintética)" }, { unidadeId: UNI_A2, nome: "Subway North (sintética)" }] : [{ unidadeId: UNI_B, nome: "Outra empresa" }]),
  pessoasDaUnidade: async ({ unidadeId }) => Object.entries(PESSOAS).filter(([, v]) => v.unidades.includes(unidadeId)).map(([perfilId, v]) => ({ perfilId, nome: `Pessoa ${perfilId.slice(-2)}`, contaId: v.conta })),
};

const sessao = ({ conta, pessoa, unidade = UNI_A, org = ORG_A }) => ({
  user: { id: conta, ativo: true, senhaProvisoria: false, aal: "aal2" },
  tenant: { organizacaoId: org, unidadeId: unidade },
  acesso: { sessionId: `s-${pessoa}-${unidade}`, expiraEm: new Date(Date.now() + 3600_000).toISOString(), perfilId: pessoa, papel: "organization_admin", impersonando: false, impersonadoPor: null, empresa: { id: org, nome: "Grupo sintético" }, unidade: { id: unidade } },
});

let amb;
const fechar = [];
after(() => { for (const f of fechar) f(); });
async function montar() {
  if (amb) return amb;
  const b = await criarBancoDeTeste(ESCOPOS);
  const poolApp = await abrirPool(b.urlApp, { max: 4 });
  const poolAut = await abrirPool(b.urlAutoridade, { max: 2 });
  const dono = await abrirPool(b.urlAdmin, { max: 2 });
  const mfa = criarMfaPeloProvedor({ obterUsuario });
  const repositorio = criarRepositorioPostgres({ pool: poolApp, sessoes: criarAutoridadeCoLocalizada({ poolAutoridade: poolAut, obterUsuario, mfa }) });
  const liberacoes = criarLiberacoesPostgres({ poolApp });
  const adaptador = criarAdaptadorDaPlataforma({ liberacoes, vinculos, concessoes: criarConcessoesDaSessao({ repositorio }), mfa });
  const corporativo = criarAdministracaoCorporativaPostgres(poolAut);
  const deps = () => ({ repositorio, adaptador, vinculos, liberacoes, mfa, poolAutoridade: poolAut, administracao, corporativo });
  const app = express();
  app.use((req, _res, next) => { const s = JSON.parse(req.header("x-teste-sessao") ?? "null"); if (s) Object.assign(req, s); next(); });
  app.use("/corp", criarRotasFinanceiroV2({ habilitado: true, escritaHabilitada: true, provisionamentoHabilitado: true, dependencias: deps }));
  app.use("/semescrita", criarRotasFinanceiroV2({ habilitado: true, escritaHabilitada: false, dependencias: deps }));
  const servidor = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  fechar.push(() => servidor.close());
  amb = { url: `http://127.0.0.1:${servidor.address().port}`, poolAut, dono, corporativo };
  return amb;
}
const token = (conta, o = {}) => tokenSintetico({ agoraMs: Date.now(), conta, ...o });
async function chamar(prefixo, caminho, { conta, pessoa, unidade = UNI_A, org = ORG_A, metodo = "GET", corpo, t } = {}) {
  const { url } = await montar();
  const s = sessao({ conta, pessoa, unidade, org });
  const r = await fetch(`${url}/${prefixo}${caminho}`, { method: metodo, headers: { authorization: `Bearer ${t ?? token(conta)}`, "x-teste-sessao": JSON.stringify(s), ...(corpo !== undefined ? { "content-type": "application/json" } : {}) }, ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}) });
  return { status: r.status, corpo: await r.json() };
}
const adm = (c, o = {}) => chamar("corp", c, { conta: ADMIN, pessoa: PESSOA_ADMIN, ...o });
const op = (c, o = {}) => chamar("corp", c, { conta: CONTA_OP, pessoa: PESSOA_OP, ...o });
const motivo = (r) => r.corpo.motivo ?? r.corpo.codigo;

test("0023 — primeiro administrador: só com 2º fator recente e só uma vez; os demais, sem atestante; ninguém muda a si mesmo; nunca fica sem administrador", pular, async () => {
  const { corporativo } = await montar();
  const base = { organizacaoId: ORG_A, justificativa: J };
  // sem administrador na empresa, o ato exige o 2º fator recente do ator
  await assert.rejects(corporativo.definirAdministrador({ ...base, contaId: ADMIN, ativo: true, atorContaId: ADMIN }), (e) => e?.detalhes?.motivo === "SEM_AUTORIDADE_CORPORATIVA");
  await assert.rejects(corporativo.definirAdministrador({ ...base, contaId: ADMIN, ativo: true, atorContaId: ADMIN, segundoFatorEm: Date.now() - 3_600_000 }), (e) => e?.detalhes?.motivo === "SEM_AUTORIDADE_CORPORATIVA", "fator antigo");
  await corporativo.definirAdministrador({ ...base, contaId: ADMIN, ativo: true, atorContaId: ADMIN, segundoFatorEm: Date.now() - 30_000 });
  assert.equal(await corporativo.ehAdministrador({ organizacaoId: ORG_A, contaId: ADMIN }), true);
  // o segundo: pelo primeiro, sem fator; quem não é administrador não define; ninguém altera a si mesmo
  await assert.rejects(corporativo.definirAdministrador({ ...base, contaId: ADMIN2, ativo: true, atorContaId: CONTA_FORA }), (e) => e?.detalhes?.motivo === "SEM_AUTORIDADE_CORPORATIVA");
  await assert.rejects(corporativo.definirAdministrador({ ...base, contaId: ADMIN, ativo: false, atorContaId: ADMIN }), (e) => e?.detalhes?.motivo === "SEM_AUTORIDADE_CORPORATIVA", "ninguém muda a si mesmo");
  await corporativo.definirAdministrador({ ...base, contaId: ADMIN2, ativo: true, atorContaId: ADMIN });
  assert.equal(await corporativo.ehAdministrador({ organizacaoId: ORG_A, contaId: ADMIN2 }), true);
  // outra empresa não herda nada
  assert.equal(await corporativo.ehAdministrador({ organizacaoId: ORG_B, contaId: ADMIN }), false);
  // empresa fora dos escopos do banco financeiro
  await assert.rejects(corporativo.definirAdministrador({ ...base, organizacaoId: randomUUID(), contaId: ADMIN, ativo: true, atorContaId: ADMIN, segundoFatorEm: Date.now() - 1000 }));
  const { dono } = await montar();
  const hist = (await dono.query("select origem, segundo_fator_em from financeiro_v2.fv2_administrador_corporativo_historico order by seq")).rows;
  assert.deepEqual(hist.map((h) => h.origem), ["INFRAESTRUTURA", "ADMINISTRADOR_CORPORATIVO"]);
  assert.ok(hist[0].segundo_fator_em && hist[1].segundo_fator_em === null);
});

test("0023 — rotas /corporativo: só administrador da empresa E administrador financeiro; conta pessoal; empresa sempre a da sessão", pular, async () => {
  // administradora da plataforma sem condição de administradora financeira
  assert.equal(motivo(await chamar("corp", "/corporativo/contexto", { conta: CONTA_FORA, pessoa: PESSOA_FORA })), "NAO_E_ADMINISTRADOR_CORPORATIVO");
  // pessoa comum
  assert.equal(motivo(await op("/corporativo/contexto")), "SEM_AUTORIDADE_ADMINISTRATIVA");
  // administrador da plataforma de OUTRA empresa: sem condição de administrador financeiro, e nada da empresa A aparece
  assert.equal(motivo(await chamar("corp", "/corporativo/contexto", { conta: CONTA_B, pessoa: PESSOA_B, unidade: UNI_B, org: ORG_B })), "NAO_E_ADMINISTRADOR_CORPORATIVO");
  const ctx = await adm("/corporativo/contexto");
  assert.equal(ctx.status, 200, JSON.stringify(ctx.corpo));
  assert.deepEqual(ctx.corpo.unidades.map((u) => [u.id, u.liberada, u.escrita]).sort(), [[UNI_A, false, false], [UNI_A2, false, false]].sort());
  assert.ok(ctx.corpo.unidades.every((u) => !u.nome.includes("Outra")), "unidades de outra empresa não aparecem");
  assert.equal(ctx.corpo.administradores.length, 2);
  // administrador novo: precisa ser admin da plataforma (CONTA_OP não é) e conta pessoal
  assert.equal((await adm("/corporativo/administradores", { metodo: "POST", corpo: { conta: CONTA_OP, ativo: true, justificativa: J } })).corpo.codigo, "NAO_E_ADMIN_DA_EMPRESA");
  // justificativa curta e campo desconhecido
  assert.equal((await adm("/corporativo/liberacao", { metodo: "POST", corpo: { unidades: [UNI_A], ativa: true, justificativa: "curta" } })).corpo.codigo, "JUSTIFICATIVA_INSUFICIENTE");
  assert.equal((await adm("/corporativo/liberacao", { metodo: "POST", corpo: { unidades: [UNI_A], ativa: true, justificativa: J, organizacao: ORG_B } })).corpo.codigo, "CAMPO_DESCONHECIDO");
  // lote com unidade de OUTRA empresa: nada é alterado
  const mista = await adm("/corporativo/liberacao", { metodo: "POST", corpo: { unidades: [UNI_A, UNI_B], ativa: true, justificativa: J } });
  assert.equal(mista.status, 403);
  assert.deepEqual((await adm("/corporativo/contexto")).corpo.unidades.filter((u) => u.liberada), []);
});

test("0023 — liberação em lote (Saci + North numa chamada, sem TOTP) e escrita INDIVIDUAL: a chave geral não basta", pular, async () => {
  const { dono } = await montar();
  // antes de liberar: sem concessão/liberação, nada opera
  assert.equal((await op("/status")).corpo.liberado, false);
  const r = await adm("/corporativo/liberacao", { metodo: "POST", corpo: { unidades: [UNI_A, UNI_A2], ativa: true, escrita: false, justificativa: "Ativação do Financeiro v2 nas duas Subway (sintético)." }, t: token(ADMIN, { metodo: null }) });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.unidadesAlteradas, 2);
  assert.equal((await op("/status")).corpo.liberado, true);
  // concessão (sem atestante, sem TOTP): operadora com perfil FINANCEIRO nas duas
  for (const unidade of [UNI_A, UNI_A2]) {
    const g = await adm("/corporativo/acessos", { metodo: "POST", corpo: { unidade, perfil: PESSOA_OP, nivel: "FINANCEIRO", justificativa: J }, t: token(ADMIN, { metodo: null }) });
    assert.equal(g.status, 200, JSON.stringify(g.corpo));
  }
  // liberada, com concessão, chave geral ligada — mas a escrita da unidade está DESLIGADA
  const bloq = await op("/acoes/configuracoes/implantar-plano", { metodo: "POST", corpo: { modelo: "ACAITERIA", modeloConfirmado: "ACAITERIA" } });
  assert.equal(bloq.status, 403);
  assert.equal(bloq.corpo.codigo, "ESCRITA_DA_UNIDADE_DESLIGADA", JSON.stringify(bloq.corpo));
  assert.equal((await op("/sessao")).corpo.escritaHabilitada, false);
  // liga a escrita SÓ da Saci
  assert.equal((await adm("/corporativo/liberacao", { metodo: "POST", corpo: { unidades: [UNI_A], ativa: true, escrita: true, justificativa: J } })).status, 200);
  assert.equal((await op("/sessao")).corpo.escritaHabilitada, true);
  assert.equal((await op("/acoes/configuracoes/implantar-plano", { metodo: "POST", corpo: { modelo: "ACAITERIA", modeloConfirmado: "ACAITERIA" } })).status, 200);
  assert.equal((await op("/acoes/configuracoes/implantar-plano", { metodo: "POST", corpo: { modelo: "ACAITERIA", modeloConfirmado: "ACAITERIA" }, unidade: UNI_A2 })).corpo.codigo, "ESCRITA_DA_UNIDADE_DESLIGADA", "North continua só consulta");
  // a chave geral desligada também bloqueia (mecanismo de emergência)
  assert.equal((await chamar("semescrita", "/acoes/configuracoes/conta/criar", { conta: CONTA_OP, pessoa: PESSOA_OP, metodo: "POST", corpo: { tipo: "BANCARIA", nome: "x" } })).corpo.codigo, "ESCRITA_DESLIGADA");
  // auditoria da liberação: ator individual, sem segundo fator, origem identificada
  const h = (await dono.query("select ator, origem, segundo_fator_em, escrita_depois from financeiro_v2.fv2_liberacao_historico where origem = 'ADMINISTRADOR_CORPORATIVO' order by seq")).rows;
  assert.ok(h.length >= 4 && h.every((x) => x.ator === ADMIN && x.segundo_fator_em === null));
});

test("0023 — concessão: sem autoconcessão, conta compartilhada recusada, pessoa sem vínculo recusada, revogação imediata; auditoria completa", pular, async () => {
  const { dono } = await montar();
  const dar = (corpo, o = {}) => adm("/corporativo/acessos", { metodo: "POST", corpo: { justificativa: J, ...corpo }, ...o });
  assert.equal((await dar({ unidade: UNI_A, perfil: PESSOA_ADMIN, nivel: "FINANCEIRO" })).status, 400, "autoconcessão");
  assert.equal((await dar({ unidade: UNI_A, perfil: PESSOA_COMP, nivel: "OPERADOR" })).corpo.codigo, "CONTA_COMPARTILHADA");
  assert.equal((await dar({ unidade: UNI_A, perfil: PESSOA_SO_NORTH, nivel: "OPERADOR" })).corpo.codigo, "PESSOA_SEM_VINCULO", "sem vínculo com a unidade");
  assert.equal((await dar({ unidade: UNI_B, perfil: PESSOA_B, nivel: "OPERADOR" })).corpo.codigo, "UNIDADE_FORA_DA_EMPRESA");
  assert.equal((await dar({ unidade: UNI_A, perfil: PESSOA_OP, nivel: "INEXISTENTE" })).status, 400);
  assert.equal(motivo(await op("/corporativo/acessos", { metodo: "POST", corpo: { unidade: UNI_A, perfil: PESSOA_OP, nivel: "FINANCEIRO", justificativa: J } })), "SEM_AUTORIDADE_ADMINISTRATIVA", "quem opera não concede");
  // pessoas da unidade mostram o nível atual
  const pessoas = await adm(`/corporativo/pessoas?unidade=${UNI_A}`);
  assert.equal(pessoas.corpo.pessoas.find((p) => p.perfilId === PESSOA_OP).nivel, "FINANCEIRO");
  assert.equal(pessoas.corpo.pessoas.find((p) => p.perfilId === PESSOA_COMP).contaPessoal, false);
  // outra pessoa só consulta
  assert.equal((await dar({ unidade: UNI_A2, perfil: PESSOA_SO_NORTH, nivel: "CONSULTA" })).status, 200);
  const so = (c, o = {}) => chamar("corp", c, { conta: CONTA_SO_NORTH, pessoa: PESSOA_SO_NORTH, unidade: UNI_A2, ...o });
  assert.equal((await so("/api/permissoes")).status, 200);
  // revogação vale na operação seguinte
  assert.equal((await dar({ unidade: UNI_A, perfil: PESSOA_OP, nivel: "NENHUM" })).status, 200);
  assert.equal(motivo(await op("/acoes/configuracoes/conta/criar", { metodo: "POST", corpo: { tipo: "BANCARIA", nome: "Não deve gravar" } })), "SEM_CONCESSAO");
  assert.equal((await dar({ unidade: UNI_A, perfil: PESSOA_OP, nivel: "FINANCEIRO" })).status, 200, "religar");
  const aud = (await dono.query("select finalidade, operacao, sessao_id, ator from financeiro_v2.fv2_auditoria_concessao where finalidade = 'ADMINISTRACAO_CORPORATIVA' order by seq")).rows;
  assert.ok(aud.length >= 4 && aud.every((a) => a.sessao_id === null && a.ator === PESSOA_ADMIN));
  assert.ok(aud.some((a) => a.operacao === "REVOGACAO"));
});

test("0023 — operação manual completa na Saci: conta, caixa, receita, despesa, recebível, pagamento; sem duplicar; North e outra empresa não enxergam", pular, async () => {
  const { dono } = await montar();
  const W = (caminho, corpo, o = {}) => op(`/acoes${caminho}`, { metodo: "POST", corpo, ...o });
  const R = (caminho, o = {}) => op(`/api${caminho}`, o);
  const banco = await W("/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Unicred sintética", instituicao: "Banco sintético" });
  assert.equal(banco.status, 200, JSON.stringify(banco.corpo));
  const caixa = await W("/configuracoes/conta/criar", { tipo: "CAIXA_FISICO", nome: "Caixa sintético" });
  assert.equal(caixa.status, 200, JSON.stringify(caixa.corpo));
  const sessaoDeCaixa = await W("/caixa/abrir", { conta: caixa.corpo.id, data: "2026-10-01", contado: "150,00", observacao: "Contagem sintética" });
  assert.equal(sessaoDeCaixa.status, 200, JSON.stringify(sessaoDeCaixa.corpo));
  assert.equal((await W("/caixa/abrir", { conta: caixa.corpo.id, data: "2026-10-02", contado: "10,00" })).status >= 400, true, "uma sessão aberta por caixa");
  // receita (venda) manual — repetir o mesmo formulário não duplica; outro formulário é outra venda
  const chave = randomUUID();
  const venda = { canal: "BALCAO", dataVenda: "2026-10-05", valor: "80,00", forma: "PIX", conta: banco.corpo.id, descricao: "Venda sintética", chave };
  const v1 = await W("/vendas/registrar", venda);
  assert.equal(v1.status, 200, JSON.stringify(v1.corpo));
  const v2 = await W("/vendas/registrar", venda);
  assert.equal(v2.corpo.repetido, true);
  assert.equal(Number((await dono.query("select count(*) n from financeiro_v2.fv2_venda where unidade_id = $1", [UNI_A])).rows[0].n), 1);
  assert.equal((await W("/vendas/registrar", { ...venda, chave: undefined })).corpo.codigo, "FV2_ENTRADA_INVALIDA");
  // despesa: obrigação com fornecedor novo + pagamento
  const form = { descricao: "Fornecedor sintético", valor: "30,00", categoria: "INSUMOS", competencia: "2026-10", dataEmissao: "2026-10-03", vencimento: "2026-10-20", fornecedorNovo: "Fornecedor Sintético", chave: randomUUID() };
  const ob = await W("/obrigacoes/registrar", form);
  assert.equal(ob.status, 200, JSON.stringify(ob.corpo));
  assert.equal((await W("/obrigacoes/registrar", form)).corpo.repetido, true);
  const pag = await W("/obrigacoes/pagar", { obrigacao: ob.corpo.obrigacoes[0].id, conta: banco.corpo.id, dataEfetiva: "2026-10-06", valor: "30,00" });
  assert.equal(pag.status, 200, JSON.stringify(pag.corpo));
  // recebível manual (repasse do iFood a receber)
  const rec = await W("/recebiveis/registrar", { clienteNovo: "Cliente sintético", valor: "200,00", competencia: "2026-10", vencimento: "2026-11-05", descricao: "Repasse sintético", chave: randomUUID() });
  assert.equal(rec.status, 200, JSON.stringify(rec.corpo));
  // consultas refletem os registros (visão da Saci)
  const aReceber = await R("/contas-a-receber?competencia=2026-10");
  assert.equal(aReceber.status, 200, JSON.stringify(aReceber.corpo));
  assert.ok(JSON.stringify(aReceber.corpo).includes("Repasse sintético") || aReceber.corpo.itens?.length >= 1);
  const caixaEBancos = await R("/caixa-e-bancos?inicio=2026-10-01&fim=2026-10-31");
  const ub = caixaEBancos.corpo.contas.find((c) => c.nome === "Unicred sintética");
  assert.ok(ub, "conta aparece");
  const dre = await R("/dre?competencia=2026-10");
  assert.equal(dre.status, 200, JSON.stringify(dre.corpo));
  assert.ok(JSON.stringify(dre.corpo).includes("8000"), "a venda de R$ 80,00 compõe o faturamento");
  // ISOLAMENTO: a North (mesma empresa, mesma pessoa, concessão própria) não vê nada da Saci
  const north = await chamar("corp", "/api/caixa-e-bancos?inicio=2026-10-01&fim=2026-10-31", { conta: CONTA_OP, pessoa: PESSOA_OP, unidade: UNI_A2 });
  assert.equal(north.status, 200, JSON.stringify(north.corpo));
  assert.deepEqual(north.corpo.contas, [], "a North não vê as contas da Saci");
  const northVendas = await chamar("corp", "/api/vendas?competencia=2026-10", { conta: CONTA_OP, pessoa: PESSOA_OP, unidade: UNI_A2 });
  assert.equal(JSON.stringify(northVendas.corpo).includes("Venda sintética"), false);
  // outra empresa: nenhuma rota recusa por engano, e a pessoa B não tem nem liberação
  assert.equal((await chamar("corp", "/api/caixa-e-bancos", { conta: CONTA_B, pessoa: PESSOA_B, unidade: UNI_B, org: ORG_B })).status, 403);
  // cada gravação tem a pessoa individual no histórico
  const quem = (await dono.query("select distinct usuario_id from financeiro_v2.fv2_historico where unidade_id = $1", [UNI_A])).rows.map((x) => x.usuario_id);
  assert.ok(quem.includes(PESSOA_OP) && !quem.includes(ADMIN));
  // North (escrita desligada) continua sem gravar; tentativa não deixa rastro
  const antes = Number((await dono.query("select count(*) n from financeiro_v2.fv2_conta where unidade_id = $1", [UNI_A2])).rows[0].n);
  assert.equal((await W("/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Não grava" }, { unidade: UNI_A2 })).corpo.codigo, "ESCRITA_DA_UNIDADE_DESLIGADA");
  assert.equal(Number((await dono.query("select count(*) n from financeiro_v2.fv2_conta where unidade_id = $1", [UNI_A2])).rows[0].n), antes);
});

test("0023 — desligar a unidade vale na hora, preserva os dados e o histórico; religar não apaga nada; administrador removido perde a autoridade", pular, async () => {
  const { dono } = await montar();
  const vendas = async () => Number((await dono.query("select count(*) n from financeiro_v2.fv2_venda where unidade_id = $1", [UNI_A])).rows[0].n);
  const antes = await vendas();
  assert.ok(antes >= 1);
  assert.equal((await adm("/corporativo/liberacao", { metodo: "POST", corpo: { unidades: [UNI_A], ativa: false, justificativa: J } })).status, 200);
  assert.equal((await op("/status")).corpo.liberado, false);
  assert.equal((await op("/acoes/configuracoes/conta/criar", { metodo: "POST", corpo: { tipo: "BANCARIA", nome: "x" } })).status, 403);
  assert.equal(await vendas(), antes, "nada é apagado");
  // desligada nunca fica com escrita
  assert.equal(Number((await dono.query("select count(*) n from financeiro_v2.fv2_liberacao where unidade_id = $1 and ativa = false and escrita_ativa = true", [UNI_A])).rows[0].n), 0);
  assert.equal((await adm("/corporativo/liberacao", { metodo: "POST", corpo: { unidades: [UNI_A], ativa: true, justificativa: J } })).status, 200);
  assert.equal((await op("/sessao")).corpo.escritaHabilitada, true);
  // o segundo administrador remove o primeiro; o removido perde a autoridade; ninguém pode deixar a empresa sem administrador
  assert.equal((await chamar("corp", "/corporativo/administradores", { conta: ADMIN2, pessoa: PESSOA_ADMIN2, metodo: "POST", corpo: { conta: ADMIN, ativo: false, justificativa: J } })).status, 200);
  assert.equal(motivo(await adm("/corporativo/contexto")), "NAO_E_ADMINISTRADOR_CORPORATIVO");
  assert.equal((await chamar("corp", "/corporativo/administradores", { conta: ADMIN2, pessoa: PESSOA_ADMIN2, metodo: "POST", corpo: { conta: ADMIN2, ativo: false, justificativa: J } })).status >= 400, true);
});

test("0023 — a empresa sem administrador corporativo só ganha o primeiro pelo procedimento de ativação (administrador da plataforma + 2º fator); funções protegidas no banco", pular, async () => {
  const { poolAut, dono } = await montar();
  // empresa NOVA (B): o administrador da plataforma só vira administrador financeiro com o 2º fator recente — e só uma vez
  const inicial = (t, corpo = { justificativa: J }) => chamar("corp", "/administracao/administrador-corporativo-inicial", { conta: CONTA_B, pessoa: PESSOA_B, unidade: UNI_B, org: ORG_B, metodo: "POST", corpo, t });
  assert.ok((await inicial(token(CONTA_B, { metodo: null }))).status >= 400, "sem 2º fator");
  assert.ok((await inicial(token(CONTA_B, { fatorHaS: 3600 }))).status >= 400, "2º fator antigo");
  assert.equal(motivo(await inicial(token(CONTA_B, { fatorHaS: 20 }), { justificativa: J, conta: CONTA_FORA })), "NAO_E_ADMIN_DA_EMPRESA", "outra conta não é administradora da empresa B");
  const ok = await inicial(token(CONTA_B, { fatorHaS: 20 }));
  assert.equal(ok.status, 200, JSON.stringify(ok.corpo));
  assert.equal((await chamar("corp", "/corporativo/contexto", { conta: CONTA_B, pessoa: PESSOA_B, unidade: UNI_B, org: ORG_B })).status, 200, "agora administra a empresa B");
  assert.ok((await chamar("corp", "/corporativo/contexto", { conta: CONTA_B, pessoa: PESSOA_B, unidade: UNI_B, org: ORG_B })).corpo.unidades.every((u) => u.id === UNI_B), "só as unidades da empresa B");
  const outra = await inicial(token(CONTA_B, { fatorHaS: 20 }));
  assert.ok(outra.status >= 400, "com administrador ativo, o procedimento inicial não serve de novo (nem para o próprio)");
  assert.equal(Number((await dono.query("select count(*) n from financeiro_v2.fv2_administrador_corporativo where organizacao_id = $1 and ativo", [ORG_B])).rows[0].n), 1);
  // A não herdou nada de B
  // administradora da plataforma da ORG_A (CONTA_FORA) sem 2º fator recente: recusado
  const semFator = await chamar("corp", "/administracao/administrador-corporativo-inicial", { conta: CONTA_FORA, pessoa: PESSOA_FORA, metodo: "POST", corpo: { justificativa: J }, t: token(CONTA_FORA, { metodo: null }) });
  assert.ok(semFator.status >= 400);
  // a empresa já tem administrador (ADMIN2): o procedimento inicial deixa de ser a via (exige administrador existente)
  const ja = await chamar("corp", "/administracao/administrador-corporativo-inicial", { conta: CONTA_FORA, pessoa: PESSOA_FORA, metodo: "POST", corpo: { justificativa: J }, t: token(CONTA_FORA, { fatorHaS: 20 }) });
  assert.ok(ja.status >= 400, "com administrador ativo, quem não é administrador não se promove");
  // a aplicação (papel fv2_app) não executa nenhuma função administrativa; só a autoridade
  const { urlApp } = { urlApp: (await criarBancoDeTeste([])).urlApp };
  const app = await abrirPool(urlApp, { max: 1 });
  for (const f of ["fv2_liberacao_alterar_lote(gen_random_uuid(), array[gen_random_uuid()], true, true, gen_random_uuid(), 'xxxxxxxxxxxxxxxxxxxxxxxx')", "fv2_administrador_corporativo_definir(gen_random_uuid(), gen_random_uuid(), true, gen_random_uuid(), 'xxxxxxxxxxxxxxxxxxxxxxxx', now())", "fv2_conceder_por_administrador(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, gen_random_uuid(), gen_random_uuid(), 'xxxxxxxxxxxxxxxxxxxxxxxx')"]) {
    await assert.rejects(app.query(`select ${f}`), (e) => e.code === "42501", f);
  }
  // histórico de liberação e de administradores é imutável
  await assert.rejects(dono.query("update financeiro_v2.fv2_administrador_corporativo_historico set ator = ator"), (e) => e.code === "FV042");
  assert.ok(poolAut);
});
