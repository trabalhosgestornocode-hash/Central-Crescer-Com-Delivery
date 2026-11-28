// Central MOVA — aba "Envio e Limites" (fila priorizada, limites configuráveis) e cartão "Identidade fiscal" (aprendida das notas), sem
// navegador: um desenhista falso guarda a árvore e o teste lê textos e atributos. Dados SINTÉTICOS no formato de /mova/envio-painel e /mova/identidade-fiscal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarCentral } from "../financeiro-v2/centralMova.js";

const el = (tag, attrs = {}, ...filhos) => ({ tag, attrs, filhos: filhos.flat(Infinity).filter((f) => f !== null && f !== undefined && f !== false) });
const ui = {
  el, cartao: (t, ...c) => el("section", {}, el("h2", { texto: t }), ...c),
  tabela: (cab, linhas, vazioTexto) => (linhas.length ? el("table", {}, cab.map((c) => el("th", { texto: c })), linhas.map((l) => el("tr", { "data-id": l.id }, l.celulas))) : el("p", { texto: vazioTexto })),
  selo: ([t]) => el("span", { texto: t }), reais: (c) => `R$ ${(c / 100).toFixed(2)}`, horaBr: (d) => d, dataBr: (d) => d ?? "—", vazio: (t) => el("p", { texto: t }),
  dl: (p) => el("dl", {}, p.map((x) => el("div", {}, el("dt", { texto: x[0] }), el("dd", { texto: x[1] })))),
};
const textos = (n) => (typeof n === "string" || typeof n === "number" ? [String(n)] : n ? [n.attrs?.texto, ...(n.filhos ?? []).flatMap(textos)].filter(Boolean) : []);
const achar = (n, f) => (n && typeof n === "object" ? [...(f(n) ? [n] : []), ...(n.filhos ?? []).flatMap((x) => achar(x, f))] : []);

const ENVIO = { disponivel: true, filaPrioritariaLigada: true, podeConfigurar: true,
  limites: { proativasDia: 2000, proativasPorPrivadoDia: 100, proativasPorGrupoDia: 500, reservaCriticaPct: 10, reservaAltaPct: 10, porMinutoTotal: 20, porMinutoPorConversa: 6, respostasPorConversaPorHora: 120 },
  uso: { unidade: 340, pctDaUnidade: 17, total: 900, pctTotal: 45, porCategoria: { TRANSACIONAL: 40, PROATIVA: 300 } },
  fila: { estados: { PENDENTE: 3, ENVIADA: 340 }, represamento: { porPrioridade: [{ prioridade: 2, quantidade: 3 }], motivos: [{ motivo: "LIMITE_DIARIO", quantidade: 3 }] } },
  alertas: [{ tipo: "LIMITE_DIARIO", faixa: 70, criadoEm: "2026-11-30T12:00:00Z" }], historicoDeLimites: [],
  ia: { respostas: 10, deterministicas: 9, chamadasIa: 1, tokensEntrada: 300, tokensSaida: 40 } };
const FISCAL = (extra = {}) => ({ disponivel: true, podeAprender: true, tomadorDaUnidade: { situacao: "APRENDIDO", documento: "**.***.700/****-01" },
  contagens: { disponivel: true, consolidadas: 9, emRevisao: 1, evidenciasFortes: 25, evidenciasFracas: 3, leituras: { arquivosLidos: 7, chamadasIa: 0, tokensEntrada: 0, tokensSaida: 0 } },
  itens: [{ entregador: "zeca", situacao: "EM_REVISAO", motivo: "DOCUMENTO_USADO_POR_OUTRO_ENTREGADOR", origem: "PRIMEIRA_NOTA", documento: "**.***.222/****-01" },
    { entregador: "mauricio", situacao: "CONSOLIDADA", motivo: "EVIDENCIA_INEQUIVOCA", origem: "HISTORICO", documento: "**.***.111/****-01" }], ...extra });
const ENTREGADORES = { ligado: true, cadastros: [], itens: [], notas: [], envios: [] };

function montar(enviados = [], fiscal = FISCAL()) {
  const ler = async (url) => ({ ok: true, dados: url.includes("/envio-painel") ? ENVIO : url.includes("/identidade-fiscal") ? fiscal : url.includes("/entregadores-oficiais") ? { itens: [] } : url.includes("/entregadores") ? ENTREGADORES : {} });
  const enviar = async (url, corpo) => { enviados.push({ url, corpo }); return { ok: true, dados: {} }; };
  return criarCentral({ ui, ler, enviar });
}
const desenhado = async (central, aba, permissoes) => {
  const o = { fonte: "API", permissoes, unidadeId: "uni-1", redesenhar: () => {} };
  central.desenhar(aba, o);
  await new Promise((r) => setTimeout(r, 0));
  return el("main", {}, central.desenhar(aba, o));
};
const CONF = ["financeiro_v2.ver", "financeiro_v2.configurar"], VER = ["financeiro_v2.ver"];

test("aba Envio e Limites: uso do dia, limites em vigor, fila, alertas e IA × determinístico; formulário só para quem configura", async () => {
  const arvore = await desenhado(montar(), "envio", CONF);
  const t = textos(arvore).join(" | ");
  assert.match(t, /Limites em vigor/);
  assert.match(t, /2000/);
  assert.match(t, /Proativas por conversa privada\/dia/);
  assert.match(t, /1 × 9/, "IA × determinísticas");
  assert.match(t, /Ajustar um limite/);
  const so = textos(await desenhado(montar(), "envio", VER)).join(" | ");
  assert.ok(!/Ajustar um limite/.test(so), "quem só vê não altera limites");
});

test("Identidade fiscal: contagens, casos em revisão com documento mascarado e botão de reaprender só com permissão; nenhum formulário de cadastro", async () => {
  const arvore = await desenhado(montar(), "entregadores", CONF);
  const t = textos(arvore).join(" | ");
  assert.match(t, /Identidade fiscal dos entregadores/);
  assert.match(t, /Reconhecidos automaticamente/);
  assert.match(t, /0 chamada\(s\) de IA/);
  assert.match(t, /CPF\/CNPJ já usado por outro entregador/);
  assert.ok(t.includes("**.***.222/****-01"));
  assert.ok(!t.includes("**.***.111/****-01"), "só os casos excepcionais aparecem na lista");
  assert.equal(achar(arvore, (n) => n.attrs?.["data-acao"] === "central-identidade-aprender").length, 1);
  assert.equal(achar(arvore, (n) => n.tag === "input" && /cpf|cnpj|razao|fantasia/i.test(n.attrs?.name ?? "")).length, 0, "nenhum campo de cadastro fiscal manual");
  const so = await desenhado(montar(), "entregadores", VER);
  assert.equal(achar(so, (n) => n.attrs?.["data-acao"] === "central-identidade-aprender").length, 0);
});

test("Identidade fiscal indisponível (sem a migração): o cartão some e o resto da aba segue", async () => {
  const arvore = await desenhado(montar([], { disponivel: false }), "entregadores", CONF);
  assert.ok(!textos(arvore).join(" ").includes("Identidade fiscal dos entregadores"));
  assert.match(textos(arvore).join(" "), /Entregadores autorizados no WhatsApp/);
});

test("ação reaprender: envia à rota da identidade fiscal sem parâmetros (a unidade vem da sessão)", async () => {
  const enviados = [];
  const c = montar(enviados);
  await c.agir({ dataset: { acao: "central-identidade-aprender" }, closest: () => null });
  assert.deepEqual(enviados.filter((e) => e.url.includes("identidade-fiscal-aprender")).map((e) => e.corpo), [{}]);
});
