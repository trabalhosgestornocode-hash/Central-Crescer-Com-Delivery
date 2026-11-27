// MARCA × LOJA (27/11/2026). Achado em produção: a legenda "<serviço> <marca> <outra loja da rede>" foi atribuída à loja
// habilitada da MESMA marca, porque o apelido da marca sozinho identificava a loja. Regra nova: só o nome ESPECÍFICO identifica;
// a marca só confirma outra evidência (ou responde a "de qual unidade?"); loja da mesma empresa que está no cadastro e não
// no MOVA bloqueia com UNIDADE_NAO_HABILITADA. Tudo sintético: "Sanduba" e "Gelato no Ponto" são redes fictícias.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validarConfiguracao } from "../../src/modules/mova-financeiro/index.js";
import { RESULTADO_UNIDADE, citacoesDoTexto, marcasDaUnidade, resolverUnidade } from "../../src/modules/mova-financeiro/dominio/unidade.js";
import { RESPOSTA } from "../../src/modules/mova-financeiro/aplicacao/respostas.js";

const ORG_S = "aaaaaaaa-0000-4000-8000-000000000001"; // empresa da rede Sanduba (várias lojas no cadastro)
const ORG_G = "aaaaaaaa-0000-4000-8000-000000000002"; // empresa da Gelato no Ponto
const ORG_OUTRA = "aaaaaaaa-0000-4000-8000-000000000003"; // empresa de FORA (outra franquia da mesma rede)
const SANDUBA = "bbbbbbbb-0000-4000-8000-0000000000a1";
const GELATO = "bbbbbbbb-0000-4000-8000-0000000000b1";
const NORTE = "bbbbbbbb-0000-4000-8000-0000000000a2";
const RIO_AZUL = "bbbbbbbb-0000-4000-8000-0000000000a3";
const DE_FORA = "bbbbbbbb-0000-4000-8000-0000000000c1";
const GRUPO = "120000000000000001@g.us";
const SERVICO = "eeeeeeee-0000-4000-8000-0000000000a2";
const fontes = { situacao: "CONFIRMADA", sistemaDeLoja: "SAIPOS", plataformas: ["IFOOD"], anotaAiPelaSaipos: false };

const configuracao = ({ unidadesDoGrupo = [SANDUBA, GELATO], naoHabilitadas = true } = {}) => validarConfiguracao({
  modo: "SIMULACAO", identidadeServico: { usuarioId: SERVICO },
  unidades: [
    { organizacaoId: ORG_S, unidadeId: SANDUBA, nome: "Sanduba Centro", apelidos: ["sanduba", "sanduba centro"], fontes, pagadores: [{ nome: "SANDUBA ALIMENTOS" }] },
    { organizacaoId: ORG_G, unidadeId: GELATO, nome: "Gelato no Ponto Centro", apelidos: ["gelato", "gelato centro", "gelato no ponto"], fontes, pagadores: [{ nome: "GELATO COMERCIO" }] },
  ].filter((u) => unidadesDoGrupo.includes(u.unidadeId)),
  gruposAutorizados: [{ grupoId: GRUPO, unidades: unidadesDoGrupo, acesso: "ABERTO", ...(new Set(unidadesDoGrupo.map((u) => (u === SANDUBA ? ORG_S : ORG_G))).size > 1 ? { multiempresa: true } : {}) }],
  unidadesNaoHabilitadas: naoHabilitadas ? [
    { organizacaoId: ORG_S, unidadeId: SANDUBA, nome: "Sanduba Centro — Matriz" }, // a própria habilitada: descartada
    { organizacaoId: ORG_S, unidadeId: NORTE, nome: "Matriz Sanduba Norte Shopping" },
    { organizacaoId: ORG_S, unidadeId: RIO_AZUL, nome: "Sanduba Rio Azul" },
    { organizacaoId: ORG_OUTRA, unidadeId: DE_FORA, nome: "Sanduba Praia" }, // outra empresa: nunca entra
    { organizacaoId: "invalido", unidadeId: "x", nome: "" },
  ] : [],
});
const cfg = configuracao();
const grupo = { unidades: [SANDUBA, GELATO] };
const r = (textos, x = {}) => resolverUnidade({ cfg, grupo, textos: [].concat(textos), ...x });

test("configuração: só lojas NÃO habilitadas das MESMAS empresas entram; a habilitada e a de fora são descartadas", () => {
  assert.deepEqual(cfg.unidadesNaoHabilitadas.map((u) => u.unidadeId).sort(), [NORTE, RIO_AZUL].sort());
  assert.deepEqual(marcasDaUnidade(cfg.unidades.find((u) => u.unidadeId === SANDUBA)), ["sanduba"]);
  assert.deepEqual(marcasDaUnidade(cfg.unidades.find((u) => u.unidadeId === GELATO)).sort(), ["gelato", "gelato no ponto"]);
});

test("loja habilitada citada pelo nome específico: identificada", () => {
  assert.equal(r("Compra de bebidas para sanduba centro").unidade?.unidadeId, SANDUBA);
  assert.equal(r("Comprovante gelato no ponto centro").unidade?.unidadeId, GELATO);
  assert.equal(r("conserto do freezer GELATO CENTRO").unidade?.unidadeId, GELATO);
});

test("loja NÃO habilitada da mesma rede: UNIDADE_NAO_HABILITADA com o nome dela — nunca a loja habilitada da mesma marca", () => {
  for (const legenda of ["Controle de pragas sanduba Norte Shopping", "Compras para o computador do delivery SANDUBA NORTE SHOPPING", "nota do norte shopping", "Sanduba Rio Azul aluguel"]) {
    const u = r(legenda);
    assert.equal(u.resultado, RESULTADO_UNIDADE.NAO_HABILITADA, legenda);
    assert.equal(u.unidade, null);
    assert.match(u.unidadeDoDocumento, /Norte Shopping|Rio Azul/);
  }
  // Nenhuma evidência redireciona para a habilitada: nem o pagador (mesma empresa paga as duas lojas), nem o CNPJ, nem a IA.
  const comPagador = r("Controle de pragas sanduba norte shopping", { pagador: "SANDUBA ALIMENTOS LTDA", sugestaoIa: "Sanduba Centro" });
  assert.equal(comPagador.resultado, RESULTADO_UNIDADE.NAO_HABILITADA);
  // Conversa de UMA loja só: a loja não habilitada continua bloqueada (antes, "grupo de uma unidade" decidiria).
  const so = resolverUnidade({ cfg: configuracao({ unidadesDoGrupo: [SANDUBA] }), grupo: { unidades: [SANDUBA] }, textos: ["pragas sanduba norte shopping"] });
  assert.equal(so.resultado, RESULTADO_UNIDADE.NAO_HABILITADA);
  assert.equal(RESPOSTA.unidadeNaoHabilitada(u0().unidadeDoDocumento),
    "Identifiquei que este documento pertence à Matriz Sanduba Norte Shopping. Essa unidade ainda não está habilitada no Financeiro do MOVA. Nenhum lançamento foi realizado.");
});
const u0 = () => r("pragas sanduba norte shopping");

test("a leitura do DOCUMENTO (IA) que aponta loja não habilitada também bloqueia; com o texto apontando outra loja, conflito", () => {
  assert.equal(r("comprovante", { sugestaoIa: "Sanduba Norte Shopping" }).resultado, RESULTADO_UNIDADE.NAO_HABILITADA);
  assert.equal(r("comprovante sanduba centro", { sugestaoIa: "Sanduba Norte Shopping" }).resultado, RESULTADO_UNIDADE.CONFLITANTE);
  assert.equal(r("pragas sanduba centro e sanduba norte shopping").resultado, RESULTADO_UNIDADE.CONFLITANTE);
});

test("só a MARCA: não identifica a loja — pede esclarecimento sem outra evidência", () => {
  assert.equal(r("Comprovante, distribuidora gelato").resultado, RESULTADO_UNIDADE.NAO_IDENTIFICADA);
  assert.equal(r("compra de pão sanduba").resultado, RESULTADO_UNIDADE.NAO_IDENTIFICADA);
  assert.equal(r("parcela freezer gelato no ponto").resultado, RESULTADO_UNIDADE.NAO_IDENTIFICADA);
});

test("só a MARCA + evidência que a confirma: identificada pela evidência (pagador, conversa de uma loja)", () => {
  const p = r("compra de pão sanduba", { pagador: "SANDUBA ALIMENTOS" });
  assert.equal(p.resultado, RESULTADO_UNIDADE.IDENTIFICADA); assert.equal(p.unidade.unidadeId, SANDUBA);
  const so = resolverUnidade({ cfg: configuracao({ unidadesDoGrupo: [GELATO] }), grupo: { unidades: [GELATO] }, textos: ["distribuidora gelato"] });
  assert.equal(so.resultado, RESULTADO_UNIDADE.IDENTIFICADA); assert.equal(so.evidencia, "GRUPO_DE_UMA_UNIDADE");
});

test("resposta a 'de qual unidade?': a marca basta SÓ se nenhuma outra loja conhecida tem a mesma marca; consulta: basta na conversa", () => {
  // há outras lojas Sanduba no cadastro: "sanduba" sozinho é ambiguidade real — não resolve nem na resposta
  assert.equal(r("sanduba", { marcaBasta: true }).resultado, RESULTADO_UNIDADE.NAO_IDENTIFICADA);
  assert.equal(r("sanduba centro", { marcaBasta: true }).unidade?.unidadeId, SANDUBA);
  // nenhuma outra loja Gelato no cadastro: a marca resolve
  assert.equal(r("é do gelato", { marcaBasta: true }).unidade?.unidadeId, GELATO);
  // consulta (só leitura): a marca basta entre as lojas da conversa
  assert.equal(r("quanto gastou o sanduba", { somenteLeitura: true }).unidade?.unidadeId, SANDUBA);
  // mesmo na resposta, loja não habilitada citada bloqueia
  assert.equal(r("sanduba norte shopping", { marcaBasta: true }).resultado, RESULTADO_UNIDADE.NAO_HABILITADA);
});

// --- 27/11 (revisão do PR): cadastro CONSULTADO × INDISPONÍVEL, empresa com várias lojas, loja desconhecida, erro de digitação ---
const comCadastro = (situacao, x = {}) => validarConfiguracao({ ...cfgBruta(x), cadastroDeUnidades: situacao });
const cfgBruta = ({ naoHabilitadas = [{ organizacaoId: ORG_S, unidadeId: NORTE, nome: "Matriz Sanduba Norte Shopping" }, { organizacaoId: ORG_S, unidadeId: RIO_AZUL, nome: "Sanduba Rio Azul" }] } = {}) => ({
  modo: "SIMULACAO", identidadeServico: { usuarioId: SERVICO },
  unidades: [
    { organizacaoId: ORG_S, unidadeId: SANDUBA, nome: "Sanduba Centro", apelidos: ["sanduba", "sanduba centro"], fontes, pagadores: [{ nome: "SANDUBA ALIMENTOS" }], documentos: ["11111111000111"] },
    { organizacaoId: ORG_G, unidadeId: GELATO, nome: "Gelato no Ponto Centro", apelidos: ["gelato", "gelato centro", "gelato no ponto"], fontes, pagadores: [{ nome: "GELATO COMERCIO" }] },
  ],
  gruposAutorizados: [{ grupoId: GRUPO, unidades: [SANDUBA, GELATO], acesso: "ABERTO", multiempresa: true }],
  unidadesNaoHabilitadas: naoHabilitadas,
});
const rc = (c, t, x = {}) => resolverUnidade({ cfg: c, grupo, textos: [].concat(t), ...x });

test("cadastro CONSULTADO + empresa com OUTRAS lojas: pagador, CNPJ e conversa de uma loja não identificam a loja (pergunta)", () => {
  const c = comCadastro("CONSULTADO");
  assert.deepEqual([rc(c, "comprovante", { pagador: "SANDUBA ALIMENTOS" }).resultado, rc(c, "comprovante", { pagador: "SANDUBA ALIMENTOS" }).evidencia], [RESULTADO_UNIDADE.NAO_IDENTIFICADA, "EMPRESA_COM_VARIAS_LOJAS"]);
  assert.equal(rc(c, "comprovante", { documentoDestinatario: "11.111.111/0001-11" }).resultado, RESULTADO_UNIDADE.NAO_IDENTIFICADA);
  assert.equal(resolverUnidade({ cfg: c, grupo: { unidades: [SANDUBA] }, textos: ["comprovante"] }).resultado, RESULTADO_UNIDADE.NAO_IDENTIFICADA);
  // com o nome específico, identifica (e o pagador da mesma empresa confirma)
  assert.equal(rc(c, "comprovante sanduba centro", { pagador: "SANDUBA ALIMENTOS" }).unidade?.unidadeId, SANDUBA);
  // empresa com UMA loja (Gelato): o pagador basta
  assert.equal(rc(c, "comprovante", { pagador: "GELATO COMERCIO" }).unidade?.unidadeId, GELATO);
  // consulta (só leitura) numa conversa de uma loja continua respondendo
  assert.equal(resolverUnidade({ cfg: c, grupo: { unidades: [SANDUBA] }, textos: ["contas da semana"], somenteLeitura: true }).unidade?.unidadeId, SANDUBA);
});

test("cadastro INDISPONÍVEL: lista vazia por falha NÃO prova que não há outras lojas — só o nome específico identifica", () => {
  const c = comCadastro("INDISPONIVEL", { naoHabilitadas: [] });
  assert.equal(c.unidadesNaoHabilitadas.length, 0);
  for (const x of [{ pagador: "GELATO COMERCIO" }, { pagador: "SANDUBA ALIMENTOS" }, { documentoDestinatario: "11111111000111" }]) {
    assert.equal(rc(c, "comprovante", x).resultado, RESULTADO_UNIDADE.NAO_IDENTIFICADA, JSON.stringify(x));
  }
  assert.equal(rc(c, "é do gelato", { marcaBasta: true }).resultado, RESULTADO_UNIDADE.NAO_IDENTIFICADA, "nem a marca na resposta");
  assert.equal(rc(c, "gelato no ponto centro").unidade?.unidadeId, GELATO);
  assert.equal(rc(c, "sanduba centro", { pagador: "SANDUBA ALIMENTOS" }).unidade?.unidadeId, SANDUBA);
});

test("loja DESCONHECIDA (nem no cadastro): marca + lugar que não é da loja habilitada ⇒ pergunta, nunca a loja da marca", () => {
  const c = comCadastro("CONSULTADO");
  for (const t of ["pragas gelato shopping das flores", "aluguel GELATO NO PONTO aeroporto", "conta sanduba av brasil", "gelato no ponto norte"]) {
    const u = rc(c, t, { pagador: "GELATO COMERCIO" });
    assert.equal(u.resultado, RESULTADO_UNIDADE.NAO_IDENTIFICADA, t); assert.equal(u.evidencia, "LOJA_DESCONHECIDA", t);
  }
  // o lugar da PRÓPRIA loja não é desconhecido
  assert.equal(rc(c, "gelato no ponto centro").unidade?.unidadeId, GELATO);
});

test("erros de digitação e abreviações da loja NÃO habilitada também bloqueiam; palavras comuns e curtas não", () => {
  const c = comCadastro("CONSULTADO", { naoHabilitadas: [{ organizacaoId: ORG_S, unidadeId: NORTE, nome: "Matriz Sanduba Ilhabela Shopping" }, { organizacaoId: ORG_S, unidadeId: RIO_AZUL, nome: "Sanduba Rio Azul" }] });
  for (const t of ["pragas sanduba ilhabela shoping", "pragas sandubba ilhabela shopping", "conta da ilhabela", "conta da ilhabel", "pagamento sanduba rio azul"]) {
    assert.equal(rc(c, t).resultado, RESULTADO_UNIDADE.NAO_HABILITADA, t);
  }
  // erro em palavra CURTA não é tolerado (evita confundir palavras comuns) — mas nunca vira a loja habilitada: pergunta
  assert.equal(rc(c, "pagamento sanduba rio azull", { pagador: "SANDUBA ALIMENTOS" }).resultado, RESULTADO_UNIDADE.NAO_IDENTIFICADA);
  for (const t of ["caneta azul", "compra no rio", "no shopping"]) assert.notEqual(rc(c, t).resultado, RESULTADO_UNIDADE.NAO_HABILITADA, t);
});

test("revalidação de PROPOSTA antiga: contradição nunca passa; evidência insuficiente para; escolha de uma pessoa vale", async () => {
  const { revalidarUnidadeDaProposta } = await import("../../src/modules/mova-financeiro/dominio/unidade.js");
  const c = comCadastro("CONSULTADO");
  const prop = (x = {}) => ({ id: "p1", unidadeId: SANDUBA, leitura: { pagador: "SANDUBA ALIMENTOS" }, esclarecidoPor: null, ...x });
  const ev = (texto) => ({ texto, grupoId: GRUPO });
  assert.deepEqual(revalidarUnidadeDaProposta({ cfg: c, proposta: prop(), evento: ev("pragas sanduba norte shopping") }).contradiz, true);
  assert.equal(revalidarUnidadeDaProposta({ cfg: c, proposta: prop(), evento: ev("pragas sanduba norte shopping") }).motivo, RESULTADO_UNIDADE.NAO_HABILITADA);
  const insuf = revalidarUnidadeDaProposta({ cfg: c, proposta: prop(), evento: ev("comprovante") });
  assert.deepEqual([insuf.ok, insuf.contradiz], [false, false]);
  assert.equal(revalidarUnidadeDaProposta({ cfg: c, proposta: prop({ esclarecidoPor: "pessoa" }), evento: ev("comprovante") }).ok, true);
  assert.equal(revalidarUnidadeDaProposta({ cfg: c, proposta: prop(), evento: ev("comprovante sanduba centro") }).ok, true);
  // a leitura do documento aponta outra loja da conversa: divergente
  assert.equal(revalidarUnidadeDaProposta({ cfg: c, proposta: prop({ leitura: { pagador: "GELATO COMERCIO" } }), evento: ev("comprovante") }).contradiz, true);
  // a loja saiu do MOVA
  assert.equal(revalidarUnidadeDaProposta({ cfg: c, proposta: prop({ unidadeId: NORTE }), evento: ev("x") }).motivo, "UNIDADE_FORA_DO_MOVA");
});

test("configuração viva: o cadastro é trocado sem reinício; a troca de entregadores preserva o cadastro em vigor", async () => {
  const { configuracaoViva } = await import("../../src/modules/mova-financeiro/dominio/configuracao.js");
  const v = configuracaoViva(comCadastro("INDISPONIVEL", { naoHabilitadas: [] }));
  assert.deepEqual([v.cadastroDeUnidades, v.unidadesNaoHabilitadas.length], ["INDISPONIVEL", 0]);
  v.trocarCadastro({ lista: [{ organizacaoId: ORG_S, unidadeId: NORTE, nome: "Sanduba Norte Shopping" }, { organizacaoId: ORG_OUTRA, unidadeId: DE_FORA, nome: "Sanduba Praia" }], situacao: "CONSULTADO" });
  assert.deepEqual([v.cadastroDeUnidades, v.unidadesNaoHabilitadas.map((u) => u.unidadeId)], ["CONSULTADO", [NORTE]]);
  assert.equal(resolverUnidade({ cfg: v, grupo, textos: ["pragas norte shopping"] }).resultado, RESULTADO_UNIDADE.NAO_HABILITADA);
  assert.equal(v.trocarEntregadores(comCadastro("INDISPONIVEL", { naoHabilitadas: [] })).motivo, undefined);
  assert.equal(v.cadastroDeUnidades, "CONSULTADO", "a lista de entregadores não derruba o cadastro");
});

test("cadastro de lojas: só CONSULTADO com leitura boa; falha antes = INDISPONIVEL; leitura boa vale 6 h; resposta inválida não conta", async () => {
  const { criarCadastroDeLojas, CADASTRO_VALIDADE_MS } = await import("../../src/modules/fv2-integracao/mova.js");
  let agora = 1_000_000, falhar = true, resposta = [{ unidadeId: NORTE, organizacaoId: ORG_S, nome: "x" }];
  const c = criarCadastroDeLojas({ ler: async () => { if (falhar) throw Object.assign(new Error("fora"), { code: "ECONNRESET" }); return resposta; }, relogio: () => agora });
  assert.deepEqual(await c.atualizar([ORG_S]), { unidadesNaoHabilitadas: [], cadastroDeUnidades: "INDISPONIVEL" });
  falhar = false;
  assert.equal((await c.atualizar([ORG_S])).cadastroDeUnidades, "CONSULTADO");
  falhar = true; agora += 60_000;
  assert.deepEqual(await c.atualizar([ORG_S]), { unidadesNaoHabilitadas: resposta, cadastroDeUnidades: "CONSULTADO" }, "falha passageira mantém a leitura boa");
  agora += CADASTRO_VALIDADE_MS + 1;
  assert.equal((await c.atualizar([ORG_S])).cadastroDeUnidades, "INDISPONIVEL", "leitura velha demais");
  falhar = false; resposta = null;
  assert.equal((await c.atualizar([ORG_S])).cadastroDeUnidades, "INDISPONIVEL", "resposta inválida não é leitura boa");
});

test("ENTRE EMPRESAS: a conta de uma loja pagou pela outra — nunca vira lançamento da pagadora", () => {
  // nome específico da beneficiária + pagador da outra: conflito (main) / operação entre empresas (PR #236) — nunca a pagadora
  const a = r("pagamento distribuidora gelato no ponto centro", { pagador: "SANDUBA ALIMENTOS" });
  assert.notEqual(a.unidade?.unidadeId, SANDUBA);
  assert.ok([RESULTADO_UNIDADE.CONFLITANTE, "PAGO_POR_OUTRA_UNIDADE"].includes(a.resultado), a.resultado);
  // só a MARCA da beneficiária + pagador da outra: idem (a marca é referência, não identificação)
  const b = r("distribuidora gelato", { pagador: "SANDUBA ALIMENTOS" });
  assert.notEqual(b.unidade?.unidadeId, SANDUBA);
  assert.ok([RESULTADO_UNIDADE.CONFLITANTE, "PAGO_POR_OUTRA_UNIDADE"].includes(b.resultado), b.resultado);
  // duas marcas no texto: cita várias (pergunta)
  assert.equal(r("o sanduba pagou o gelato").resultado, RESULTADO_UNIDADE.CONFLITANTE);
});

test("nomes semelhantes e palavras soltas não identificam nem bloqueiam por engano", () => {
  assert.equal(r("compra no centro da cidade").resultado, RESULTADO_UNIDADE.NAO_IDENTIFICADA); // "centro" sozinho não é loja
  assert.equal(r("sandubas e gelatos").resultado, RESULTADO_UNIDADE.NAO_IDENTIFICADA); // palavra inteira, não pedaço
  assert.equal(r("compra no shopping").resultado, RESULTADO_UNIDADE.NAO_IDENTIFICADA); // "shopping" sozinho não é o local
  const t = citacoesDoTexto("sanduba norte shopping", cfg.unidades, cfg.unidadesNaoHabilitadas);
  assert.equal(t.marcas.size, 0, "a forma mais longa consome a marca"); assert.deepEqual([...t.naoHab.keys()], [NORTE]);
});

test("sem o cadastro da plataforma (falha de leitura): a marca sozinha continua sem identificar — pergunta, nunca a loja errada", () => {
  const sem = configuracao({ naoHabilitadas: false });
  const u = resolverUnidade({ cfg: sem, grupo, textos: ["Controle de pragas sanduba norte shopping"] });
  assert.equal(u.resultado, RESULTADO_UNIDADE.NAO_IDENTIFICADA);
});

test("apelido curto que NÃO é o começo do nome ('alfa' de 'Loja Alfa'): se outra loja do cadastro o carrega no nome, vira marca", () => {
  const c = validarConfiguracao({ modo: "SIMULACAO", identidadeServico: { usuarioId: SERVICO },
    unidades: [{ organizacaoId: ORG_S, unidadeId: SANDUBA, nome: "Loja Alfa", apelidos: ["alfa"], fontes }, { organizacaoId: ORG_S, unidadeId: GELATO, nome: "Loja Beta", apelidos: ["beta"], fontes }],
    gruposAutorizados: [{ grupoId: GRUPO, unidades: [SANDUBA, GELATO], acesso: "ABERTO" }],
    unidadesNaoHabilitadas: [{ organizacaoId: ORG_S, unidadeId: NORTE, nome: "Loja Alfa Norte Shopping" }] });
  const g = { unidades: [SANDUBA, GELATO] };
  const x = (t) => resolverUnidade({ cfg: c, grupo: g, textos: [t] });
  assert.equal(x("pragas alfa norte shopping").resultado, RESULTADO_UNIDADE.NAO_HABILITADA);
  assert.equal(x("pragas loja alfa norte shopping").resultado, RESULTADO_UNIDADE.NAO_HABILITADA);
  assert.equal(x("compra alfa").resultado, RESULTADO_UNIDADE.NAO_IDENTIFICADA); // "alfa" não distingue mais: pergunta
  assert.equal(x("compra loja alfa").unidade?.unidadeId, SANDUBA); // o nome completo continua identificando
  assert.equal(x("compra beta").unidade?.unidadeId, GELATO); // apelido que nenhuma outra loja carrega continua específico
});

test("loja habilitada de OUTRA conversa citada pela marca: fora do grupo (como antes)", () => {
  const soGelato = resolverUnidade({ cfg, grupo: { unidades: [GELATO] }, textos: ["compra sanduba"] });
  assert.equal(soGelato.resultado, RESULTADO_UNIDADE.FORA_DO_GRUPO);
});

test("ENTRE EMPRESAS (PR #236) com a trava: devedora precisa — nome específico vira operação entre empresas; marca ambígua pergunta", async () => {
  const { revalidarUnidadeDaProposta } = await import("../../src/modules/mova-financeiro/dominio/unidade.js");
  const c = comCadastro("CONSULTADO");
  // a Gelato pagou pela Sanduba Centro (nome específico): operação entre empresas, devedora = Sanduba, pagadora = Gelato
  const ok = rc(c, "manutenção sanduba centro", { pagador: "GELATO COMERCIO" });
  assert.deepEqual([ok.resultado, ok.unidade?.unidadeId, ok.pagadora?.unidadeId], [RESULTADO_UNIDADE.PAGO_POR_OUTRA_UNIDADE, SANDUBA, GELATO]);
  // só a marca "sanduba" (há outras lojas Sanduba no cadastro): nunca vira operação entre empresas — pergunta
  const amb = rc(c, "manutenção sanduba", { pagador: "GELATO COMERCIO" });
  assert.deepEqual([amb.resultado, amb.evidencia], [RESULTADO_UNIDADE.NAO_IDENTIFICADA, "DEVEDORA_NAO_PRECISA"]);
  // o inverso: a Sanduba pagou pela Gelato (marca sem outra loja Gelato): operação entre empresas nos dois sentidos
  const inv = rc(c, "freezer gelato", { pagador: "SANDUBA ALIMENTOS" });
  assert.deepEqual([inv.resultado, inv.unidade?.unidadeId, inv.pagadora?.unidadeId], [RESULTADO_UNIDADE.PAGO_POR_OUTRA_UNIDADE, GELATO, SANDUBA]);
  // loja não habilitada citada: bloqueia antes de qualquer operação entre empresas
  assert.equal(rc(c, "manutenção sanduba norte shopping", { pagador: "GELATO COMERCIO" }).resultado, RESULTADO_UNIDADE.NAO_HABILITADA);
  // revalidação da proposta INTERCOMPANY: mesmas devedora e credora passam; credora trocada é contradição
  const prop = (credora) => ({ id: "p", unidadeId: SANDUBA, leitura: { pagador: "GELATO COMERCIO" }, comando: { credora: { unidadeId: credora } } });
  assert.equal(revalidarUnidadeDaProposta({ cfg: c, proposta: prop(GELATO), evento: { texto: "manutenção sanduba centro", grupoId: GRUPO } }).ok, true);
  assert.equal(revalidarUnidadeDaProposta({ cfg: c, proposta: prop(SANDUBA), evento: { texto: "manutenção sanduba centro", grupoId: GRUPO } }).contradiz, true);
});
