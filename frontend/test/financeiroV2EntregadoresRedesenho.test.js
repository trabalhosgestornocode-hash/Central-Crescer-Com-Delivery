// 23/11/2026 — Entregadores Próprios reformulado (Resumo: cabeçalho → indicadores da semana → acumulado → tabela) e aba
// "Informações dos entregadores" (sem cadastro paralelo). As fixtures são SINTÉTICAS e saem do núcleo real: backend/scripts/fv2/fixturesEntregadores.mjs.
// Rodar: node --test frontend/test/financeiroV2EntregadoresRedesenho.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as ent from "../financeiro-v2/telasEntregadores.js";

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const FECHADA = fx("entregadores-fechada");
const AGUARDANDO = fx("entregadores-aguardando");
const CADASTRO = fx("entregadores-cadastro");
const TODAS = ["registrar", "configurar", "conciliar", "aprovar", "ver"].map((a) => `financeiro_v2.${a}`);
const ctx = (extra = {}) => ({ permissoes: TODAS, unidadeNome: "Loja Sintética", ...extra });
const tela = (r, f = {}, c = ctx()) => ent.entregadoresProprios(r, { aba: "resumo", ...f }, c);

test("R1: cabeçalho operacional mostra unidade, semana, situação e as três datas do ciclo", () => {
  const h = tela(FECHADA);
  assert.match(h, /class="card ent-cabeca"/);
  assert.match(h, /Loja Sintética/);
  assert.match(h, /Semana 09 a 15\/11\/2026/);
  for (const t of ["Demonstrativo", "Prazo da nota", "Vencimento"]) assert.ok(h.includes(t), t);
  assert.ok(!h.includes('data-aba-canal="fechamento">Fechar semana'), "semana fechada não oferece fechar");
});

test("R2: indicadores da semana trazem período e origem; o acumulado fica separado e rotulado", () => {
  const h = tela(FECHADA);
  const [daSemana, acumulado] = h.split('aria-label="Acumulado em aberto de todas as semanas"');
  assert.ok(acumulado, "há bloco do acumulado");
  for (const t of ["Total devido", "Total pago", "Saldo em aberto", "Entregadores", "Aguardando nota fiscal", "Documentos em análise", "Liberado para pagamento", "Vencido"]) assert.ok(daSemana.includes(t), t);
  assert.ok((daSemana.match(/ent-kpi__periodo">Semana 09 a 15\/11\/2026/g) ?? []).length === 8, "cada indicador diz o período");
  assert.ok((daSemana.match(/class="ent-dica"/g) ?? []).length >= 8, "cada indicador explica a origem");
  assert.match(acumulado, /Todas as semanas em aberto/);
  assert.ok(daSemana.includes("R$ 110,00"), "total devido da semana vem do servidor");
});

test("R3: tabela operacional tem as colunas pedidas e linha expansível com a composição", () => {
  const h = tela(FECHADA);
  for (const c of ["Entregador", "Entregas", "Taxas", "Extras", "Total devido", "Nota fiscal", "Conferência", "Liberação", "Pagamento", "Ações"]) assert.ok(h.includes(`<th scope="col"${c === "Entregador" ? ' class="esquerda"' : ""}>${c}</th>`), c);
  assert.equal((h.match(/<details class="ent-comp">/g) ?? []).length, 3);
  assert.match(h, /Taxas por dia \(Foody\)/);
  assert.match(h, /Serviços extras/, "o extra da Ana aparece na composição");
  assert.match(h, /data-rotulo="Nota fiscal"/, "rótulos para o modo cartão no celular");
});

test("R4: semana sem fechamento oficial avisa, não inventa conta e só oferece fechar a quem pode", () => {
  const h = tela(AGUARDANDO);
  assert.match(h, /sem fechamento oficial/);
  assert.match(h, /data-aba-canal="fechamento">Fechar semana/);
  assert.match(h, /Sem fechamento/, "linhas sem conta a pagar");
  const semPermissao = tela(AGUARDANDO, {}, ctx({ permissoes: [] }));
  assert.ok(!semPermissao.includes(">Fechar semana</button>"));
  assert.match(semPermissao, /Peça a quem tem permissão de registrar/);
});

test("R5: estados vazios informativos", () => {
  const vazia = { ...AGUARDANDO, resumoSemana: { ...AGUARDANDO.resumoSemana, porEntregador: [] }, semana: { ...AGUARDANDO.semana, situacao: "EM_ANDAMENTO" } };
  assert.match(tela(vazia), /Ainda não há entrega elegível nesta semana/);
  const semFonte = { ...vazia, semana: { ...vazia.semana, situacao: "AGUARDANDO_FECHAMENTO", fonteDisponivel: false } };
  assert.match(tela(semFonte), /Sem dados do Foody para esta semana/);
});

const info = (c = CADASTRO, extra = {}, r = FECHADA) => tela(r, { aba: "informacoes" }, ctx({ cadastro: c, ...extra }));
const linha = (h, nome) => h.split('<li class="ent-info"').find((x) => x.includes(`<strong>${nome}</strong>`)) ?? "";

test("I1: 'Informações dos entregadores' lista os entregadores CONHECIDOS (fechamentos + Foody sem fechamento), sem cadastro de entregador", () => {
  const h = info();
  assert.match(h, /Informações dos entregadores<\/h2>/);
  assert.ok(!/Cadastro de entregadores|Cadastrar WhatsApp|>Cadastrar</.test(h), "nenhum fluxo de criar entregador");
  assert.ok(!h.includes('class="filtros'), "sem seletor de semana nesta aba");
  assert.equal((h.match(/data-cad-linha/g) ?? []).length, 5, "Ana, Ana (homônima), Bruno, Carla e Dani");
  assert.match(linha(h, "Dani Sintética"), /Identificado no Foody · sem fechamento/, "entregador só da semana 16–22/11 já aparece");
  assert.match(linha(h, "Dani Sintética"), /Nenhum fechamento oficial ainda: nenhuma conta foi criada/);
  assert.equal((h.match(/Nome repetido/g) ?? []).length, 2, "homônimos sinalizados, nunca juntados");
});

test("I2: seções por entregador (dados e contato, fechamentos, notas e pagamentos, histórico) e situação do contato", () => {
  const ana = linha(info(), "Ana Sintética");
  for (const t of ["Dados e contato", "Semanas e fechamentos", "Notas fiscais e pagamentos", "Histórico de alterações"]) assert.ok(ana.includes(`<h3>${t}</h3>`), t);
  assert.match(ana, /Apto a receber/);
  assert.match(ana, /09\/11\/2026 · fechada/);
  assert.match(ana, /23\/11\/2026 · sem fechamento/, "semana só com atividade do Foody não aparece como fechada");
  assert.match(ana, /<dt>Unidade<\/dt><dd>Loja Sintética<\/dd>/);
  assert.match(ana, /data-detalhe="entregador-pessoa:ana"/, "reutiliza o painel oficial de notas/fechamentos/pagamentos");
  assert.match(ana, /número trocado/);
  assert.match(linha(info(), "Carla Sintética"), /Contato desativado/);
  assert.match(linha(info(), "Bruno Sintético"), /Sem WhatsApp/);
  assert.ok(!/\d{10,}/.test(info().replace(/data-[a-z-]+="[^"]*"/g, "")), "nenhum número completo na tela");
});

test("I3: WhatsApp como atributo: adicionar, editar (salvar/cancelar), desativar só o contato e reativar", () => {
  const h = info();
  assert.match(linha(h, "Bruno Sintético"), /data-acao-mova="\/api\/fv2\/acoes\/mova\/entregador">[\s\S]*value="bruno"[\s\S]*>Adicionar WhatsApp</);
  assert.match(linha(h, "Dani Sintética"), />Adicionar WhatsApp</, "pode receber número antes do fechamento");
  const ana = linha(h, "Ana Sintética");
  assert.match(ana, /entregador-alterar/); assert.match(ana, />Salvar</); assert.match(ana, /type="reset" class="botao">Cancelar/);
  assert.match(ana, /data-acao-mova-botao="\/api\/fv2\/acoes\/mova\/entregador-revogar" data-entregador="ana">Desativar contato para mensagens/);
  assert.match(ana, /não desativa o entregador no Financeiro/);
  assert.match(linha(h, "Carla Sintética"), /entregador-reativar"><input type="hidden" name="entregador" value="carla">/);
  assert.match(h, /data-cad-busca/); assert.match(h, /data-cad-situacao/);
});

test("I4: sem permissão de configurar só consulta; unidade fora do MOVA lista os entregadores sem oferecer WhatsApp", () => {
  const leitura = info(CADASTRO, { permissoes: ["financeiro_v2.ver", "financeiro_v2.registrar"] });
  assert.ok(!leitura.includes("data-acao-mova="));
  assert.match(leitura, /exige a permissão de configurar/);
  const fora = info({ ...CADASTRO, dados: { ...CADASTRO.dados, unidadeAtendida: false } });
  assert.ok(!fora.includes("data-acao-mova="));
  assert.equal((fora.match(/data-cad-linha/g) ?? []).length, 5);
  assert.match(fora, /ainda não é atendida pelo MOVA/);
});

test("I5: MOVA fora do ar: os entregadores continuam listados (pela consulta da semana); só o WhatsApp fica indisponível", () => {
  const h = info({ erro: "O MOVA não está ativo agora." }, {}, AGUARDANDO);
  assert.match(h, /O MOVA não está ativo agora\. Os entregadores continuam listados/);
  assert.ok((h.match(/data-cad-linha/g) ?? []).length >= 3);
  assert.match(h, /MOVA indisponível/);
  assert.ok(!h.includes("data-acao-mova="));
  assert.match(info(null), /Carregando as informações dos entregadores/);
  assert.match(info({ dados: { cadastros: [], unidadeAtendida: true }, oficiais: { itens: [] } }), /aparecem assim que o Foody registrar entregas/);
});

test("I6: textos vindos do servidor são escapados", () => {
  const mal = { ...CADASTRO, dados: { ...CADASTRO.dados, cadastros: [{ ...CADASTRO.dados.cadastros[0], observacoes: "<script>x</script>" }] } };
  const h = info(mal);
  assert.ok(!h.includes("<script>x</script>"));
  assert.match(h, /&lt;script&gt;/);
});

test("app.js: informações só com a aba aberta; corpo só com os campos que cada rota aceita; lista não some sem o MOVA", () => {
  const app = readFileSync(new URL("../financeiro-v2/app.js", import.meta.url), "utf8");
  assert.match(app, /aba !== "informacoes"\) return null/);
  assert.match(app, /"\/api\/fv2\/acoes\/mova\/entregador-revogar": \["entregador"\]/);
  assert.match(app, /oficiais: ro\.ok \? ro\.dados : null/);
  assert.ok(!/CAMPOS_MOVA[\s\S]{0,400}"confirmar"/.test(app.slice(app.indexOf("const CAMPOS_MOVA"), app.indexOf("const CAMPOS_MOVA") + 400)));
});

test("23/11 Informações: as DUAS consultas da aba usam consultores DIFERENTES (o mesmo consultor abortaria a 1ª e a tela ficaria em 'Carregando')", async () => {
  const { criarConsultor } = await import("../financeiro-v2/consulta.js");
  const lento = (url) => new Promise((ok) => setTimeout(() => ok({ ok: true, status: 200, json: async () => ({ ok: true, dados: { url } }), headers: { get: () => "application/json" } }), 5));
  // o defeito: no MESMO consultor, a 1ª consulta paralela vira obsoleta (null)
  const um = criarConsultor(lento, { usarCache: false });
  const [a, b] = await Promise.all([um.consultar("/x/contatos"), um.consultar("/x/oficiais")]);
  assert.equal(a, null);
  assert.ok(b);
  // a correção: um consultor por consulta
  const app = readFileSync(new URL("../financeiro-v2/app.js", import.meta.url), "utf8");
  assert.match(app, /const consultorOficiais = criarConsultor\(\);/);
  assert.match(app, /Promise\.all\(\[consultorCadastro\.consultar\(urlsDoCadastro\[0\], cabecalhos\(\)\), consultorOficiais\.consultar\(urlsDoCadastro\[1\], cabecalhos\(\)\)\]\)/);
  assert.ok(!/urlsDoCadastro\.map\(\(u\) => consultorCadastro/.test(app));
});
