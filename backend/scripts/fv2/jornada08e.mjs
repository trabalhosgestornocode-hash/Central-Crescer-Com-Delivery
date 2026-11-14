#!/usr/bin/env node
// JORNADA FULL STACK da Execução 08E — navegador (Playwright) → serviço → gateway → PostgreSQL ISOLADO.
// Só dados e identidades SINTÉTICOS, só 127.0.0.1. As senhas sintéticas são lidas, em tempo de execução, do arquivo
// gerado por `node scripts/fv2-homologacao.mjs preparar` (fora do repositório); nada aqui contém segredo.
//
//   node scripts/fv2/jornada08e.mjs <etapa> [--ver]
//
// Toda ação passa pela INTERFACE (formulários, painéis, botões). As únicas chamadas diretas são as "tentativas de
// contorno" (POST forjado com o token CSRF da própria sessão), para provar que o SERVIDOR recusa o que a tela esconde.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const PASTA = process.env.FV2_HOMOLOGACAO_DIR || join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "fv2-homologacao");
const ORIGEM = `http://127.0.0.1:${Number(process.env.FV2_HOMOLOGACAO_PORTA || 5181)}`;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(ORIGEM)) throw new Error("A jornada só roda em 127.0.0.1.");
const SAIDA = process.env.FV2_JORNADA_SAIDA || join(PASTA, "jornada-08e");
mkdirSync(SAIDA, { recursive: true });

const require = createRequire(import.meta.url);
const caminhoPlaywright = process.env.FV2_PLAYWRIGHT || join(process.env.APPDATA || "", "npm", "node_modules", "@playwright", "cli", "node_modules", "playwright-core");
const { chromium } = require(caminhoPlaywright);

function credencial(login) {
  const linha = readFileSync(join(PASTA, "credenciais-sinteticas.txt"), "utf8").split(/\r?\n/).find((l) => l.startsWith(`${login}\t`));
  if (!linha) throw new Error(`Sem credencial sintética para ${login}.`);
  return { senha: /senha: ([^\t]+)/.exec(linha)[1], fator: /segundo fator: (\d+)/.exec(linha)?.[1] ?? "" };
}

const registro = [];
export const passo = (n, texto, dados = {}) => { registro.push({ n, texto, ...dados }); process.stdout.write(`[${n}] ${texto}${Object.keys(dados).length ? ` ${JSON.stringify(dados)}` : ""}\n`); };
export const exigir = (cond, msg) => { if (!cond) throw new Error(`FALHOU: ${msg}`); };

export async function abrirNavegador({ largura = 1280, altura = 900 } = {}) {
  // Usa o Chromium já instalado localmente (sem baixar nada); FV2_CHROMIUM sobrepõe.
  const base = join(process.env.LOCALAPPDATA || "", "ms-playwright");
  const candidatos = [process.env.FV2_CHROMIUM, join(base, "chromium_headless_shell-1248", "chrome-headless-shell-win64", "chrome-headless-shell.exe"), join(base, "chromium-1248", "chrome-win64", "chrome.exe")].filter(Boolean);
  const executablePath = candidatos.find((c) => existsSync(c));
  const navegador = await chromium.launch({ headless: !process.argv.includes("--ver"), ...(executablePath ? { executablePath } : {}) });
  return navegador;
}

export async function entrar(navegador, login, viewport = { width: 1280, height: 900 }) {
  const ctx = await navegador.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => passo("!", `erro de página: ${e.message}`));
  await page.goto(`${ORIGEM}/entrar`);
  const c = credencial(login);
  await page.getByLabel("Usuário").fill(login);
  await page.getByLabel("Senha").fill(c.senha);
  if (c.fator) await page.getByLabel(/Segundo fator/).fill(c.fator);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(`${ORIGEM}/`);
  await page.locator("#conteudo h1").first().waitFor();
  return page;
}

/** Espera a tela terminar de carregar (o conteúdo troca e não há "Carregando"). */
export async function aguardar(page) {
  await page.waitForFunction(() => { const c = document.querySelector("#conteudo"); return c && !c.getAttribute("aria-busy") && !/Carregando/.test(c.textContent ?? ""); }, null, { timeout: 30000 });
  await page.waitForTimeout(150);
}

export async function irPara(page, rota, competencia) {
  if (competencia) {
    const atual = await page.locator("#filtro-competencia").inputValue();
    if (atual !== competencia) {
      await page.locator("#filtro-competencia").fill(competencia);
      await page.locator("#filtro-competencia").dispatchEvent("change");
      await aguardar(page);
    }
  }
  await page.evaluate((r) => { location.hash = r; }, rota);
  await aguardar(page);
}

export const painel = (page) => page.locator("#painel");
export async function abrirDetalhe(page, nome, { dentro = "#conteudo", exato = false } = {}) {
  await page.locator(dentro).getByRole("button", { name: nome, exact: exato }).first().click();
  await painel(page).waitFor({ state: "visible" });
  await page.waitForFunction(() => !/Carregando/.test(document.querySelector("#painel .painel-conteudo")?.textContent ?? "Carregando"));
  await page.waitForTimeout(150);
}
export async function fecharPainel(page) {
  if (await painel(page).isVisible()) { await page.locator("#painel [data-fechar-painel]").first().click(); await aguardar(page); }
}

/**
 * Preenche e envia um formulário de AÇÃO (com a caixa de confirmação). Devolve a resposta do SERVIDOR (status e corpo),
 * lida da rede — o painel é redesenhado depois da ação e o texto do resultado some.
 */
export async function enviarAcao(form, campos = {}, { selecionarPorTexto = {} } = {}) {
  for (const [nome, valor] of Object.entries(campos)) {
    const el = form.locator(`[name="${nome}"]`);
    const tag = await el.evaluate((x) => x.tagName);
    if (tag === "SELECT") await el.selectOption(valor); else await el.fill(String(valor));
  }
  for (const [nome, re] of Object.entries(selecionarPorTexto)) {
    const opcoes = await form.locator(`select[name="${nome}"] option`).evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent })));
    const alvo = opcoes.find((o) => o.v && re.test(o.t));
    if (!alvo) throw new Error(`FALHOU: nenhuma opção ${re} em ${nome}: ${opcoes.map((o) => o.t).join(" | ")}`);
    await form.locator(`select[name="${nome}"]`).selectOption(alvo.v);
  }
  await form.locator('input[name="confirmar"]').check();
  const page = form.page();
  const url = await form.getAttribute("data-acao");
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(url), { timeout: 30000 }),
    form.locator('button[type="submit"]').click(),
  ]);
  const corpo = await resp.json().catch(() => ({}));
  await page.waitForTimeout(600);
  await aguardar(page);
  if (await painel(page).isVisible()) await page.waitForFunction(() => !/Carregando/.test(document.querySelector("#painel .painel-conteudo")?.textContent ?? ""));
  return { status: resp.status(), corpo };
}

/** POST forjado com o CSRF da própria sessão: só para provar que o servidor recusa o que a tela não oferece. */
export async function forjar(page, rota, corpo) {
  return page.evaluate(async ({ rota, corpo }) => {
    const unidade = document.querySelector("#filtro-unidade")?.value;
    const s = await (await fetch(`/api/fv2/sessao?unidade=${unidade}`)).json();
    const r = await fetch(rota, { method: "POST", headers: { "content-type": "application/json", "x-fv2-csrf": s.csrf }, body: JSON.stringify({ unidade, confirmar: true, ...corpo }) });
    return { status: r.status, corpo: await r.json().catch(() => ({})) };
  }, { rota, corpo });
}
/** Leitura (GET) pela sessão do navegador, para conferir números que a tela mostra. */
export async function ler(page, rota, params = {}) {
  return page.evaluate(async ({ rota, params }) => {
    const unidade = document.querySelector("#filtro-unidade")?.value;
    const r = await fetch(`${rota}?${new URLSearchParams({ unidade, ...params })}`);
    return r.json();
  }, { rota, params });
}
export async function foto(page, nome) { await page.screenshot({ path: join(SAIDA, `${nome}.png`), fullPage: true }); }
export const textoDe = async (loc) => ((await loc.textContent()) ?? "").replace(/\s+/g, " ").trim();
export function salvarRegistro(nome) { writeFileSync(join(SAIDA, `${nome}.json`), JSON.stringify(registro, null, 2)); }
export { ORIGEM, SAIDA, existsSync };

// ------------------------------------------------------------------------------------------------- etapa: explorar
async function explorar() {
  const nav = await abrirNavegador();
  const page = await entrar(nav, "administrador");
  await irPara(page, "#/conferencias?secao=fechamento", "2026-10");
  process.stdout.write(`${(await textoDe(page.locator("#conteudo"))).slice(0, 6000)}\n`);
  await nav.close();
}

// ------------------------------------------------------------------------------------------------ apoio comum
const OUT = "2026-10";
const NOV = "2026-11";
const FECH = "#/conferencias?secao=fechamento";
const acaoFechamento = (page, rotulo) => page.locator("article.acao-fechamento", { has: page.getByRole("heading", { name: rotulo, exact: true }) });
const avaliacao = (page, competencia = OUT) => ler(page, "/api/fv2/conferencias/fechamento", { competencia }).then((f) => ({ estado: f.estado, contagem: f.avaliacaoDasPendencias.contagem, motivos: f.avaliacaoDasPendencias.motivos }));

/** Retrato dos números que NÃO podem duplicar: DRE, banco (outubro), fluxo realizado e previsto. */
async function retrato(page) {
  const dre = await ler(page, "/api/fv2/dre", { competencia: OUT });
  const linha = (cod) => dre.dre.linhas.find((l) => l.codigo === cod)?.valorCentavos ?? null;
  const cb = await ler(page, "/api/fv2/caixa-e-bancos", { inicio: "2026-10-01", fim: "2026-10-31", tamanho: 100 });
  const fl = await ler(page, "/api/fv2/fluxo-de-caixa", { inicio: "2026-10-01", fim: "2026-11-30", granularidade: "MES" });
  const banco = cb.contas.find((c) => c.tipo === "BANCARIA");
  return {
    resultado: dre.resultadoGerencial?.valorCentavos ?? dre.resultadoGerencial ?? null, despesasOperacionais: linha("DESPESAS_OPERACIONAIS"),
    movimentosOutubro: cb.paginacao?.total ?? cb.movimentos.length, saidasBancoOutubro: banco.saidasCentavos, saldoBanco: banco.saldoFinalCentavos,
    realizadoSaidas: fl.realizado.saidasCentavos, previstoSaidas: fl.previsto.saidasCentavos,
  };
}

async function tentarTransicao(page, n, rotulo, novoEstado) {
  await irPara(page, FECH, OUT);
  const art = acaoFechamento(page, rotulo);
  const existe = await art.count();
  const desabilitado = existe ? (await art.locator("button[disabled]").count()) > 0 : true;
  const bloqueio = existe ? await textoDe(art.locator(".aviso").first()).catch(() => "") : "(ação não oferecida neste estado)";
  passo(n, `Tela: "${rotulo}" indisponível`, { oferecida: existe > 0, botaoDesabilitado: desabilitado, bloqueio: bloqueio.slice(0, 320) });
  exigir(desabilitado, `a tela não pode oferecer "${rotulo}"`);
  const extra = novoEstado === "FECHAMENTO_HOMOLOGADO" ? { metodologia: "Metodologia sintética da jornada 08E." } : { justificativa: "Tentativa de contorno (sintético)." };
  const r = await forjar(page, "/api/fv2/acoes/fechamento/alterar", { competencia: OUT, novoEstado, ...extra });
  passo(`${n}b`, `Servidor: POST forjado (${novoEstado}) recusado`, { status: r.status, erro: r.corpo.erro, mensagem: String(r.corpo.mensagem).slice(0, 420) });
  exigir(r.status === 409, "o servidor precisa recusar");
  return r;
}

async function documentarPelaTela(page, titulo, { impacto, decisao, falta }) {
  await irPara(page, FECH, OUT);
  await abrirDetalhe(page, titulo, { exato: true });
  const form = painel(page).locator('form[data-acao="/api/fv2/acoes/pendencias/documentar"]');
  exigir(await form.count(), `o painel de "${titulo}" precisa oferecer documentar`);
  const campos = { decisao, documentacaoFaltante: falta };
  if (impacto) campos.impacto = impacto;
  const r = await enviarAcao(form, campos);
  await fecharPainel(page);
  return { status: r.status, situacao: r.corpo.avaliacao?.situacao ?? null, motivo: r.corpo.avaliacao?.motivo ?? r.corpo.mensagem ?? null };
}

async function abrirConta(page, texto) {
  await fecharPainel(page);
  await irPara(page, "#/contas-a-pagar", OUT);
  await page.locator("#conteudo tr", { hasText: texto }).first().getByRole("button", { name: "Detalhar" }).click();
  await painel(page).waitFor({ state: "visible" });
  await page.waitForFunction(() => !/Carregando/.test(document.querySelector("#painel .painel-conteudo")?.textContent ?? "Carregando"));
}

// --------------------------------------------------------------------- Cenário 1 (bloqueios) — outubro
async function cenario1() {
  const nav = await abrirNavegador();
  const page = await entrar(nav, "administrador");
  await irPara(page, FECH, OUT);
  passo("1.0", "Outubro antes do fechamento", await avaliacao(page));
  const r1 = await enviarAcao(acaoFechamento(page, "Iniciar fechamento preliminar").locator("form"), { justificativa: "Início do fechamento de outubro (jornada sintética 08E)." });
  passo("1.1", "Fechamento preliminar iniciado pela tela", { status: r1.status, ...(await avaliacao(page)) });
  exigir(r1.status === 200, "preliminar");
  await foto(page, "c1-01-preliminar");
  await tentarTransicao(page, "1.2", "Homologar a competência", "FECHAMENTO_HOMOLOGADO");
  await tentarTransicao(page, "1.3", "Registrar fechamento com pendências documentadas", "FECHAMENTO_COM_PENDENCIAS");
  const d1 = await documentarPelaTela(page, "Falta: Vendas da Stone", { decisao: "Homologar sem o relatório da Stone; a conferência cruzada fica como ressalva (sintético).", falta: "Relatório de vendas da Stone de outubro (sintético)." });
  passo("1.4", "Pendência admissível documentada no painel", d1);
  exigir(d1.situacao === "DOCUMENTADA_ADMISSIVEL", "relatório que falta é ressalva admissível");
  const d2 = await documentarPelaTela(page, "Despesa sem classificação", { impacto: "Nenhum, com certeza absoluta (texto persuasivo).", decisao: "Ressalvar e seguir.", falta: "Nada." });
  passo("1.5", "Bloqueante documentada com texto persuasivo continua bloqueante", d2);
  exigir(d2.situacao === "BLOQUEANTE", "o texto não torna admissível");
  await tentarTransicao(page, "1.6", "Homologar a competência", "FECHAMENTO_HOMOLOGADO");
  await tentarTransicao(page, "1.7", "Registrar fechamento com pendências documentadas", "FECHAMENTO_COM_PENDENCIAS");
  passo("1.7c", "Situação depois das tentativas", await avaliacao(page));
  await irPara(page, FECH, OUT);
  await foto(page, "c1-07-bloqueado");
  salvarRegistro("cenario1");
  await nav.close();
}

// --------------------------------------------------------------- Cenário 2 (baixa sem duplicidade) — outubro
async function cenario2() {
  const nav = await abrirNavegador();
  const page = await entrar(nav, "administrador");
  const antes = await retrato(page);
  const cb = await ler(page, "/api/fv2/caixa-e-bancos", { inicio: "2026-10-01", fim: "2026-10-31", tamanho: 100 });
  const saidaExtrato = cb.movimentos.find((m) => m.valorCentavos === 61850 && m.data === "2026-10-28" && m.sentido === "SAIDA");
  passo("2.0", "Antes: o banco JÁ contém a saída de R$ 618,50 (28/10)", { ...antes, saida: saidaExtrato ? { id: "(presente)", vinculo: saidaExtrato.vinculo?.tipo ?? null } : null });
  exigir(saidaExtrato, "a saída do extrato existe");
  await irPara(page, "#/caixa-e-bancos", OUT);
  await foto(page, "c2-00-banco-antes");
  // 1–3. Abrir a obrigação; parcelas e saldo; "Vincular pagamento do extrato".
  await abrirConta(page, "Energia (demonstração)");
  const det = await textoDe(painel(page));
  passo("2.1", "Conta de energia aberta", { explica: /não cria outra saída nem outra despesa/.test(det), saldo: /618,50/.test(det), temVincular: /Vincular pagamento do extrato/.test(det), temRegistrar: /Registrar pagamento/.test(det) });
  const formEscolha = painel(page).locator("form[data-previa-vinculo]");
  const selecionada = await formEscolha.locator('select[name="movimentacao"]').inputValue();
  const opcoes = await formEscolha.locator('select[name="movimentacao"] option').allTextContents();
  passo("2.2", "Saídas elegíveis (nada pré-selecionado)", { selecionada: selecionada || "(nenhuma)", opcoes });
  exigir(selecionada === "", "nada pré-selecionado");
  await foto(page, "c2-01-conta");
  // 4–6. Selecionar a saída; conferir valor, histórico e conciliações; evidência.
  const alvo = opcoes.findIndex((t) => /28\/10\/2026/.test(t) && /618,50/.test(t));
  exigir(alvo > 0, "a saída de 28/10 está entre as elegíveis");
  await formEscolha.locator('select[name="movimentacao"]').selectOption({ index: alvo });
  await formEscolha.getByRole("button", { name: "Ver prévia da baixa" }).click();
  await page.waitForFunction(() => /Prévia: nada foi gravado/.test(document.querySelector("#painel")?.textContent ?? ""));
  const previa = await textoDe(painel(page));
  passo("2.3", "Prévia (nada gravado)", { nadaGravado: /Prévia: nada foi gravado/.test(previa), disponivel: /Disponível para vincular/.test(previa), efeito: (previa.match(/Efeito da baixa.{0,420}/) ?? [""])[0] });
  await foto(page, "c2-02-previa");
  // 9–10. Confirmar a baixa com o comprovante.
  const formVinc = painel(page).locator('form[data-acao="/api/fv2/acoes/obrigacoes/vincular-extrato"]');
  const r = await enviarAcao(formVinc, { justificativa: "Comprovante da concessionária confere com a saída de 28/10 (sintético)." }, { selecionarPorTexto: { documento: /energia/i } });
  passo("2.4", "Baixa confirmada pela tela", { status: r.status, repetido: r.corpo.repetido ?? false, titulos: (r.corpo.titulos ?? []).map((t) => [t.situacao, t.saldoCentavos]) });
  exigir(r.status === 200, JSON.stringify(r.corpo));
  // 11–12. Liquidação, conciliação e as demais telas.
  await abrirConta(page, "Energia (demonstração)");
  const pago = await textoDe(painel(page));
  passo("2.5", "Conta paga, pagamento vinculado do extrato", { pago: /PAGO|Pago/.test(pago), vinculado: /vinculado do extrato/.test(pago), semFormVinculo: (await painel(page).locator("form[data-previa-vinculo]").count()) === 0 });
  await foto(page, "c2-03-paga");
  await fecharPainel(page);
  const depois = await retrato(page);
  passo("2.6", "Depois: nenhuma saída nova, nenhuma despesa nova", { depois, deltaPrevisto: depois.previstoSaidas - antes.previstoSaidas });
  for (const k of ["resultado", "despesasOperacionais", "movimentosOutubro", "saidasBancoOutubro", "saldoBanco", "realizadoSaidas"]) exigir(depois[k] === antes[k], `${k} não muda (${antes[k]} → ${depois[k]})`);
  exigir(antes.previstoSaidas - depois.previstoSaidas === 61850, "o previsto deixa de incluir a conta paga");
  // Repetir (11–12 do enunciado): pela tela não há mais o que vincular; um reenvio forjado não duplica.
  const corpoRep = { obrigacao: "?", movimentacao: "?" };
  const det2 = await ler(page, "/api/fv2/contas-a-pagar", { tamanho: 100 });
  const energia = det2.itens.find((x) => x.fornecedor?.nome?.startsWith("Energia"));
  const rep = await forjar(page, "/api/fv2/acoes/obrigacoes/vincular-extrato", { obrigacao: energia.id, movimentacao: saidaExtrato.id, versao: "1", valor: "618,50", justificativa: "Repetição (sintético)." });
  const depoisRep = await retrato(page);
  passo("2.7", "Repetição forjada", { status: rep.status, repetido: rep.corpo.repetido ?? null, erro: rep.corpo.erro ?? null, mensagem: String(rep.corpo.mensagem ?? "").slice(0, 200), iguais: JSON.stringify(depoisRep) === JSON.stringify(depois) });
  exigir(JSON.stringify(depoisRep) === JSON.stringify(depois), "repetir não muda nada");
  void corpoRep;
  // Central: a saída sem classificação deixou de ser pendência; conciliação mostra o vínculo.
  const av = await avaliacao(page);
  const pend = await ler(page, "/api/fv2/conferencias/pendencias", { competencia: OUT, tamanho: 100 });
  passo("2.8", "Central atualizada", { ...av, saidaSemClassificacao: pend.itens.filter((p) => p.codigo === "SAIDA_SEM_CLASSIFICACAO").length, contaEnergiaSemComprovante: pend.itens.filter((p) => p.codigo === "OBRIGACAO_SEM_COMPROVANTE" && /Energia/.test(p.titulo)).length });
  await irPara(page, "#/caixa-e-bancos", OUT);
  await foto(page, "c2-04-banco-depois");
  salvarRegistro("cenario2");
  await nav.close();
}

// --------------------------------------------------------------- sondagem da reclassificação (só leitura)
async function sondarReclassificacao() {
  const nav = await abrirNavegador();
  const page = await entrar(nav, "administrador");
  await irPara(page, FECH, OUT);
  await abrirDetalhe(page, "Despesa sem classificação", { exato: true });
  const botoes = await painel(page).locator("button").allTextContents();
  process.stdout.write(`botões: ${botoes.join(" | ")}\n`);
  const b = painel(page).getByRole("button", { name: /reclassificar/i }).first();
  if (await b.count()) {
    await b.click();
    await page.waitForTimeout(1500);
    process.stdout.write(`${(await textoDe(painel(page))).slice(0, 2500)}\n`);
    const forms = await painel(page).locator("form").evaluateAll((fs) => fs.map((f) => ({ acao: f.dataset.acao ?? f.className, campos: [...f.elements].map((e) => `${e.tagName}:${e.name}:${e.tagName === "SELECT" ? [...e.options].map((o) => o.textContent).join("/") : ""}`) })));
    process.stdout.write(`${JSON.stringify(forms, null, 1)}\n`);
  }
  await nav.close();
}

// ------------------------------------------- Cenário 1, fim: resolver a bloqueante com evidência e homologar
async function cenario1fim() {
  const nav = await abrirNavegador();
  const page = await entrar(nav, "administrador");
  const antes = await retrato(page);
  // 8. Resolver a impeditiva com evidência: reclassificar o boleto com a nota fiscal (sintética) do cofre.
  await irPara(page, FECH, OUT);
  await abrirDetalhe(page, "Despesa sem classificação", { exato: true });
  await painel(page).getByRole("button", { name: /Revisar e reclassificar/ }).click();
  await page.waitForFunction(() => /Nova categoria/.test(document.querySelector("#painel")?.textContent ?? ""));
  const escolha = painel(page).locator("form.filtros-locais", { has: page.locator('select[name="categoria"]') });
  const opcoes = await escolha.locator('select[name="categoria"] option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent })));
  await escolha.locator('select[name="categoria"]').selectOption(opcoes.find((o) => /Despesas administrativas gerais/.test(o.t)).v);
  await escolha.getByRole("button", { name: /Ver prévia/ }).click();
  await page.waitForFunction(() => document.querySelector('#painel form[data-acao*="reclassific"]'));
  const prev = await textoDe(painel(page));
  passo("1.8a", "Prévia da reclassificação", { trecho: (prev.match(/(Resultado|DRE).{0,300}/) ?? [""])[0] });
  await foto(page, "c1-08-reclassificacao-previa");
  const form = painel(page).locator('form[data-acao*="reclassific"]');
  const campos = await form.evaluate((f) => [...f.elements].map((e) => `${e.tagName}:${e.name}`));
  passo("1.8b", "Campos da confirmação", { campos });
  const r = await enviarAcao(form, { justificativa: "Nota fiscal sintética identifica o boleto: serviço de contabilidade de outubro." }, { selecionarPorTexto: { documento: /contabilidade/i } });
  passo("1.8", "Bloqueante resolvida com evidência (reclassificação)", { status: r.status, erro: r.corpo.erro ?? null, mensagem: String(r.corpo.mensagem ?? "").slice(0, 200) });
  exigir(r.status === 200, JSON.stringify(r.corpo));
  await fecharPainel(page);
  const depoisReclass = await retrato(page);
  passo("1.8c", "Efeito da reclassificação (a despesa entra na DRE; banco intacto)", { despesasAntes: antes.despesasOperacionais, despesasDepois: depoisReclass.despesasOperacionais, bancoIgual: antes.saldoBanco === depoisReclass.saldoBanco });
  // Documentar o que resta (cada uma no painel), com decisão e o que falta.
  let f = await ler(page, "/api/fv2/conferencias/fechamento", { competencia: OUT });
  passo("1.9a", "Restam", { bloqueantes: f.avaliacaoDasPendencias.bloqueantes.map((x) => x.titulo), naoDocumentadas: f.avaliacaoDasPendencias.naoDocumentadas.map((x) => x.titulo), impedimentos: f.impedimentos.map((x) => x.codigo) });
  exigir(f.avaliacaoDasPendencias.bloqueantes.length === 0 && f.impedimentos.length === 0, "sem bloqueantes nem impedimentos");
  for (const x of f.avaliacaoDasPendencias.naoDocumentadas) {
    const d = await documentarPelaTela(page, x.titulo, { decisao: "Ressalva aprovada pela gestão na jornada sintética.", falta: `Documento que falta para: ${x.titulo} (sintético).` });
    passo("1.9", `Documentada: ${x.titulo}`, d);
    exigir(d.situacao === "DOCUMENTADA_ADMISSIVEL", `${x.titulo} admissível`);
  }
  // Do preliminar, homologar direto continua indisponível: as ressalvas passam por "com pendências documentadas".
  await tentarTransicao(page, "1.10", "Homologar a competência", "FECHAMENTO_HOMOLOGADO");
  await irPara(page, FECH, OUT);
  const rc = await enviarAcao(acaoFechamento(page, "Registrar fechamento com pendências documentadas").locator("form"), { justificativa: "Restam apenas ressalvas admissíveis documentadas (sintético)." });
  passo("1.11", "Fechamento com pendências documentadas pela tela", { status: rc.status, estado: rc.corpo.estado, versao: rc.corpo.versao?.tipo });
  exigir(rc.status === 200, JSON.stringify(rc.corpo));
  // 9. Homologar com ressalva admissível.
  await irPara(page, FECH, OUT);
  await foto(page, "c1-11-com-pendencias");
  const rh = await enviarAcao(acaoFechamento(page, "Homologar a competência").locator("form"), { metodologia: "DRE gerencial sem ajuste de estoque; ressalvas: relatórios cruzados ausentes (sintético).", justificativa: "Homologação com ressalvas aprovada (sintético)." });
  passo("1.12", "Homologação com ressalvas pela tela", { status: rh.status, estado: rh.corpo.estado, versao: [rh.corpo.versao?.tipo, rh.corpo.versao?.numero, rh.corpo.versao?.comRessalvas], ressalvas: rh.corpo.homologacao?.ressalvas?.length, erro: rh.corpo.erro ?? null, mensagem: String(rh.corpo.mensagem ?? "").slice(0, 300) });
  exigir(rh.status === 200 && rh.corpo.homologacao?.comRessalvas === true, "homologada com ressalvas");
  // 10. Versão, histórico e DRE.
  f = await ler(page, "/api/fv2/conferencias/fechamento", { competencia: OUT });
  const dre = await ler(page, "/api/fv2/dre", { competencia: OUT });
  passo("1.13", "Versão, histórico e DRE", {
    estado: f.estado, registrada: { comRessalvas: f.homologacaoRegistrada?.comRessalvas, ressalvas: f.homologacaoRegistrada?.ressalvas?.map((x) => x.titulo) },
    versoes: f.versoes.map((v) => [v.numero, v.tipo, v.vigente]), historico: f.historico.map((h) => (h.evento === "DOCUMENTACAO_DE_PENDENCIA" ? "documentação" : h.para)),
    dre: { versaoHomologada: Boolean(dre.versaoHomologada), reproduz: dre.versaoHomologada?.reproduz ?? null, situacaoResultado: dre.dre.linhas.find((l) => l.codigo === "RESULTADO_GERENCIAL")?.situacao ?? null },
    pendenciasPreservadas: f.pendenciasDocumentadas.length,
  });
  await irPara(page, FECH, OUT);
  await foto(page, "c1-13-homologada");
  await irPara(page, "#/dre", OUT);
  await foto(page, "c1-14-dre");
  salvarRegistro("cenario1-fim");
  await nav.close();
}

// --------------------------------------------------------------- Cenário 3 (agrupado + concorrência) — novembro
async function abrirPreviaAgrupada(page, conta) {
  await fecharPainel(page);
  await irPara(page, "#/contas-a-pagar", NOV);
  await page.locator("#conteudo tr", { hasText: conta }).filter({ hasText: "novembro de 2026" }).first().getByRole("button", { name: "Detalhar" }).click();
  await painel(page).waitFor({ state: "visible" });
  await page.waitForFunction(() => !/Carregando/.test(document.querySelector("#painel .painel-conteudo")?.textContent ?? "Carregando"));
  const form = painel(page).locator("form[data-previa-vinculo]");
  const opcoes = await form.locator('select[name="movimentacao"] option').allTextContents();
  const i = opcoes.findIndex((t) => /PAG AGRUPADO/.test(t));
  if (i < 1) return { opcoes, aberta: false, texto: "" };
  await form.locator('select[name="movimentacao"]').selectOption({ index: i });
  await form.getByRole("button", { name: "Ver prévia da baixa" }).click();
  await page.waitForFunction(() => /Prévia: nada foi gravado/.test(document.querySelector("#painel")?.textContent ?? ""));
  return { opcoes, aberta: true, texto: await textoDe(painel(page)) };
}
async function confirmarVinculo(page, justificativa) {
  const form = painel(page).locator('form[data-acao="/api/fv2/acoes/obrigacoes/vincular-extrato"]');
  return enviarAcao(form, { justificativa }, { selecionarPorTexto: { documento: /agrupado/i } });
}
const disp = (m) => m.naoVinculadoCentavos ?? m.valorCentavos;
async function cenario3() {
  const nav = await abrirNavegador();
  const s1 = await entrar(nav, "administrador");
  const s2 = await entrar(nav, "administrador"); // segunda sessão independente (outro cookie)
  const caixaNov = () => ler(s1, "/api/fv2/caixa-e-bancos", { inicio: "2026-11-01", fim: "2026-11-30", tamanho: 100 });
  const saidaAgrupada = async () => (await caixaNov()).movimentos.find((m) => /AGRUPADO/.test(`${m.descricaoOriginal ?? ""} ${m.descricao ?? ""}`));
  const contas = async () => (await ler(s1, "/api/fv2/contas-a-pagar", { tamanho: 100 })).itens.filter((x) => /Manutenção/.test(x.descricao));
  const mov0 = await saidaAgrupada();
  const movNov0 = (await caixaNov()).paginacao.total;
  passo("3.0", "Antes: uma saída de R$ 1.000,00 e duas contas (A R$ 600,00; B R$ 400,00)", { saida: [mov0.valorCentavos, mov0.vinculo?.tipo], contas: (await contas()).map((x) => [x.descricao, x.saldoCentavos, x.situacao]) });
  // Concorrência: as duas sessões abrem a prévia da MESMA conta A com a MESMA saída e confirmam ao mesmo tempo.
  const p1 = await abrirPreviaAgrupada(s1, "Manutenção do freezer");
  const p2 = await abrirPreviaAgrupada(s2, "Manutenção do freezer");
  passo("3.1", "Duas sessões com a prévia da conta A aberta", { s1: p1.aberta, s2: p2.aberta, efeito: (p1.texto.match(/Disponível na saída.{0,60}/) ?? [""])[0] });
  const [r1, r2] = await Promise.all([confirmarVinculo(s1, "Comprovante do pagamento agrupado: parte A (sessão 1, sintético)."), confirmarVinculo(s2, "Comprovante do pagamento agrupado: parte A (sessão 2, sintético).")]);
  const resultados = [r1, r2].map((r) => ({ status: r.status, repetido: r.corpo.repetido ?? false, erro: r.corpo.erro ?? null, mensagem: String(r.corpo.mensagem ?? "").slice(0, 220) }));
  passo("3.2", "Confirmações simultâneas do MESMO vínculo (A)", { resultados });
  const vencedoras = [r1, r2].filter((r) => r.status === 200 && !r.corpo.repetido).length;
  exigir(vencedoras === 1, "exatamente uma confirmação consome a parcela; a outra é repetição sem efeito ou conflito");
  const mov1 = await saidaAgrupada();
  const cA = (await contas()).find((x) => /freezer/.test(x.descricao));
  passo("3.3", "Sem efeito parcial", { contaA: [cA.pagoCentavos, cA.saldoCentavos, cA.situacao], saidaDisponivel: disp(mov1) });
  exigir(cA.pagoCentavos === 60000 && cA.saldoCentavos === 0, "A paga uma única vez");
  exigir(disp(mov1) === 40000, "restam R$ 400,00 na saída");
  // Disputa REAL: as duas sessões querem os MESMOS R$ 400,00 restantes para contas DIFERENTES, ao mesmo tempo.
  const pB = await abrirPreviaAgrupada(s1, "Manutenção da coifa");
  const pAl = await abrirPreviaAgrupada(s2, "Aluguel da loja");
  passo("3.4", "Sessão 1 → conta B; sessão 2 → aluguel de novembro; mesma saída", {
    b: { aberta: pB.aberta, efeito: (pB.texto.match(/Disponível na saída.{0,40}/) ?? [""])[0], jaVinculado: (pB.texto.match(/Já vinculado a outras contas.{0,14}/) ?? [""])[0], historico: (pB.texto.match(/Histórico desta saída.{0,110}/) ?? [""])[0] },
    aluguel: { aberta: pAl.aberta, efeito: (pAl.texto.match(/Disponível na saída.{0,40}/) ?? [""])[0] },
  });
  const [rB, rAl] = await Promise.all([confirmarVinculo(s1, "Comprovante do pagamento agrupado: parte B (sintético)."), confirmarVinculo(s2, "Tentativa de usar o restante no aluguel (sintético).")]);
  const disputa = [["B", rB], ["aluguel", rAl]].map(([k, r]) => ({ conta: k, status: r.status, repetido: r.corpo.repetido ?? false, erro: r.corpo.erro ?? null, mensagem: String(r.corpo.mensagem ?? "").slice(0, 240) }));
  passo("3.5", "Disputa simultânea pelo restante", { disputa });
  exigir(disputa.filter((x) => x.status === 200).length === 1 && disputa.filter((x) => x.status === 409).length === 1, "uma vence; a outra recebe conflito");
  const perdedora = disputa.find((x) => x.status === 409);
  const mov2 = await saidaAgrupada();
  const movNov2 = (await caixaNov()).paginacao.total;
  const todas = (await ler(s1, "/api/fv2/contas-a-pagar", { tamanho: 100 })).itens;
  const aluguelNov = todas.find((x) => x.descricao === "Aluguel da loja" && x.competencia === NOV);
  const contaB = todas.find((x) => /coifa/.test(x.descricao));
  passo("3.6", "Sem efeito parcial; saída integralmente alocada; nenhuma saída nova", { disponivel: disp(mov2), vinculo: mov2.vinculo?.titulos?.map((t) => [t.descricao, t.valorCentavos]), contaB: [contaB.pagoCentavos, contaB.saldoCentavos], aluguel: [aluguelNov.pagoCentavos, aluguelNov.saldoCentavos], movimentosNovembro: [movNov0, movNov2], perdedora: perdedora.conta });
  exigir(disp(mov2) === 0 && movNov0 === movNov2, "R$ 0,00 disponível, sem saída nova");
  exigir(contaB.pagoCentavos + aluguelNov.pagoCentavos === 40000, "só R$ 400,00 consumidos na disputa");
  // Saída esgotada: a tela não a oferece para a conta que perdeu; um POST forjado é recusado.
  const naoPaga = perdedora.conta === "B" ? contaB : aluguelNov;
  await fecharPainel(s1);
  await irPara(s1, "#/contas-a-pagar", NOV);
  await s1.locator("#conteudo tr", { hasText: perdedora.conta === "B" ? "Manutenção da coifa" : "Aluguel da loja" }).filter({ hasText: "novembro de 2026" }).first().getByRole("button", { name: "Detalhar" }).click();
  await painel(s1).waitFor({ state: "visible" });
  await s1.waitForFunction(() => !/Carregando/.test(document.querySelector("#painel .painel-conteudo")?.textContent ?? "Carregando"));
  const ofertas = await painel(s1).locator('select[name="movimentacao"] option').allTextContents();
  const forjada = await forjar(s1, "/api/fv2/acoes/obrigacoes/vincular-extrato", { obrigacao: naoPaga.id, movimentacao: mov2.id, versao: "1", valor: "100,00", justificativa: "Reuso (sintético)." });
  passo("3.7", "Reuso da saída esgotada", { ofereceAgrupada: ofertas.some((t) => /AGRUPADO/.test(t)), status: forjada.status, erro: forjada.corpo.erro, mensagem: String(forjada.corpo.mensagem ?? "").slice(0, 200) });
  exigir(!ofertas.some((t) => /AGRUPADO/.test(t)) && forjada.status >= 400, "saída esgotada não é reutilizada");
  // Detalhe da conta A mostra a saída agrupada; a Central de novembro não acusa mais a saída.
  await fecharPainel(s1);
  await irPara(s1, "#/contas-a-pagar", NOV);
  await s1.locator("#conteudo tr", { hasText: "Manutenção do freezer" }).first().getByRole("button", { name: "Detalhar" }).click();
  await painel(s1).waitFor({ state: "visible" });
  await s1.waitForFunction(() => !/Carregando/.test(document.querySelector("#painel .painel-conteudo")?.textContent ?? "Carregando"));
  const detA = await textoDe(painel(s1));
  passo("3.8", "Detalhe da conta A", { agrupada: /saída agrupada com 1 outra/.test(detA), vinculado: /vinculado do extrato/.test(detA), historico: (detA.match(/Histórico.{0,200}/) ?? [""])[0] });
  await foto(s1, "c3-08-conta-a");
  const pend = await ler(s1, "/api/fv2/conferencias/pendencias", { competencia: NOV, tamanho: 100 });
  passo("3.9", "Central de novembro", { saidaAgrupadaPendente: pend.itens.some((p) => p.codigo === "SAIDA_SEM_CLASSIFICACAO" && p.valorCentavos === 100000), manutencoesSemComprovante: pend.itens.filter((p) => p.codigo === "OBRIGACAO_SEM_COMPROVANTE" && /Manutenção/.test(p.titulo)).length });
  salvarRegistro("cenario3");
  await nav.close();
}

// ------------------------------------------------------------------------ responsividade e teclado
async function acessibilidade() {
  const nav = await abrirNavegador();
  const page = await entrar(nav, "administrador", { width: 390, height: 844 });
  const semRolagem = () => page.evaluate(() => ({ larguraDoc: document.documentElement.scrollWidth, janela: window.innerWidth }));
  await irPara(page, FECH, OUT);
  const a = await semRolagem();
  await foto(page, "a11y-01-fechamento-390");
  await abrirConta(page, "Energia (demonstração)");
  const b = await semRolagem();
  await foto(page, "a11y-02-conta-390");
  await fecharPainel(page);
  await irPara(page, "#/contas-a-pagar", NOV);
  const c = await semRolagem();
  passo("A.1", "390 px: sem rolagem horizontal", { fechamento: a, conta: b, contasNovembro: c });
  exigir([a, b, c].every((x) => x.larguraDoc <= x.janela), "sem rolagem horizontal a 390 px");
  // Teclado: Tab até um botão de pendência da tela de fechamento; Enter abre o painel com foco no fechar; Escape fecha e
  // o foco volta para o botão de origem.
  const pk = await entrar(nav, "administrador");
  await irPara(pk, FECH, OUT);
  let alvo = null;
  for (let i = 0; i < 200 && !alvo; i += 1) {
    await pk.keyboard.press("Tab");
    alvo = await pk.evaluate(() => (document.activeElement?.dataset?.detalhe?.startsWith("pendencia:") ? document.activeElement.textContent : null));
  }
  exigir(alvo, "um botão de pendência é alcançável por Tab");
  await pk.keyboard.press("Enter");
  await painel(pk).waitFor({ state: "visible" });
  await pk.waitForTimeout(500);
  const focoNoPainel = await pk.evaluate(() => document.activeElement?.matches?.("[data-fechar-painel]") ?? false);
  await pk.keyboard.press("Escape");
  await pk.waitForTimeout(500);
  const voltou = await pk.evaluate(() => ({ painelOculto: document.querySelector("#painel").hidden, foco: document.activeElement?.textContent ?? null }));
  passo("A.2", "Teclado: Tab → Enter → Escape", { alvo, focoNoPainel, ...voltou });
  exigir(focoNoPainel && voltou.painelOculto && voltou.foco === alvo, "foco entra no painel e volta à origem");
  salvarRegistro("acessibilidade");
  await nav.close();
}

// Reuso de saída ESGOTADA com a versão ATUAL (não por versão velha): a regra de alocação é que recusa.
async function reusoEsgotada() {
  const nav = await abrirNavegador();
  const page = await entrar(nav, "administrador");
  const cb = await ler(page, "/api/fv2/caixa-e-bancos", { inicio: "2026-11-01", fim: "2026-11-30", tamanho: 100 });
  const mov = cb.movimentos.find((m) => /AGRUPADO/.test(`${m.descricaoOriginal ?? ""}`));
  const contaB = (await ler(page, "/api/fv2/contas-a-pagar", { tamanho: 100 })).itens.find((x) => /coifa/.test(x.descricao));
  const prev = await ler(page, "/api/fv2/vinculo-extrato", { obrigacao: contaB.id, movimentacao: mov.id });
  passo("R.1", "Prévia com a saída esgotada", { disponivel: prev.escolhida?.disponivelCentavos, bloqueios: prev.escolhida?.bloqueios, elegivelNaLista: (prev.saidasElegiveis ?? []).some((x) => x.id === mov.id) });
  const r = await forjar(page, "/api/fv2/acoes/obrigacoes/vincular-extrato", { obrigacao: contaB.id, movimentacao: mov.id, versao: String(prev.escolhida?.versao ?? 0), valor: "100,00", justificativa: "Reuso com versão atual (sintético)." });
  const depois = (await ler(page, "/api/fv2/contas-a-pagar", { tamanho: 100 })).itens.find((x) => /coifa/.test(x.descricao));
  passo("R.2", "POST forjado com a versão atual", { status: r.status, erro: r.corpo.erro, mensagem: String(r.corpo.mensagem ?? "").slice(0, 200), contaBPago: depois.pagoCentavos });
  exigir(r.status === 409 && r.corpo.erro !== "FV2_CONFLITO_VERSAO" && depois.pagoCentavos === 0, "recusado pela regra de alocação, sem efeito");
  salvarRegistro("reuso-esgotada");
  await nav.close();
}

const etapa = process.argv[2];
const ETAPAS = { explorar, cenario1, cenario2, sondarReclassificacao, cenario1fim, cenario3, acessibilidade, reusoEsgotada };
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("jornada08e.mjs")) {
  if (!ETAPAS[etapa]) { process.stdout.write(`uso: node scripts/fv2/jornada08e.mjs <${Object.keys(ETAPAS).join("|")}> [--ver]\n`); process.exit(1); }
  await ETAPAS[etapa]();
}
