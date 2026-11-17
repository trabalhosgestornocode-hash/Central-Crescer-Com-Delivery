// Fase 10 (doc 47) — calendário de controle de faturamento dos canais (telas). Só apresentação: o servidor entrega estados,
// valores e contagens prontos. Dados SINTÉTICOS; o teste de integração usa o PAYLOAD REAL do backend em memória.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cal from "../financeiro-v2/telasCalendarioCanais.js";
import * as can from "../financeiro-v2/telasCanais.js";
import { CONSULTAS } from "../../backend/src/modules/fv2-integracao/consultas.js";
import { ESCRITAS } from "../../backend/src/modules/fv2-integracao/escritas.js";
import { ctx as ctxBackend, montar } from "../../backend/test/financeiro-v2/helpers/cenario.js";

const arquivo = (n) => readFileSync(fileURLToPath(new URL(`../financeiro-v2/${n}`, import.meta.url)), "utf8");
const ACOES = { abrirImportacoes: true, importar: true, registrarFechamento: true, registrarFaturamentoProvisorio: true, substituirProvisorio: true, abrirConferencias: true, configurarDiasSemOperacao: true };
const SEM_ACOES = Object.fromEntries(Object.keys(ACOES).map((k) => [k, false]));
const dia = (data, extra = {}) => ({ data, diaDaSemana: new Date(`${data}T00:00:00Z`).getUTCDay(), hoje: false, futuro: false, antesDoControle: false, elegivel: true, semOperacao: null,
  estados: [], registro: null, fechamento: null, importacoes: [], pendencias: [], divergencias: [], observacoes: [], cobertura: null, ...extra });
const mes = (extra = {}, acoes = ACOES) => {
  const dias = Array.from({ length: 30 }, (_, i) => dia(`2026-11-${String(i + 1).padStart(2, "0")}`));
  for (const [data, d] of Object.entries(extra)) Object.assign(dias.find((x) => x.data === data), d);
  return { canal: "BALCAO", mes: "2026-11", hoje: "2026-11-25", controle: { inicio: "2026-11-01", origem: "ABERTURA" }, observacoes: ["Uma importação da SAIPOS pode alimentar os dois canais; cada calendário mostra só os registros do seu canal."],
    semFonteOficial: false, granularidadeDiaria: true, acoes, diasSemOperacao: { datas: [], diasDaSemana: [] },
    cobertura: null, resumo: { diasNoMes: 30, diasElegiveis: 24, comInformacao: 2, confirmados: 1, provisorios: 1, comPendencias: 2, comDivergencias: 1, semRegistro: 20, semOperacao: 0, futuros: 5 }, dias };
};
const registro = (extra = {}) => ({ vendas: 2, brutoCentavos: 12345, descontosCentavos: 0, origem: { SAIPOS: 2, MANUAL: 0 }, provisorias: { vendas: 0, valorCentavos: 0 }, semPagamento: { vendas: 0, valorCentavos: 0 },
  pagamentos: 2, taxaEstimadaCentavos: 123, liquidoEsperadoCentavos: 12222, brutoSemCalculoCentavos: 0, recebidoCentavos: null, conferencia: "AGUARDANDO_EXTRATO", ...extra });

test("grade: um dia pode ter vários estados; cada um tem ícone e texto (cor nunca é a única pista); leitor de tela recebe tudo por extenso", () => {
  const html = cal.calendarioCanal(mes({ "2026-11-05": { estados: ["FECHAMENTO_MANUAL", "IMPORTADO", "CONFERENCIA_PENDENTE", "DIVERGENCIA"], registro: registro() } }));
  const botao = html.match(/<button[^>]*data-cal-dia="2026-11-05"[\s\S]*?<\/button>/)[0];
  for (const glifo of ["▤", "⇩", "◔", "⚠"]) assert.ok(botao.includes(glifo), `ícone ${glifo}`);
  for (const rotulo of ["Fechamento manual registrado", "Relatório importado", "Conferência pendente", "Divergência encontrada"]) assert.ok(botao.includes(rotulo), rotulo);
  assert.match(botao, /aria-label="5 de [^"]*quinta-feira: Fechamento manual registrado, Relatório importado, Conferência pendente, Divergência encontrada; faturamento R\$ 123,45"/);
  assert.match(botao, /data-principal="DIVERGENCIA"/, "a borda segue o estado mais grave, mas todos os ícones aparecem");
  // Legenda com os 8 estados, cada um com ícone + nome.
  const legenda = html.match(/<ul class="legenda legenda--cal legenda--estados"[\s\S]*?<\/ul>/)[0];
  for (const e of Object.keys(cal.ESTADOS)) assert.ok(legenda.includes(cal.ESTADOS[e].glifo) && legenda.includes(cal.ESTADOS[e].rotulo), e);
  assert.equal(Object.keys(cal.ESTADOS).length, 8);
});

test("dia futuro e hoje não são 'sem registro'; dia antes do controle também não; dia sem registro elegível é dito", () => {
  const html = cal.calendarioCanal(mes({ "2026-11-25": { hoje: true, elegivel: false }, "2026-11-28": { futuro: true, elegivel: false }, "2026-11-10": { estados: ["SEM_REGISTRO"] } }));
  const de = (d) => html.match(new RegExp(`<button[^>]*data-cal-dia="${d}"[\\s\\S]*?</button>`))[0];
  assert.match(de("2026-11-25"), /hoje, ainda em andamento/);
  assert.match(de("2026-11-28"), /dia futuro, ainda não cobrado/);
  assert.doesNotMatch(de("2026-11-28"), /Sem registro/);
  assert.match(de("2026-11-10"), /Sem registro/);
  assert.match(html, /Hoje e dias futuros nunca são considerados atrasados/);
});

test("resumo: as seis contagens vêm do servidor e a tela não calcula", () => {
  const html = cal.calendarioCanal(mes());
  const r = html.match(/<section class="resumo resumo--calendario"[\s\S]*?<\/section>/)[0];
  for (const t of ["Dias com informação", "Faturamento confirmado", "Dados provisórios", "Com pendências", "Com divergências", "Sem registro"]) assert.ok(r.includes(t), t);
  assert.match(r, /24 dia\(s\) cobrados/);
  assert.match(r, /5 futuro\(s\) não cobrado\(s\)/);
  const fonte = arquivo("telasCalendarioCanais.js");
  assert.ok(!/reduce\(|Centavos\s*[+\-*\/]\s*\w+Centavos|\.filter\([^)]*\)\.length/.test(fonte), "nenhuma conta com dinheiro nem contagem própria no frontend");
});

test("seleção, teclado e navegação: um só dia focável (tabindex), aria-pressed, botões de mês e 'Hoje'", () => {
  const html = cal.calendarioCanal(mes({ "2026-11-25": { hoje: true } }), { selecionado: "2026-11-12" });
  assert.equal((html.match(/data-cal-dia="[^"]+"[^>]*tabindex="0"/g) ?? []).length, 1, "um único dia com tabindex 0 (o selecionado)");
  assert.match(html, /data-cal-dia="2026-11-12"[^>]*aria-pressed="true"/);
  assert.match(html, /data-mes="-1"[^>]*aria-label="Mês anterior"/);
  assert.match(html, /data-mes="1"[^>]*aria-label="Próximo mês"/);
  assert.match(html, /data-cal-hoje/);
  assert.match(html, /role="grid"/);
  assert.match(html, /Use as setas do teclado/);
  const semSel = cal.calendarioCanal(mes({ "2026-11-25": { hoje: true } }));
  assert.match(semSel, /data-cal-dia="2026-11-25"[^>]*tabindex="0"/, "sem seleção, o foco entra pelo dia de hoje");
  const app = arquivo("app.js");
  for (const tecla of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) assert.ok(app.includes(tecla), tecla);
});

test("painel do dia (SAIPOS): origem, importações com link, valores, conferência, pendências, divergências e ações do perfil", () => {
  const c = mes({ "2026-11-05": { estados: ["IMPORTADO", "CONFERENCIA_PENDENTE", "DIVERGENCIA"], registro: registro({ recebidoCentavos: 5000, conferencia: "DIVERGENTE" }),
    importacoes: [{ id: "imp-1", tipoRelatorio: "SAIPOS_VENDAS", periodoInicio: "2026-11-01", periodoFim: "2026-11-15", estado: "IMPORTADO" }],
    pendencias: [{ codigo: "TAXA_NAO_CONFIGURADA", quantidade: 2, mensagem: "2 pagamento(s) sem taxa configurada." }], divergencias: [{ codigo: "RECEBIDO_DIFERENTE_DO_ESPERADO", diferencaCentavos: -50, mensagem: "O recebido confirmado é diferente do líquido esperado." }],
    fechamento: { caixas: 2, situacao: "DIVERGENTE", linhasDivergentes: 1, linhasSoDeUmLado: 0 } } });
  const painel = cal.diaDoCanal(c.dias.find((d) => d.data === "2026-11-05"), c);
  for (const t of ["SAIPOS — Presencial", "quinta-feira, 05/11/2026", "Relatório SAIPOS", "Vendas por período (por pedido)", 'data-detalhe="documento:imp-1"', "R$ 123,45", "Divergente", "2 pagamento(s) sem taxa configurada.", "Pendências", "Divergências", "2 caixa(s) com fechamento manual"]) assert.ok(painel.includes(t), t);
  for (const a of ["vendas", "importacoes", "fechamentos", "conferencias"]) assert.match(painel, new RegExp(`data-cal-acao="${a}"`));
  assert.doesNotMatch(painel, /data-cal-acao="provisorio"/, "dia com relatório da SAIPOS não oferece faturamento provisório");
  assert.match(painel, /Não calculada|Taxa estimada/);
});

test("ações de escrita só para quem pode: sem permissão não há botão de registrar, provisório nem marcar sem operação", () => {
  const dados = { "2026-11-06": { estados: ["SEM_REGISTRO"] } };
  const leitor = mes(dados, { ...SEM_ACOES, abrirImportacoes: true, abrirConferencias: true });
  const painel = cal.diaDoCanal(leitor.dias.find((d) => d.data === "2026-11-06"), leitor);
  assert.doesNotMatch(painel, /data-cal-acao="provisorio"|data-cal-acao="fechamentos"|sem-operacao|Marcar sem operação/);
  assert.match(painel, /data-cal-acao="importacoes"/);
  const admin = mes(dados);
  const painelAdmin = cal.diaDoCanal(admin.dias.find((d) => d.data === "2026-11-06"), admin);
  assert.match(painelAdmin, /data-cal-acao="provisorio"/);
  assert.match(painelAdmin, /data-acao="\/api\/fv2\/acoes\/calendario-faturamento\/sem-operacao"/);
  assert.match(painelAdmin, /name="confirmar" required/, "confirmação obrigatória");
  assert.match(painelAdmin, /name="justificativa"[^>]*required/);
  assert.doesNotMatch(cal.calendarioCanal(leitor), /class="card cal-config"/, "sem marcações e sem permissão, não há bloco de configuração");
});

test("iFood: demonstrativo cobre um período; a tela não mostra valor por dia e explica que o detalhe diário depende do relatório de pedidos", () => {
  const periodo = { id: "d1", periodoInicio: "2026-11-01", periodoFim: "2026-11-15", brutoCentavos: 100000, comissoesCentavos: 10000, taxasCentavos: 2000, repassePrevistoCentavos: 67050, repasseRecebidoCentavos: 0, saldoAReceberCentavos: 67050, dataPrevista: null, situacaoRepasse: "PREVISTO" };
  const dias = {};
  for (let i = 1; i <= 15; i += 1) dias[`2026-11-${String(i).padStart(2, "0")}`] = { estados: ["IMPORTADO", "CONFERENCIA_PENDENTE"], registro: null, cobertura: { granularidadeDiaria: false, periodos: [periodo], mensagem: "Período coberto por demonstrativo oficial do iFood. O detalhamento diário depende do relatório oficial de pedidos: nenhum valor é repartido por dia." },
    pendencias: [{ codigo: "REPASSE_PREVISTO", quantidade: 1, mensagem: "Repasse do período 2026-11-01 a 2026-11-15: previsto." }] };
  const c = { ...mes(dias, { ...SEM_ACOES, abrirConferencias: true }), canal: "IFOOD", granularidadeDiaria: false, cobertura: [periodo], observacoes: ["Somente o demonstrativo oficial do iFood. Ele cobre períodos: os valores não são repartidos por dia."] };
  const html = cal.calendarioCanal(c);
  const celula = html.match(/<button[^>]*data-cal-dia="2026-11-08"[\s\S]*?<\/button>/)[0];
  assert.doesNotMatch(celula, /cal-valor|R\$/, "nenhum valor diário na célula");
  const painel = cal.diaDoCanal(c.dias.find((d) => d.data === "2026-11-08"), c);
  assert.match(painel, /depende do relatório oficial de pedidos/);
  assert.match(painel, /Valores do PERÍODO inteiro, não deste dia/);
  assert.match(painel, /Demonstrativo oficial do iFood/);
  assert.doesNotMatch(painel, /data-cal-acao="provisorio"|Registrar faturamento/, "iFood não tem faturamento manual");
  assert.match(painel, /href="#\/contas-a-receber"/);
});

test("99Food: sem relatório oficial, o dia aparece sem dados e nunca como zero confirmado", () => {
  const c = { ...mes({ "2026-11-10": { estados: ["SEM_REGISTRO"], observacoes: ["Nenhum relatório oficial da 99Food importado: o dia aparece sem dados (não é zero confirmado)."] } }), canal: "NOVENTA_E_NOVE_FOOD", semFonteOficial: true, granularidadeDiaria: false };
  const html = cal.calendarioCanal(c);
  assert.doesNotMatch(html.match(/<button[^>]*data-cal-dia="2026-11-10"[\s\S]*?<\/button>/)[0], /R\$ 0|Sem movimento/);
  const painel = cal.diaDoCanal(c.dias.find((d) => d.data === "2026-11-10"), c);
  assert.match(painel, /isso não é zero confirmado/);
  assert.match(painel, /Relatório oficial da 99Food \(ainda não importado\)/);
  assert.doesNotMatch(painel, /R\$ 0,00/);
});

test("dias sem operação: marcado por data aparece como tal, com justificativa e a opção de voltar a operar; por dia da semana aponta para a configuração", () => {
  const c = mes({ "2026-11-04": { estados: ["SEM_MOVIMENTO_CONFIRMADO"], elegivel: false, semOperacao: { origem: "DATA", justificativa: "Loja fechada por manutenção", em: "x" } },
    "2026-11-08": { estados: ["SEM_MOVIMENTO_CONFIRMADO"], elegivel: false, semOperacao: { origem: "DIA_DA_SEMANA", justificativa: "Não abre aos domingos", em: "x" } } });
  c.diasSemOperacao = { datas: [{ data: "2026-11-04", justificativa: "Loja fechada por manutenção" }], diasDaSemana: [{ dia: 0, justificativa: "Não abre aos domingos" }] };
  const porData = cal.diaDoCanal(c.dias.find((d) => d.data === "2026-11-04"), c);
  assert.match(porData, /Loja fechada por manutenção/);
  assert.match(porData, /name="situacao" value="OPERA"/);
  const porSemana = cal.diaDoCanal(c.dias.find((d) => d.data === "2026-11-08"), c);
  assert.match(porSemana, /Marcado para este dia da semana \(domingo\)/);
  assert.doesNotMatch(porSemana, /name="situacao" value="OPERA"/);
  const html = cal.calendarioCanal(c);
  assert.match(html, /<summary><strong>Dias sem operação<\/strong> — 2 marcação\(ões\)/);
  assert.match(html, /Todo\(a\) domingo/);
});

test("erro ao carregar o calendário aparece só nele (a tela do canal continua) e sem dados não renderiza nada", () => {
  assert.match(cal.calendarioCanal(null, { erro: "Não foi possível carregar o calendário deste canal." }), /role="alert"[^>]*>Não foi possível carregar o calendário/);
  assert.equal(cal.calendarioCanal(null), "");
});

test("integração das telas: SAIPOS (Presencial e Anota Aí), iFood e 99Food recebem o calendário; as demais abas não", () => {
  const c = mes({ "2026-11-05": { estados: ["IMPORTADO"], registro: registro() } });
  const dadosSaipos = { periodoInicio: "2026-11-01", periodoFim: "2026-11-12", canais: {}, cards: {}, importacoes: [], propostas: { abertas: 0 }, soConferencia: {}, divergencias: [] };
  const f = (aba) => ({ aba, inicio: "2026-11-01", fim: "2026-11-12" });
  assert.match(can.saipos(dadosSaipos, f("presencial"), { calendario: c, permissoes: [] }), /data-cal-canal="BALCAO"/);
  assert.match(can.saipos(dadosSaipos, f("anota"), { calendario: { ...c, canal: "ANOTA_AI" }, permissoes: [] }), /data-cal-canal="ANOTA_AI"/);
  for (const aba of ["resumo", "importacoes", "fechamento", "conferencias"]) assert.doesNotMatch(can.saipos(dadosSaipos, f(aba), { calendario: c, permissoes: [] }), /data-cal-canal/, aba);
  const plataforma = (canal, calendario) => can.plataforma({ canal, competencia: "2026-11", situacao: "PRELIMINAR", totais: null, historico: [], pendencias: [], conferenciaSaipos: null, ...(canal === "NOVENTA_E_NOVE_FOOD" ? { dependeDeRelatorioOficial: true } : {}) }, { calendario, permissoes: [] });
  assert.match(plataforma("IFOOD", { ...c, canal: "IFOOD" }), /data-cal-canal="IFOOD"/);
  assert.match(plataforma("NOVENTA_E_NOVE_FOOD", { ...c, canal: "NOVENTA_E_NOVE_FOOD" }), /data-cal-canal="NOVENTA_E_NOVE_FOOD"/);
});

test("arquitetura: UMA consulta mensal por canal (nunca uma por dia) e nenhum cálculo de dinheiro nas telas", () => {
  const app = arquivo("app.js");
  assert.equal((app.match(/calendario-faturamento\?/g) ?? []).length, 1, "uma só montagem da consulta do calendário");
  assert.match(app, /mes: estado\.competencia/);
  const trechoDoDia = app.slice(app.indexOf("function selecionarDiaDoCanal"), app.indexOf("function navegarNoCalendario"));
  assert.ok(!/consultar\(|fetch\(/.test(trechoDoDia), "escolher um dia não consulta o servidor");
  for (const f of ["telasCalendarioCanais.js", "telasCanais.js", "app.js"]) assert.ok(!/reduce\(|Centavos\s*[+-]\s*\w+Centavos/.test(arquivo(f)), `${f} calcula dinheiro`);
});

test("responsividade: grade de 7 colunas que encolhe, regra de celular e nenhuma largura fixa que force rolagem horizontal", () => {
  const css = arquivo("fv2.css");
  assert.match(css, /\.calendario \{ display: grid; grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/);
  const bloco = css.slice(css.indexOf("calendário de faturamento dos canais"), css.indexOf("@media (max-width: 760px) {", css.indexOf("calendário de faturamento dos canais")));
  assert.match(bloco, /@media \(max-width: 640px\)/);
  assert.doesNotMatch(bloco, /(?:^|[^-])width: \d{3,}px/, "sem largura fixa grande");
  assert.match(bloco, /\.cal-dia--canal:focus-visible \{ outline: 2px solid var\(--foco\)/, "foco visível");
});

test("payload REAL do backend renderiza nas quatro áreas sem texto de erro e sem valor inventado", async () => {
  const c = ctxBackend();
  const { nucleo: n } = montar({ relogio: () => new Date("2026-11-25T15:00:00.000Z") });
  await ESCRITAS["/configuracoes/unidade"].fazer(n, c, { nomeExibicao: "Unidade sintética", justificativa: "Teste." });
  await ESCRITAS["/faturamento-manual/registrar"].fazer(n, c, { data: "2026-11-06", caixa: "1", canal: "BALCAO", justificativa: "Sem relatório ainda (sintético)", din_vendas: "50,00" });
  await ESCRITAS["/fechamento-manual/registrar"].fazer(n, c, { data: "2026-11-05", caixa: "1", din_abertura: "100,00", din_vendas: "50,00", din_informado: "150,00" });
  for (const canal of ["BALCAO", "ANOTA_AI", "IFOOD", "NOVENTA_E_NOVE_FOOD"]) {
    const dados = await CONSULTAS["/calendario-faturamento"](n, c, { canal, mes: "2026-11" });
    const html = cal.calendarioCanal(dados, { selecionado: "2026-11-06" });
    assert.match(html, new RegExp(`data-cal-canal="${canal}"`));
    assert.equal((html.match(/data-cal-dia=/g) ?? []).length, 30);
    assert.doesNotMatch(html, /undefined|NaN|\[object/);
  }
  const presencial = cal.calendarioCanal(await CONSULTAS["/calendario-faturamento"](n, c, { canal: "BALCAO", mes: "2026-11" }), { selecionado: "2026-11-06" });
  assert.match(presencial, /Faturamento provisório/);
  assert.match(presencial, /Fechamento manual registrado/);
});
