// 23/11/2026 — Entregadores Próprios reformulado (Resumo: cabeçalho → indicadores da semana → acumulado → tabela) e aba
// "Cadastro de entregadores". As fixtures são SINTÉTICAS e saem do núcleo real: backend/scripts/fv2/fixturesEntregadores.mjs.
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

test("C1: aba de cadastro lista oficiais, situação de envio, número mascarado e histórico", () => {
  const h = tela(FECHADA, { aba: "cadastro" }, ctx({ cadastro: CADASTRO }));
  assert.match(h, /aria-selected="true"[^>]*>Cadastro de entregadores|Cadastro de entregadores<\/h2>/);
  assert.ok(!h.includes('class="filtros'), "a aba de cadastro não mostra o seletor de semana");
  assert.equal((h.match(/data-cad-linha/g) ?? []).length, 3);
  assert.match(h, /Apto a receber/);
  assert.match(h, /Inativo/, "Carla desativada");
  assert.match(h, /Sem WhatsApp/, "Bruno sem cadastro");
  assert.match(h, /Histórico \(2\)/);
  assert.match(h, /número trocado/);
  assert.ok(!/\d{10,}/.test(h.replace(/data-[a-z-]+="[^"]*"/g, "")), "nenhum número completo na tela");
});

test("C2: formulários certos por situação (editar, reativar, cadastrar) e rotas do MOVA", () => {
  const h = tela(FECHADA, { aba: "cadastro" }, ctx({ cadastro: CADASTRO }));
  assert.match(h, /data-acao-mova="\/api\/fv2\/acoes\/mova\/entregador-alterar"/);
  assert.match(h, /data-acao-mova-botao="\/api\/fv2\/acoes\/mova\/entregador-revogar" data-entregador="ana"/);
  assert.match(h, /data-acao-mova="\/api\/fv2\/acoes\/mova\/entregador-reativar"><input type="hidden" name="entregador" value="carla">/);
  assert.match(h, /data-acao-mova="\/api\/fv2\/acoes\/mova\/entregador">[\s\S]*value="bruno"/);
  assert.match(h, /type="reset" class="botao">Cancelar/);
  assert.match(h, /data-cad-busca/); assert.match(h, /data-cad-situacao/);
});

test("C3: sem permissão de configurar só consulta; unidade fora do MOVA não oferece cadastro", () => {
  const leitura = tela(FECHADA, { aba: "cadastro" }, ctx({ permissoes: ["financeiro_v2.registrar"], cadastro: CADASTRO }));
  assert.ok(!leitura.includes("data-acao-mova="));
  assert.match(leitura, /exige a permissão de configurar/);
  const fora = tela(FECHADA, { aba: "cadastro" }, ctx({ cadastro: { ...CADASTRO, dados: { ...CADASTRO.dados, unidadeAtendida: false } } }));
  assert.ok(!fora.includes("data-acao-mova="));
  assert.match(fora, /ainda não é atendida pelo MOVA/);
});

test("C4: cadastro carregando, com erro e sem entregadores", () => {
  assert.match(tela(FECHADA, { aba: "cadastro" }, ctx({ cadastro: null })), /Carregando o cadastro/);
  assert.match(tela(FECHADA, { aba: "cadastro" }, ctx({ cadastro: { erro: "O MOVA não está ativo agora." } })), /O MOVA não está ativo agora/);
  assert.match(tela(FECHADA, { aba: "cadastro" }, ctx({ cadastro: { dados: { cadastros: [], unidadeAtendida: true }, oficiais: { itens: [] } } })), /O cadastro aparece depois do primeiro fechamento semanal/);
});

test("C5: textos vindos do servidor são escapados", () => {
  const mal = { ...CADASTRO, dados: { ...CADASTRO.dados, cadastros: [{ ...CADASTRO.dados.cadastros[0], observacoes: "<script>x</script>" }] } };
  const h = tela(FECHADA, { aba: "cadastro" }, ctx({ cadastro: mal }));
  assert.ok(!h.includes("<script>x</script>"));
  assert.match(h, /&lt;script&gt;/);
});

test("app.js: cadastro só com a aba aberta e corpo só com os campos que cada rota aceita", () => {
  const app = readFileSync(new URL("../financeiro-v2/app.js", import.meta.url), "utf8");
  assert.match(app, /aba !== "cadastro"\) return null/);
  assert.match(app, /"\/api\/fv2\/acoes\/mova\/entregador-revogar": \["entregador"\]/);
  assert.ok(!/CAMPOS_MOVA[\s\S]{0,400}"confirmar"/.test(app.slice(app.indexOf("const CAMPOS_MOVA"), app.indexOf("const CAMPOS_MOVA") + 400)));
});
