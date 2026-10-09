// Checklist Operacional — modos de exibição (Televisão e Tablet).
//
// Paridade por construção: os dois modos usam o MESMO `conteudoTela`; o modo só muda a classe da raiz. Aqui
// isso é provado comparando o HTML dos dois modos em todos os estados da tela (dia movimentado, dia sem
// pedidos, integração não ativada, carregando, falha, demonstração). A tela cheia é testada com um navegador
// falso (aceita, recusa, sem API, "resolve sem entrar"). O comportamento em navegador real (polling, Realtime,
// Esc, resoluções) está em checklistOperacionalModos.browser.test.js.
//
// Rodar: node --test frontend/test/checklistOperacionalModos.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { METAS_EXEMPLO } from "../src/checklistOperacionalModelo.js";
import { adaptarResumo, resumoCarregando, marcarFalha } from "../src/checklistOperacionalDados.js";
import { amostraDemonstracao } from "../src/checklistOperacionalAmostra.js";
import { montarTela, telaSelecaoModos } from "../src/checklistOperacionalVisual.js";
import {
  MODOS_EXIBICAO, modoValido, pedirTelaCheia, sairDaTelaCheia, telaCheiaAtiva, telaCheiaSuportada, avisoTelaCheia,
  INTERVALO_PAGINA_MS, montarPaginas, paginaValida, girarPagina, textoPagina, isolarFoco,
} from "../src/checklistOperacionalExibicao.js";
import { UNIDADE, respostaResumo, pedidosEmMassa } from "./checklistOperacionalFixture.js";

const AGORA = Date.parse("2026-10-09T15:00:00.000Z"); // 12:00 em São Paulo
const ler = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const adaptar = (dados) => adaptarResumo(dados, { unidade: UNIDADE, metas: METAS_EXEMPLO, recebidoEmMs: AGORA });

/** Separa a tag de abertura da raiz (onde o modo pode aparecer) do conteúdo (que tem de ser idêntico). */
function partes(html) {
  const fim = html.indexOf(">");
  return { raiz: html.slice(0, fim + 1), conteudo: html.slice(fim + 1) };
}
const nos2Modos = (resumo, opcoes = {}) => ({
  tv: partes(montarTela(resumo, AGORA, { ...opcoes, modo: "tv" })),
  tablet: partes(montarTela(resumo, AGORA, { ...opcoes, modo: "tablet" })),
});
const contar = (html, re) => (html.match(re) ?? []).length;

const ESTADOS = {
  "dia movimentado": () => adaptar(respostaResumo(AGORA)),
  "nenhum pedido no período": () => adaptar(respostaResumo(AGORA, { pedidos: [] })),
  "integração não ativada": () => adaptar(respostaResumo(AGORA, {
    pedidos: [], integracao: { estado: "nao_ativada", motivo: "sem_conexao", mensagem: "Conecte o iFood desta unidade.", ultimaSincronizacao: null },
  })),
  "dados desatualizados": () => adaptar(respostaResumo(AGORA, {
    integracao: { estado: "desatualizado", motivo: null, mensagem: "Sem eventos há 12 minutos.", ultimaSincronizacao: new Date(AGORA - 12 * 60_000).toISOString() },
  })),
  carregando: () => resumoCarregando({ unidade: UNIDADE, metas: METAS_EXEMPLO }),
  "falha de conexão": () => marcarFalha(adaptar(respostaResumo(AGORA)), new Error("rede")),
  "sem permissão": () => marcarFalha(resumoCarregando({ unidade: UNIDADE, metas: METAS_EXEMPLO }), Object.assign(new Error("403"), { status: 403 })),
  demonstração: () => amostraDemonstracao({ unidadeNome: UNIDADE.nome, metas: METAS_EXEMPLO }),
};

describe("página de seleção", () => {
  const html = telaSelecaoModos({ unidadeNome: UNIDADE.nome });

  test("mostra as duas opções, com o mesmo destaque", () => {
    assert.match(html, /<h1 id="ckm-titulo">Checklist Operacional<\/h1>/);
    assert.match(html, /Acompanhe os indicadores da sua operação em tempo real\. Escolha o formato ideal para seu dispositivo\./);
    const botoes = [...html.matchAll(/<button type="button" class="([^"]+)" data-acao="iniciar-modo" data-modo="(\w+)">/g)];
    assert.deepEqual(botoes.map((b) => b[2]), ["tv", "tablet"]);
    assert.equal(botoes[0][1], botoes[1][1], "os dois botões usam a mesma classe (mesmo destaque)");
    assert.match(html, /Iniciar Modo Televisão/);
    assert.match(html, /Iniciar Modo Tablet/);
    assert.equal(contar(html, /class="ckm-opcao"/g), 2);
  });
  test("ícones de aparelho do conjunto da Central (SVG), sem emoji", () => {
    assert.equal(contar(html, /<span class="ckm-icone"><svg class="icon"/g), 2);
    assert.doesNotMatch(html, /\p{Extended_Pictographic}/u);
  });
  test("não mostra número nenhum: a escolha não consulta dados", () => {
    assert.doesNotMatch(html, /\bmin\b|\d+\s*pedidos?/);
    assert.doesNotMatch(html, /data-cko/);
  });
  test("nome da unidade escapado; demonstração identificada só quando pedida", () => {
    assert.match(telaSelecaoModos({ unidadeNome: "<b>X</b>" }), /&lt;b&gt;X&lt;\/b&gt;/);
    assert.doesNotMatch(html, /Modo demonstração/);
    assert.match(telaSelecaoModos({ unidadeNome: "U", demonstracao: true }), /Modo demonstração: dados simulados/);
  });
  test("não promete segurança que a tela cheia não dá", () => {
    assert.match(html, /não deixe o aparelho sem supervisão/);
    assert.doesNotMatch(html, /segur[oa]/i);
  });
});

describe("paridade absoluta entre Televisão e Tablet", () => {
  for (const [nome, criar] of Object.entries(ESTADOS)) {
    test(`${nome}: o conteúdo é idêntico, byte a byte; só a raiz muda`, () => {
      const r = criar();
      for (const podeEditarMetas of [false, true]) {
        const { tv, tablet } = nos2Modos(r, { podeEditarMetas });
        assert.equal(tv.conteudo, tablet.conteudo);
        assert.equal(tv.raiz.replace(/cko--tv/, "X").replace('data-modo="tv"', "Y"), tablet.raiz.replace(/cko--tablet/, "X").replace('data-modo="tablet"', "Y"));
      }
    });
  }

  test("dia movimentado: os mesmos indicadores, valores, alertas e contagens nos dois", () => {
    const { tv, tablet } = nos2Modos(adaptar(respostaResumo(AGORA)));
    for (const html of [tv.conteudo, tablet.conteudo]) {
      assert.equal(contar(html, /data-card="(preparo|entrega|vida)"/g), 3);
      assert.match(html, /Status da operação/);
      assert.match(html, /<dt>Em andamento<\/dt><dd>7<\/dd>/);
      assert.match(html, /<dt>Concluídos hoje<\/dt><dd>6<\/dd>/);
      assert.match(html, /<dt>Cancelados hoje<\/dt><dd>1<\/dd>/);
      assert.match(html, /Pedidos em andamento/);
      assert.match(html, /Últimos pedidos/);
      assert.match(html, /Aberto há mais de 4 h sem conclusão/);  // alerta crítico do pedido parado
      assert.match(html, /Avaliações ainda não conectadas/);      // Review não homologado: indisponível nos dois
      assert.match(html, /a conclusão do iFood ainda não foi validada como entrega ao cliente/); // entrega aproximada
      assert.match(html, /Ao vivo/);
    }
    // Os números que aparecem (minutos, contadores, horários) são os mesmos, na mesma ordem.
    const numeros = (h) => (h.replace(/<[^>]+>/g, " ").match(/\d+(?:[.,:]\d+)*/g) ?? []).join(" ");
    assert.equal(numeros(tv.conteudo), numeros(tablet.conteudo));
  });

  test("sem pedidos: a interface funciona e não inventa número", () => {
    const { tv, tablet } = nos2Modos(adaptar(respostaResumo(AGORA, { pedidos: [] })));
    for (const html of [tv.conteudo, tablet.conteudo]) {
      assert.match(html, /Nenhum pedido registrado no período/);
      assert.match(html, /Nenhum pedido em andamento agora/);
      assert.doesNotMatch(html, /data-agora="vivo"/);
      // Só a META aparece em minutos (é configuração, não medição); média e último ficam em "—".
      assert.doesNotMatch(html, /<dd class="cko-nivel-txt--[a-z]+"[^>]*>(?:<span[^>]*>≈<\/span>)?\d/);
      assert.equal(contar(html, /<dd class="cko-hoje-vazio">—<\/dd>/g), 6);
      assert.doesNotMatch(html, /cko-faixa-demo"[^>]*>.*demonstração/);
    }
  });

  test("demonstração identificada nos dois modos; dado real nunca ganha a faixa", () => {
    const demo = nos2Modos(ESTADOS.demonstração());
    for (const p of [demo.tv, demo.tablet]) {
      assert.match(p.raiz, /cko--demo/);
      assert.match(p.conteudo, /Modo demonstração\.<\/b> Pedidos, tempos e avaliações são simulados/);
    }
    const real = nos2Modos(adaptar(respostaResumo(AGORA)));
    for (const p of [real.tv, real.tablet]) {
      assert.doesNotMatch(p.raiz, /cko--demo/);
      assert.doesNotMatch(p.conteudo, /Modo demonstração/);
    }
  });

  test("os dois modos têm Voltar ao Checklist, Tela cheia e o aviso da tela cheia", () => {
    const { tv, tablet } = nos2Modos(ESTADOS["dia movimentado"]());
    for (const p of [tv, tablet]) {
      assert.match(p.conteudo, /data-acao="voltar"[^>]*>.*Voltar ao Checklist/s);
      assert.match(p.conteudo, /data-acao="tela-cheia"/);
      assert.match(p.conteudo, /data-aviso-tela role="status" hidden/);
      assert.match(p.raiz, /cko--imersivo/);
    }
  });

  test("sem modo (uso antigo do componente) a raiz não fica imersiva", () => {
    const html = montarTela(ESTADOS.carregando(), AGORA);
    assert.doesNotMatch(partes(html).raiz, /imersivo|data-modo/);
    assert.doesNotMatch(partes(montarTela(ESTADOS.carregando(), AGORA, { modo: "<x>" })).raiz, /imersivo|data-modo/);
  });
});

describe("modos", () => {
  test("só tv e tablet; o modo não carrega unidade, empresa nem permissão", () => {
    assert.deepEqual(Object.keys(MODOS_EXIBICAO), ["tv", "tablet"]);
    assert.ok(modoValido("tv") && modoValido("tablet"));
    for (const m of [null, undefined, "", "toString", "__proto__", "kiosk"]) assert.equal(modoValido(m), false);
    for (const m of Object.values(MODOS_EXIBICAO)) {
      assert.deepEqual(Object.keys(m).sort(), ["acao", "descricao", "destaques", "id", "paginarListas", "rotulo"]);
    }
  });
  test("só a TV pagina; o Tablet mostra a lista completa", () => {
    assert.equal(MODOS_EXIBICAO.tablet.paginarListas, false);
    assert.equal(MODOS_EXIBICAO.tv.paginarListas, true);
  });
});

// ---------------------------------------------------------------------------
// Tela cheia com um navegador falso
// ---------------------------------------------------------------------------

function navegador({ aceita = true, entra = true, api = true, habilitada = true } = {}) {
  const doc = { fullscreenElement: null, fullscreenEnabled: habilitada, saidas: 0 };
  const el = {};
  if (api) {
    el.requestFullscreen = async (opcoes) => {
      el.opcoes = opcoes;
      if (!aceita) throw new TypeError("Permissions check failed");
      if (entra) doc.fullscreenElement = el;
    };
  }
  doc.exitFullscreen = async () => { doc.saidas += 1; doc.fullscreenElement = null; };
  return { doc, el };
}

describe("tela cheia", () => {
  test("aceita: entra, esconde a navegação do navegador e diz que está ativa", async () => {
    const { doc, el } = navegador();
    assert.deepEqual(await pedirTelaCheia(el, doc), { ok: true });
    assert.deepEqual(el.opcoes, { navigationUI: "hide" });
    assert.equal(telaCheiaAtiva(el, doc), true);
  });
  test("recusa: não lança e não finge — o modo segue na página", async () => {
    const { doc, el } = navegador({ aceita: false });
    assert.deepEqual(await pedirTelaCheia(el, doc), { ok: false, motivo: "recusado" });
    assert.equal(telaCheiaAtiva(el, doc), false);
  });
  test("promessa resolvida sem entrar de verdade conta como recusa", async () => {
    const { doc, el } = navegador({ entra: false });
    assert.deepEqual(await pedirTelaCheia(el, doc), { ok: false, motivo: "recusado" });
  });
  test("navegador sem a API (ex.: iPhone) ou com tela cheia bloqueada", async () => {
    const semApi = navegador({ api: false });
    assert.equal(telaCheiaSuportada(semApi.el, semApi.doc), false);
    assert.deepEqual(await pedirTelaCheia(semApi.el, semApi.doc), { ok: false, motivo: "sem_suporte" });
    const bloqueada = navegador({ habilitada: false });
    assert.deepEqual(await pedirTelaCheia(bloqueada.el, bloqueada.doc), { ok: false, motivo: "sem_suporte" });
  });
  test("prefixo webkit (Safari antigo)", async () => {
    const doc = { webkitFullscreenElement: null };
    const el = { webkitRequestFullscreen: () => { doc.webkitFullscreenElement = el; } };
    assert.deepEqual(await pedirTelaCheia(el, doc), { ok: true });
    assert.equal(telaCheiaAtiva(el, doc), true);
  });
  test("sair: só pede quando está em tela cheia, e nunca lança", async () => {
    const { doc, el } = navegador();
    await sairDaTelaCheia(doc);
    assert.equal(doc.saidas, 0);
    await pedirTelaCheia(el, doc);
    await sairDaTelaCheia(doc);
    assert.equal(doc.saidas, 1);
    assert.equal(telaCheiaAtiva(el, doc), false);
    doc.fullscreenElement = el;
    doc.exitFullscreen = async () => { throw new TypeError("Document not active"); };
    await assert.doesNotReject(sairDaTelaCheia(doc));
    await assert.doesNotReject(sairDaTelaCheia(null));
  });
  test("aviso: vazio quando está tudo certo; explica a recusa e a falta de suporte", () => {
    assert.equal(avisoTelaCheia({ ativa: true, ultimaTentativa: "recusado" }), "");
    assert.equal(avisoTelaCheia({ ativa: false, ultimaTentativa: null }), "");
    assert.match(avisoTelaCheia({ ativa: false, ultimaTentativa: "recusado" }), /não permitiu.*tentar de novo/);
    assert.match(avisoTelaCheia({ ativa: false, ultimaTentativa: "sem_suporte" }), /não oferece tela cheia/);
  });
});

// ---------------------------------------------------------------------------
// Ciclo de vida no controlador (o comportamento é provado no navegador real; aqui, as travas da fonte)
// ---------------------------------------------------------------------------

describe("controlador", () => {
  const fonte = ler("../src/checklistOperacional.js");
  const corpo = (nome) => { const i = fonte.indexOf(`function ${nome}(`); return fonte.slice(i, fonte.indexOf("\n}\n", i)); };

  test("o aviso do Realtime é registrado UMA vez, no módulo — nunca ao abrir um modo", () => {
    assert.equal(contar(fonte, /registrarInteresse\(/g), 1);
    for (const f of ["abrirModo", "iniciarModo", "desenharSelecao", "voltarParaSelecao", "renderChecklistOperacional"]) {
      assert.doesNotMatch(corpo(f), /registrarInteresse/, f);
    }
  });
  test("abrir um modo sempre para o anterior antes de criar UM sincronizador", () => {
    const abrir = corpo("abrirModo");
    assert.ok(abrir.indexOf("parar();") > -1 && abrir.indexOf("parar();") < abrir.indexOf("criarSincronizadorDaTela"));
    assert.equal(contar(fonte, /= criarSincronizadorDaTela\(unidade\)/g), 1);
  });
  test("a seleção não consulta nada; voltar para tudo e sai da tela cheia", () => {
    assert.doesNotMatch(corpo("desenharSelecao"), /sincronizador|obterResumo/);
    const voltar = corpo("voltarParaSelecao");
    assert.match(voltar, /sairDaTelaCheia\(\)/);
    assert.match(voltar, /parar\(\)/);
    assert.match(corpo("parar"), /estado\.sincronizador\?\.parar\(\)/);
    assert.match(corpo("parar"), /removeEventListener\("visibilitychange"/);
  });
  test("a troca de unidade volta à seleção e descarta o retrato antigo", () => {
    const reset = fonte.slice(fonte.indexOf("registrarResetDeContexto("), fonte.indexOf("});", fonte.indexOf("registrarResetDeContexto(")));
    assert.match(reset, /estado\.modo = null/);
    assert.match(reset, /estado\.resumo = null/);
  });
  test("tela cheia só pelo módulo de exibição (sem chamada direta espalhada)", () => {
    assert.doesNotMatch(fonte, /requestFullscreen|document\.exitFullscreen/);
  });
  test("paginação só na TV, sobre os dados já recebidos, virada pelo próprio tique (sem timer novo)", () => {
    assert.match(fonte, /const paginando = \(\) => MODOS_EXIBICAO\[estado\.modo\]\?\.paginarListas === true;/);
    for (const f of ["paginarPaineis", "paginarPainel", "mostrarPagina", "virarPaginasNoTempo", "virarPagina"]) {
      assert.doesNotMatch(corpo(f), /setInterval|setTimeout|obterResumo|sincronizador/, f);
    }
    assert.match(corpo("tique"), /if \(paginando\(\)\) virarPaginasNoTempo\(raiz\);/);
    assert.equal(contar(fonte, /setInterval\(/g), 1, "o único intervalo é o tique de 1 s");
    assert.match(corpo("parar"), /estado\.proximaPaginaEm = null/);
    assert.match(corpo("virarPaginasNoTempo"), /reduzMovimento\(\)/);
  });
  test("foco: o resto da Central fica inerte com o modo aberto e volta ao sair", () => {
    assert.match(corpo("desenhar"), /estado\.restaurarFoco = isolarFoco\(estado\.raiz\);/);
    assert.match(corpo("parar"), /estado\.restaurarFoco\?\.\(\);/);
  });
});

describe("CSS dos modos", () => {
  const css = ler("../src/checklistOperacional.css");
  test("nenhum indicador é escondido por modo", () => {
    const regras = css.match(/\.cko--(tv|tablet)[^{]*\{[^}]*\}/g) ?? [];
    assert.ok(regras.length > 5);
    for (const r of regras) assert.doesNotMatch(r, /display:\s*none|visibility:\s*hidden/, r);
  });
  test("imersivo cobre a Central e, se a altura não bastar, rola em vez de cortar", () => {
    assert.match(css, /\.cko--imersivo \{[^}]*position: fixed; inset: 0;[^}]*overflow-y: auto;/);
    assert.match(css, /html:has\(\.cko--imersivo\) \{ overflow: hidden; \}/);
  });
  test("tablet com alvos de toque de 44 px", () => {
    assert.match(css, /\.cko--tablet \.cko-btn \{ min-height: 44px;/);
  });
  test("index carrega a versão nova do CSS", () => {
    assert.match(ler("../index.html"), /checklistOperacional\.css\?v=3/);
  });
  test("4K: zoom só onde o navegador o oferece; sem ele, a grade normal da TV", () => {
    assert.match(css, /@supports \(zoom: 2\) \{\s*@media \(min-width: 3000px\) and \(min-height: 1600px\) \{\s*\.cko--tv \{ zoom: 2;/);
    assert.equal(contar(css, /zoom: 2;/g), 1);
  });
  test("não sobrou o resumo 'E mais N'", () => {
    assert.doesNotMatch(css, /cko-mais/);
    assert.doesNotMatch(ler("../src/checklistOperacionalVisual.js"), /data-mais|E mais|LIMITE_ATIVOS_VISIVEIS/);
  });
});

// ---------------------------------------------------------------------------
// Paginação (funções puras) e listas grandes/vazias
// ---------------------------------------------------------------------------

describe("paginação", () => {
  test("páginas com as linhas que cabem inteiras, na ordem, sem pular nenhuma", () => {
    assert.deepEqual(montarPaginas([50, 50, 50, 50, 50], 160, 6), [[0, 2], [2, 4], [4, 5]]); // 50+6+50=106; +56=162 > 160
    assert.deepEqual(montarPaginas([50, 50, 50], 1000), [[0, 3]]);
    assert.deepEqual(montarPaginas([], 300), []);
  });
  test("linha mais alta que o painel ganha página própria (nunca é omitida)", () => {
    assert.deepEqual(montarPaginas([40, 500, 40], 200), [[0, 1], [1, 2], [2, 3]]);
  });
  test("todas as linhas aparecem exatamente uma vez, para qualquer altura", () => {
    for (let n = 0; n < 80; n += 7) {
      const alturas = Array.from({ length: n }, (_, i) => 40 + ((i * 37) % 60));
      for (const disp of [30, 120, 333, 900]) {
        const vistos = montarPaginas(alturas, disp, 6).flatMap(([a, b]) => Array.from({ length: b - a }, (_, k) => a + k));
        assert.deepEqual(vistos, alturas.map((_, i) => i));
      }
    }
  });
  test("ciclo: depois da última vem a primeira; voltar da primeira vai para a última", () => {
    assert.deepEqual([0, 1, 2].map((p) => girarPagina(p, 3)), [1, 2, 0]);
    assert.equal(girarPagina(7, 3), 0); // índice inválido (lista diminuiu): parte da última válida
    assert.equal(girarPagina(0, 3, -1), 2);
    assert.equal(girarPagina(5, 0), 0);
  });
  test("lista que diminuiu: página válida (a última que ainda existe)", () => {
    assert.equal(paginaValida(4, 2), 1);
    assert.equal(paginaValida(-1, 3), 0);
    assert.equal(paginaValida(1, 0), 0);
    assert.equal(paginaValida(undefined, 3), 0);
  });
  test("texto: página atual, total de páginas e o total da lista inteira", () => {
    assert.equal(textoPagina({ pagina: 1, paginas: 3, total: 7, singular: "pedido", plural: "pedidos" }), "Página 2 de 3 · 7 pedidos");
    assert.equal(textoPagina({ pagina: 0, paginas: 2, total: 1, singular: "comentário", plural: "comentários" }), "Página 1 de 2 · 1 comentário");
    assert.equal(INTERVALO_PAGINA_MS, 10_000);
  });
});

describe("listas grandes e vazias", () => {
  test("todos os pedidos em andamento vão para a tela (sem teto), iguais nos dois modos", () => {
    const r = adaptar(respostaResumo(AGORA, { pedidos: pedidosEmMassa(AGORA, 60) }));
    const { tv, tablet } = nos2Modos(r);
    assert.equal(tv.conteudo, tablet.conteudo);
    assert.equal(contar(tv.conteudo, /data-pedido="/g), 60);
    assert.match(tv.conteudo, /<span class="cko-contagem">60<\/span>/);
    assert.match(tv.conteudo, /data-paginacao="ativos" data-total="60" data-singular="pedido em andamento"/);
  });
  test("paginador nasce escondido (só a TV o mostra, e só com mais de uma página)", () => {
    const html = nos2Modos(adaptar(respostaResumo(AGORA))).tv.conteudo;
    assert.equal(contar(html, /<nav class="cko-paginacao"[^>]* hidden>/g), 2);
  });
  test("lista vazia: sem paginador, com o texto do estado vazio", () => {
    const html = nos2Modos(adaptar(respostaResumo(AGORA, { pedidos: [] }))).tablet.conteudo;
    assert.doesNotMatch(html, /data-paginacao/);
    assert.match(html, /Nenhum pedido em andamento agora/);
  });
});

// ---------------------------------------------------------------------------
// Isolamento do foco com um DOM falso
// ---------------------------------------------------------------------------

function no(tagName, filhos = [], inert = false) {
  const n = { tagName, inert, children: filhos, parentElement: null };
  for (const f of filhos) f.parentElement = n;
  return n;
}

describe("isolarFoco", () => {
  test("marca os irmãos do caminho até o body; o caminho e a raiz continuam ativos; restaurar desfaz só o que marcou", () => {
    const raiz = no("DIV");
    const view = no("MAIN", [raiz]);
    const topo = no("HEADER");
    const main = no("DIV", [topo, view]);
    const menu = no("ASIDE");
    const app = no("DIV", [menu, main]);
    const login = no("DIV", [], true); // já estava inerte: não é marcado nem desmarcado
    const script = no("SCRIPT");
    const toast = no("DIV");
    const body = no("BODY", [login, app, toast, script]);
    no("HTML", [body]);
    const restaurar = isolarFoco(raiz, { body }, null);
    assert.deepEqual([menu.inert, topo.inert, toast.inert, login.inert, script.inert], [true, true, true, true, false]);
    assert.deepEqual([raiz.inert, view.inert, main.inert, app.inert], [false, false, false, false]);
    restaurar();
    assert.deepEqual([menu.inert, topo.inert, toast.inert, login.inert], [false, false, false, true]);
    menu.inert = true; // mudança posterior de outro módulo: um segundo restaurar não mexe
    restaurar();
    assert.equal(menu.inert, true);
  });

  test("camada criada DEPOIS em qualquer nível do caminho fica inerte; ao restaurar, o observador é desligado", () => {
    const raiz = no("DIV");
    const view = no("MAIN", [raiz]);
    const main = no("DIV", [view]);
    const body = no("BODY", [main]);
    no("HTML", [body]);
    const observadores = [];
    class ObservadorFalso {
      constructor(cb) { this.cb = cb; this.alvos = []; this.ligado = true; observadores.push(this); }
      observe(alvo, opcoes) { this.alvos.push([alvo, opcoes]); }
      disconnect() { this.ligado = false; }
      disparar(addedNodes) { if (this.ligado) this.cb([{ addedNodes }]); }
    }
    const restaurar = isolarFoco(raiz, { body }, ObservadorFalso);
    assert.equal(observadores.length, 1);
    // Olha só a LISTA DE FILHOS dos níveis do caminho (sem subárvore: o que nasce dentro do Checklist não é tocado).
    assert.deepEqual(observadores[0].alvos.map(([a, o]) => [a.tagName, o]), [["MAIN", { childList: true }], ["DIV", { childList: true }], ["BODY", { childList: true }]]);
    const painelAgente = no("ASIDE");
    const overlay = no("DIV");
    const texto = { nodeType: 3 };
    const jaInerte = no("DIV", [], true);
    observadores[0].disparar([painelAgente, texto, jaInerte]);
    observadores[0].disparar([overlay]);
    assert.deepEqual([painelAgente.inert, overlay.inert, jaInerte.inert, texto.inert], [true, true, true, undefined]);
    assert.equal(raiz.inert, false);
    restaurar();
    assert.equal(observadores[0].ligado, false, "observador desligado ao sair");
    assert.deepEqual([painelAgente.inert, overlay.inert, jaInerte.inert], [false, false, true]);
    const depois = no("DIV");
    observadores[0].disparar([depois]);  // nada acontece depois de restaurar
    assert.equal(depois.inert, false);
  });
});
