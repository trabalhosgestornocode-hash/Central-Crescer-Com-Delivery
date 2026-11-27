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

test("resposta a 'de qual unidade?' e consulta: a marca basta (marcaBasta)", () => {
  assert.equal(r("sanduba", { marcaBasta: true }).unidade?.unidadeId, SANDUBA);
  assert.equal(r("é do gelato", { marcaBasta: true }).unidade?.unidadeId, GELATO);
  // mesmo na resposta, loja não habilitada citada bloqueia
  assert.equal(r("sanduba norte shopping", { marcaBasta: true }).resultado, RESULTADO_UNIDADE.NAO_HABILITADA);
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
