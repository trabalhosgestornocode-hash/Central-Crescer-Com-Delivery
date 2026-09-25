// Central de Comunicação → Conversas: o cabeçalho da conversa tem altura CONTROLADA, não importa quantas empresas/unidades o responsável tenha, e a área de mensagens
// nunca é espremida. (Bug de produção: contato com 47 unidades listava tudo no cabeçalho, que crescia e deixava as mensagens com ~74 px.)
//   - resumoAssociacoes / htmlChatCabecalho: no máximo 3 unidades + "+N"; quantidade sempre legível; nome, telefone mascarado e status na 1ª linha.
//   - htmlContexto: a lista COMPLETA continua acessível (é para onde o "+N" leva).
//   - invariantes do CSS (composição vertical) e da ordem de pintura do controlador: guardas estáticas, porque não há navegador nos testes.
// A medição real (alturas, rolagem, viewports) está no QA visual do relatório; aqui ficam os pré-requisitos que impedem a regressão.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resumoAssociacoes, estaNoFim } from "../src/central/centralModelo.js";
import { htmlChatCabecalho, htmlContexto, htmlFluxo, htmlMensagem, htmlComposer } from "../src/central/centralUi.js";

const lerFonte = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const CSS = lerFonte("../src/central/central.css");
const CONTROLADOR = lerFonte("../src/central/centralComunicacao.js");
const AGORA = new Date(2026, 8, 24, 15, 0, 0);
const iso = (min) => new Date(AGORA.getTime() - min * 60_000).toISOString();

/** Contato com `n` empresas e `n` unidades (o caso real: 47 franquias do mesmo responsável). */
const contatoCom = (n, o = {}) => ({
  contatoId: "c1", nome: "Jailton Matos", iniciais: "JM", fotoUrl: null, cargo: "Administrador da empresa", telefoneMascarado: "********01",
  empresas: Array.from({ length: n }, (_, i) => ({ organizacaoId: `o${i}`, nome: `Empresa ${i + 1}`, pendenciasAtuais: 0 })),
  unidades: Array.from({ length: n }, (_, i) => ({ unidadeId: `u${i}`, nome: `Unidade ${i + 1}`, organizacaoId: `o${i}` })),
  consentimento: true, verificado: true, optOut: false, pendenciasAtuais: 0, naoLidas: 0, ultimaMensagem: null, ...o,
});
const pode = { podeEnviar: true, bloqueios: [] };
const contar = (s, re) => (s.match(re) ?? []).length;
const tamanhoCab = (n) => htmlChatCabecalho(contatoCom(n), pode).length;

/** Regra CSS `seletor { ... }` (a 1ª cujo seletor é exatamente o pedido, fora de @media) → texto do bloco. */
function regra(seletor) {
  const semMedia = CSS.replace(/@media[^{]*\{([\s\S]*?\n)\}/g, "");
  const esc = seletor.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&");
  const m = semMedia.match(new RegExp(`(?:^|\\n|\\})\\s*${esc}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
}
const decl = (bloco, prop) => { const m = bloco?.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`)); return m ? m[1].trim() : null; };

describe("resumoAssociacoes — o que o cabeçalho mostra", () => {
  test("sem vínculo, 1 empresa/1 unidade, 3, 10, 47 e >100: rótulo com a QUANTIDADE, até 3 unidades e o resto em '+N'", () => {
    assert.deepEqual(resumoAssociacoes({ empresas: [], unidades: [] }), { rotulo: "Sem empresa vinculada", nEmpresas: 0, nUnidades: 0, total: 0, unidades: [], resto: 0 });
    const um = resumoAssociacoes(contatoCom(1));
    assert.equal(um.rotulo, "Empresa 1"); assert.equal(um.resto, 0); assert.equal(um.unidades.length, 1);
    const tres = resumoAssociacoes(contatoCom(3));
    assert.equal(tres.rotulo, "3 unidades associadas"); assert.equal(tres.resto, 0); assert.equal(tres.unidades.length, 3);
    const dez = resumoAssociacoes(contatoCom(10));
    assert.equal(dez.rotulo, "10 unidades associadas"); assert.equal(dez.resto, 7); assert.equal(dez.unidades.length, 3);
    const q47 = resumoAssociacoes(contatoCom(47));
    assert.equal(q47.rotulo, "47 unidades associadas"); assert.equal(q47.resto, 44); assert.equal(q47.total, 47); assert.deepEqual(q47.unidades.map((u) => u.nome), ["Unidade 1", "Unidade 2", "Unidade 3"]);
    const mais = resumoAssociacoes(contatoCom(137));
    assert.equal(mais.rotulo, "137 unidades associadas"); assert.equal(mais.resto, 134); assert.equal(mais.unidades.length, 3);
  });
  test("empresas ≠ unidades: as duas quantidades aparecem; uma empresa com muitas unidades mantém o nome da empresa; 'max' é respeitado", () => {
    const c = contatoCom(2, { unidades: contatoCom(9).unidades });
    assert.equal(resumoAssociacoes(c).rotulo, "2 empresas · 9 unidades associadas");
    const umaEmpresa = { empresas: [{ organizacaoId: "o", nome: "Rede Sabor" }], unidades: contatoCom(6).unidades };
    assert.equal(resumoAssociacoes(umaEmpresa).rotulo, "Rede Sabor · 6 unidades"); assert.equal(resumoAssociacoes(umaEmpresa).resto, 3);
    assert.equal(resumoAssociacoes(contatoCom(10), { max: 5 }).unidades.length, 5); assert.equal(resumoAssociacoes(contatoCom(10), { max: 5 }).resto, 5);
    assert.equal(resumoAssociacoes({ empresas: contatoCom(4).empresas, unidades: [] }).rotulo, "4 empresas associadas");
  });
  test("sem unidades NÃO há chips, logo NÃO há '+N' (resto só conta o que ficou fora dos chips) — nem botão no cabeçalho", () => {
    const soEmpresas = { ...contatoCom(4), unidades: [] };
    const r = resumoAssociacoes(soEmpresas); assert.equal(r.resto, 0); assert.equal(r.total, 4); assert.equal(r.unidades.length, 0);
    const h = htmlChatCabecalho(soEmpresas, pode); assert.ok(!/data-cc-ver-associacoes/.test(h)); assert.match(h, /4 empresas associadas/); assert.ok(!/cc-chips--cab/.test(h));
    assert.equal(resumoAssociacoes({ empresas: contatoCom(5).empresas, unidades: contatoCom(2).unidades }).resto, 0);        // 2 unidades cabem nos chips
    assert.equal(resumoAssociacoes({ empresas: contatoCom(5).empresas, unidades: contatoCom(4).unidades }).resto, 1);        // só o que ficou fora dos chips
  });
  test("tolera contato incompleto (sem listas) sem quebrar", () => {
    assert.equal(resumoAssociacoes({}).rotulo, "Sem empresa vinculada"); assert.equal(resumoAssociacoes(null).resto, 0);
  });
});

describe("htmlChatCabecalho — altura limitada pelo CONTEÚDO", () => {
  for (const n of [1, 3, 10, 47, 120, 250]) {
    test(`${n} unidade(s): no máximo 3 chips + 1 botão '+N'; nunca lista as demais`, () => {
      const h = htmlChatCabecalho(contatoCom(n), pode);
      const chips = contar(h, /<span class="cc-chip"/g); const botoes = contar(h, /data-cc-ver-associacoes/g);
      assert.ok(chips <= 3, `chips=${chips}`); assert.equal(chips, Math.min(n, 3));
      assert.equal(botoes, n > 3 ? 1 : 0);
      if (n > 3) assert.match(h, /<\/span><\/span><button type="button" class="cc-chip cc-chip--mais/, "o '+N' é IRMÃO do grupo de chips (fora do overflow que corta)");
      if (n > 3) { assert.ok(h.includes(`>+${n - 3}</span>`), "+N com o resto certo"); assert.ok(!h.includes("Unidade 4<"), "a 4ª unidade NÃO vai para o cabeçalho"); assert.ok(!h.includes(`Unidade ${n}<`)); }
    });
  }
  test("o tamanho do cabeçalho NÃO cresce com o nº de unidades (47, 120 e 250 ≈ 4)", () => {
    const base = tamanhoCab(4);
    for (const n of [47, 120, 250]) assert.ok(Math.abs(tamanhoCab(n) - base) < 120, `${n}: ${tamanhoCab(n)} vs ${base}`);   // só muda o número do "+N" e do rótulo
  });
  test("47 unidades: nome, telefone mascarado, status 'Pode receber mensagens' e '47 unidades associadas' — nessa prioridade", () => {
    const h = htmlChatCabecalho(contatoCom(47), pode);
    const ordem = ["Jailton Matos", "********01", "Pode receber mensagens", "47 unidades associadas", "+44"].map((t) => h.indexOf(t));
    assert.ok(ordem.every((i) => i >= 0), `faltou algo: ${ordem}`); assert.deepEqual([...ordem].sort((a, b) => a - b), ordem, "ordem de leitura");
    assert.match(h, /<p class="cc-chat-empresa tem-mais">/); assert.ok(!/tem-mais/.test(htmlChatCabecalho(contatoCom(3), pode)));
    assert.match(h, /<div class="cc-chat-topo">[\s\S]*cc-chat-nome[\s\S]*cc-tel[\s\S]*Pode receber mensagens[\s\S]*<\/div>\s*<p class="cc-chat-empresa tem-mais">/);
    assert.ok(!/\d{4,}/.test(h.replace(/\*+\d+/g, "")), "nenhum telefone completo");
  });
  test("o '+N' é um botão acessível que leva à lista completa (sem handler inline — a CSP bloqueia)", () => {
    const h = htmlChatCabecalho(contatoCom(47), pode);
    assert.match(h, /<button type="button" class="cc-chip cc-chip--mais cc-chip--acao" data-cc-ver-associacoes aria-label="\+44 · Ver todas as 47 associações nos detalhes"/);
    const nome = h.match(/data-cc-ver-associacoes aria-label="([^"]+)"/)[1];
    assert.ok(nome.includes("+44") && nome.includes("Ver todas"), "o nome acessível contém o texto visível nos dois modos (desktop '+44', celular 'Ver todas') — WCAG 2.5.3"); assert.ok(!/outras/.test(nome));
    assert.ok(!/\son[a-z]+=/i.test(h), "sem on*=");
    assert.match(h, /cc-mais-todas">Ver todas</, "texto do celular (chips ocultos)");
  });
  test("segurança: nomes de empresa/unidade escapados também no resumo", () => {
    const xss = `<img src=x onerror=alert(1)>`;
    const h = htmlChatCabecalho({ ...contatoCom(6), empresas: [{ organizacaoId: "o", nome: xss }], unidades: contatoCom(6).unidades.map((u, i) => (i ? u : { ...u, nome: xss })) }, pode);
    assert.ok(!h.includes(xss)); assert.ok(h.includes("&lt;img"));
  });
  test("status de envio indisponível continua visível no cabeçalho (2ª linha de informação não o esconde)", () => {
    const h = htmlChatCabecalho(contatoCom(47), { podeEnviar: false, bloqueios: [{ codigo: "GATEWAY_INDISPONIVEL", mensagem: "fora" }] });
    assert.match(h, /Envio indisponível/); assert.ok(!/Pode receber mensagens/.test(h)); assert.match(h, /47 unidades associadas/);
  });
});

describe("painel de detalhes — a lista completa (destino do '+N')", () => {
  test("47 empresas: TODAS listadas, com a contagem no título e a âncora que o '+N' usa", () => {
    const h = htmlContexto(contatoCom(47));
    assert.equal(contar(h, /<li class="cc-ctx-emp"/g), 47); assert.match(h, /Empresas e unidades \(47\)/);
    assert.match(h, /<section class="cc-ctx-sec" data-cc-ctx-associacoes><h4 tabindex="-1">/); assert.ok(h.includes("Empresa 47"));
  });
  test("1 empresa: título sem contagem (nada muda para o caso comum)", () => {
    assert.match(htmlContexto(contatoCom(1)), /<h4 tabindex="-1">Empresas e unidades<\/h4>/);
  });
});

describe("mensagens continuam sendo BALÕES — todos os tipos", () => {
  const base = { id: "m", direcao: "saida", categoria: "manual", tipo: "texto", texto: "Olá", status: "SENT", em: iso(3), operador: "Camila" };
  const tipos = {
    "recebida (entrada)": { direcao: "entrada", categoria: "recebida", operador: null, status: null },
    "saída manual (atendimento humano)": { categoria: "manual", operador: "Camila" },
    "automática": { categoria: "automatica", operador: null },
    "teste": { categoria: "teste", operador: null },
    "recém-enviada (otimista, ainda local)": { id: "local-1", local: true, status: "QUEUED", em: iso(0) },
    "falha local com reenvio": { local: true, falhaLocal: true, status: "FAILED", envioId: "E1", erro: "sem WhatsApp" },
  };
  for (const [nome, o] of Object.entries(tipos)) {
    test(`${nome}: renderiza um balão com o texto`, () => {
      const h = htmlMensagem({ ...base, ...o });
      assert.match(h, /<div class="cc-msg cc-msg--/); assert.match(h, /data-cc-msg=/); assert.ok(h.includes("Olá") || o.erro);
    });
  }
  test("conversa com UMA mensagem (a recém-enviada): 1 balão, sem quebrar o fluxo; muitas mensagens: 1 balão por mensagem", () => {
    const um = htmlFluxo({ mensagens: [{ ...base, id: "unica", local: true, status: "QUEUED", em: iso(0) }], janelaHoras: 24, agora: AGORA });
    assert.equal(contar(um, /data-cc-msg=/g), 1); assert.match(um, /role="log"|cc-grupo/);
    const muitas = Array.from({ length: 200 }, (_, i) => ({ ...base, id: `m${i}`, em: iso(1000 - i), direcao: i % 3 ? "saida" : "entrada", categoria: i % 3 ? "manual" : "recebida" }));
    assert.equal(contar(htmlFluxo({ mensagens: muitas, janelaHoras: 24, agora: AGORA }), /data-cc-msg=/g), 200);
  });
  test("composer com bloqueio longo continua sendo UM bloco (a altura dele é limitada no CSS)", () => {
    const h = htmlComposer({ podeEnviar: false, bloqueios: [{ codigo: "X", mensagem: "m".repeat(400) }] });
    assert.equal(contar(h, /<form class="cc-composer"/g), 1);
  });
});

describe("CSS — composição vertical robusta (cabeçalho + mensagens que rolam + composer sempre visível)", () => {
  test("cabeçalho: não encolhe, tem teto de altura e é uma grade de 2 linhas (nada de altura fixa)", () => {
    const b = regra(".cc-chat-cab");
    assert.equal(decl(b, "flex-shrink"), "0"); assert.equal(decl(b, "display"), "grid"); assert.match(decl(b, "max-height") ?? "", /^\d+px$/); assert.ok(!decl(b, "height"), "sem height fixo");
    assert.match(decl(b, "grid-template-areas") ?? "", /"av topo btn" "av emp btn"/);
  });
  test("mensagens: flex 1 1 0, min-height 0 e overflow-y auto (rolam sozinhas; o cabeçalho e o composer ficam parados)", () => {
    const b = regra(".cc-fluxo");
    assert.equal(decl(b, "flex"), "1 1 0"); assert.equal(decl(b, "min-height"), "0"); assert.equal(decl(b, "overflow-y"), "auto"); assert.ok(!decl(b, "height") && !decl(b, "max-height"));
  });
  test("composer: flex-shrink 0 (sempre visível); a coluna da conversa corta o excesso e a área do composer tem teto (aviso longo não engole as mensagens)", () => {
    assert.equal(decl(regra(".cc-composer"), "flex-shrink"), "0");
    const chat = regra(".cc-chat"); assert.match(decl(chat, "display") ?? "", /flex/); assert.equal(decl(chat, "flex-direction"), "column"); assert.equal(decl(chat, "min-height"), "0"); assert.equal(decl(chat, "overflow"), "hidden");
    assert.match(CSS, /\.cc-chat > \[data-cc-composer-area\] \{[^}]*max-height: 46%/);
    assert.match(CSS, /\.cc-chat > \[data-cc-chat-cab\][^{]*\{[^}]*flex: 0 0 auto/);
  });
  test("a grade da Central tem linha única minmax(0,1fr): o conteúdo NUNCA aumenta a altura do espaço (min-height:auto de linha 'auto' era o vetor do bug)", () => {
    assert.match(decl(regra(".cc-espaco"), "grid-template-rows") ?? "", /^minmax\(0,\s*1fr\)$/);
  });
  test("associações no cabeçalho: uma linha (nowrap), ellipsis no rótulo, chips encolhem antes do rótulo e o '+N' nunca encolhe", () => {
    assert.equal(decl(regra(".cc-chat-empresa"), "flex-wrap"), "nowrap");
    const rot = regra(".cc-chat-assoc"); assert.equal(decl(rot, "text-overflow"), "ellipsis"); assert.equal(decl(rot, "white-space"), "nowrap");
    assert.equal(decl(rot, "flex"), "0 0 auto"); assert.match(CSS, /\.cc-chat-empresa\.tem-mais \.cc-chat-assoc \{ max-width: calc\(100% - \d+px\); \}/);   // o rótulo não encolhe; com "+N" sobra sempre lugar para ele
    assert.match(CSS, /\.cc-chat-empresa \.cc-chips--cab \{[^}]*flex: 0 1 auto[^}]*min-width: 0[^}]*overflow: hidden/);   // especificidade > `.cc-chips {flex-wrap: wrap}` (declarada depois)
    assert.match(CSS, /\.cc-chat-empresa \.cc-chip--mais \{[^}]*flex: none/);           // o "+N" é irmão do grupo: fora do overflow
    assert.match(CSS, /\.cc-chat-empresa \.cc-chips--cab \.cc-chip \{[^}]*max-width: 168px[^}]*text-overflow: ellipsis/);
  });
  test("anel de foco do '+N' fica DENTRO da caixa (o overflow do resumo cortaria um anel externo); 821–1000px empilha telefone e status", () => {
    assert.match(CSS, /\.cc-chip--acao:focus-visible \{ outline: 2px solid var\(--cc-brand\); outline-offset: -2px; \}/);
    assert.match(CSS, /@media \(min-width: 821px\) and \(max-width: 1000px\) \{\s*\.cc-chat-meta \{ flex-direction: column; align-items: flex-end;/);
  });
  test("celular (≤820px): chips somem, o '+N' vira 'Ver todas' e continua acionável; o botão de voltar ocupa a 1ª coluna", () => {
    const media = CSS.slice(CSS.indexOf("@media (max-width: 820px)"));
    assert.match(media, /\.cc-chat-empresa \.cc-chips--cab \{ display: none; \}/);
    assert.match(media, /\.cc-chip--mais \.cc-mais-n \{ display: none; \} \.cc-chip--mais \.cc-mais-todas \{ display: inline; \}/);
    assert.match(media, /grid-template-areas: "vol av topo btn" "vol av emp emp"/);
  });
});

describe("estaNoFim — a decisão de manter o fluxo no fim (pura)", () => {
  const el = (scrollHeight, scrollTop, clientHeight) => ({ scrollHeight, scrollTop, clientHeight });
  test("no fim exato, dentro do limite (90 px) ⇒ true; lendo o histórico (mais de 90 px acima) ⇒ false; no limite exato ⇒ false", () => {
    assert.equal(estaNoFim(el(1000, 600, 400)), true);       // distância 0
    assert.equal(estaNoFim(el(1000, 520, 400)), true);       // 80 px
    assert.equal(estaNoFim(el(1000, 510, 400)), false);      // 90 px: já está lendo acima
    assert.equal(estaNoFim(el(1000, 100, 400)), false);      // histórico
    assert.equal(estaNoFim(el(1000, 600, 400), 10), true); assert.equal(estaNoFim(el(1000, 585, 400), 10), false);
  });
  test("conteúdo menor que a área (poucas mensagens) e ausência de elemento ⇒ true (nada a preservar)", () => {
    assert.equal(estaNoFim(el(200, 0, 400)), true); assert.equal(estaNoFim(null), true); assert.equal(estaNoFim(undefined), true);
  });
  test("composer que CRESCE (textarea multilinha) muda a distância: medir antes do layout novo evita perder o fim", () => {
    const fluxo = el(1000, 600, 400);                        // no fim
    const noFim = estaNoFim(fluxo);                          // decisão tomada ANTES de o composer crescer
    fluxo.clientHeight = 310;                                // composer +90 px ⇒ o fluxo encolhe: agora a distância é 90 (parece "lendo")
    assert.equal(noFim, true); assert.equal(estaNoFim(fluxo), false, "medir DEPOIS daria falso negativo — por isso preservarFim mede antes");
  });
});

describe("controlador — a ordem de pintura mantém a última mensagem visível", () => {
  const corpo = (nome) => { const i = CONTROLADOR.indexOf(`function ${nome}(`); assert.ok(i >= 0, nome); return CONTROLADOR.slice(i, i + 900); };
  test("pintarChat pinta o COMPOSER antes de rolar o fluxo (a altura final do composer entra na conta do 'ir ao fim')", () => {
    const c = corpo("pintarChat"); assert.ok(c.indexOf("pintarComposer()") >= 0 && c.indexOf("pintarFluxo({ rolar })") >= 0); assert.ok(c.indexOf("pintarComposer()") < c.indexOf("pintarFluxo({ rolar })"));
  });
  test("qualquer mudança de altura do composer/cabeçalho (repintura, digitação multilinha) passa por preservarFim", () => {
    assert.match(corpo("pintarComposer"), /preservarFim\(/); assert.match(CONTROLADOR, /preservarFim\(\(\) => ajustarAltura\(t\)\)/);
    assert.match(CONTROLADOR, /preservarFim\(\(\) => \{ pintarSe\(cab, ui\.htmlChatCabecalho/);
    const f = corpo("preservarFim"); assert.match(f, /M\.estaNoFim\(f, ROLAGEM_FIM_PX\)/); assert.match(f, /if \(f && noFim\) f\.scrollTop = f\.scrollHeight/); assert.ok(f.indexOf("fn()") < f.indexOf("f.scrollTop = f.scrollHeight"), "mede ANTES de mudar o layout e rola DEPOIS");
  });
  test("repintar HTML idêntico não destrói o foco do teclado: cabeçalho e detalhes só são reescritos quando o conteúdo muda (pintarSe)", () => {
    assert.match(CONTROLADOR, /function pintarSe\(el, html\) \{ if \(ultimoHtml\.get\(el\) === html\) return false; el\.innerHTML = html; ultimoHtml\.set\(el, html\); return true; \}/);
    assert.equal(contar(CONTROLADOR, /pintarSe\(/g), 6, "definição + pintarChat (vazio, carregando, completo) + pintarContexto + refresh do cabeçalho");
    assert.ok(!/cab\.innerHTML\s*=/.test(CONTROLADOR), "ninguém escreve no cabeçalho sem passar por pintarSe");
    assert.match(CONTROLADOR, /pintarSe\(el, S\.thread\?\.contato \? ui\.htmlContexto/);
  });
  test("o botão de detalhes (dentro do cabeçalho memoizado) é sincronizado por pintarContexto — alternar e VOLTAR (mobile) passam por ele", () => {
    assert.match(corpo("pintarContexto"), /classList\.toggle\("is-ativo", S\.detalhes\)[\s\S]*aria-pressed/);
    assert.ok(!/function alternarDetalhes[\s\S]{0,400}classList\.toggle\("is-ativo"/.test(CONTROLADOR), "sem cópia divergente em alternarDetalhes");
    assert.match(CONTROLADOR, /if \(S\.tela === "detalhes"\) \{ definirTela\("chat"\); S\.detalhes = false; pintarContexto\(\); return; \}/);
  });
  test("'+N' abre os detalhes na lista completa (handler delegado, sem inline)", () => {
    assert.match(CONTROLADOR, /closest\("\[data-cc-ver-associacoes\]"\)\) \{ verAssociacoes\(\); return; \}/);
    const v = corpo("verAssociacoes"); assert.match(v, /alternarDetalhes\(true\)/); assert.match(v, /data-cc-ctx-associacoes/);
  });
});
