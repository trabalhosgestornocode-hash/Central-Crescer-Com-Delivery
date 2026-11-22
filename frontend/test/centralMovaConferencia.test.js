// Central de Operações MOVA — abas "Conferência Financeira" e "Documentos Recebidos" (Agente 2), sem navegador: um desenhista
// falso guarda a árvore e o teste lê os textos e os atributos. Dados SINTÉTICOS no formato das rotas /api/mova/conferencia e
// /api/mova/documentos-recebidos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarCentral } from "../financeiro-v2/centralMova.js";

const el = (tag, attrs = {}, ...filhos) => ({ tag, attrs, filhos: filhos.flat(Infinity).filter((f) => f !== null && f !== undefined && f !== false) });
const ui = { el, cartao: (t, ...c) => el("section", {}, el("h2", { texto: t }), ...c), tabela: (cab, linhas) => el("table", {}, cab.map((c) => el("th", { texto: c })), linhas.map((l) => el("tr", { "data-id": l.id }, l.celulas))),
  selo: ([t]) => el("span", { texto: t }), reais: (c) => `R$ ${(c / 100).toFixed(2)}`, horaBr: (d) => d, dataBr: (d) => d ?? "—", vazio: (t) => el("p", { texto: t }), dl: (p) => el("dl", {}, p.map(([k, v]) => [el("dt", { texto: k }), el("dd", {}, v)])) };
const textos = (n) => (typeof n === "string" || typeof n === "number" ? [String(n)] : n ? [n.attrs?.texto, ...(n.filhos ?? []).flatMap(textos)].filter(Boolean) : []);
const achar = (n, f) => (n && typeof n === "object" ? [...(f(n) ? [n] : []), ...(n.filhos ?? []).flatMap((x) => achar(x, f))] : []);

const PEND = (id, motivos, o = {}) => ({ id, empresa: "Empresa Sintética", unidade: "Loja Alfa", descricao: "Compra sintética", fornecedor: "Produtos Alvorada", categoria: "Insumos", competencia: "2026-11",
  vencimento: "2026-11-10", valorCentavos: 10000, saldoCentavos: 10000, pagoCentavos: 0, ajustesCentavos: 0, origem: "MANUAL", situacao: "VENCIDO", diasVencida: 12, documental: "SEM_DOCUMENTO",
  conciliacao: "SEM_PAGAMENTO_REGISTRADO", motivos, rotulos: motivos, proximaAcao: "Confirmar se foi paga ou programar o pagamento.", candidatas: [], duplicadas: [], ...o });
const CONFERENCIA = { posicao: "2026-11-22", empresa: "Empresa Sintética", unidade: "Loja Alfa", extratoDisponivel: true, recebimentoDocumental: true,
  indicadores: { contasVencidas: 2, saldoVencidoCentavos: 20000, contasParciais: 0, faltaParciaisCentavos: 0, documentosFaltantes: 2, abertasSemDocumento: 2, pagasSemComprovante: 0,
    pagamentosAguardandoConciliacao: 0, pagamentosSemExtratoCentavos: 0, possiveisPagamentosNoExtrato: 1, possiveisPagamentosCentavos: 10000, saidasSemVinculo: 3, saidasSemVinculoCentavos: 30000,
    fornecedoresNaoIdentificados: 0, semFornecedorCentavos: 0, possiveisDuplicidades: 0, documentosRecebidosMova: 1, documentosAguardandoConferencia: 1 },
  pendencias: [PEND("a", ["VENCIDA", "SEM_DOCUMENTO", "POSSIVEL_PAGAMENTO_NO_EXTRATO"], { conciliacao: "POSSIVEL_PAGAMENTO_NO_EXTRATO_NAO_CONFIRMADO", candidatas: [{ id: "s1", data: "2026-11-11", valorCentavos: 10000, livreCentavos: 10000, conta: "Conta Sintética" }] }),
    PEND("b", ["VENCIDA", "SEM_DOCUMENTO"])],
  saidas: { quantidade: 3, totalCentavos: 30000, de: "2026-11-01", ate: "2026-11-18", grupos: [{ motivo: "TARIFA_BANCARIA", rotulo: "Tarifa ou pacote bancário", quantidade: 1, totalCentavos: 5550 }],
    itens: [{ id: "s3", data: "2026-11-05", conta: "Conta Sintética", descricao: "PJ CONTA PJ", valorCentavos: 5550, livreCentavos: 5550, motivo: "TARIFA_BANCARIA", evidencia: "descrição do lançamento no extrato" }] } };
const DOCS = { recebimentoDocumental: true, podeConferir: true, itens: [{ sha256: "a".repeat(64), eventoId: "bly:1", recebidoEm: "2026-11-22T10:00:00Z", mime: "application/pdf", tamanhoBytes: 2048, nomeArquivo: null,
  legenda: "comprovante da alfa", evidenciaUnidade: "TEXTO", arquivoRemovido: false, remetente: { id: "…0201", nome: "Financeiro", perfil: "FINANCEIRO" },
  conferencia: { estado: "AGUARDANDO_CONFERENCIA", tipo: null, obrigacaoId: null, observacao: null, por: null, em: null, versao: 0 }, historico: [] }] };

function montar(enviados = []) {
  const ler = async (url) => (url.includes("/conferencia") ? { ok: true, dados: CONFERENCIA } : url.includes("/documentos-recebidos") ? { ok: true, dados: DOCS }
    : url.includes("/documento-relacionadas") ? { ok: true, dados: { busca: "", itens: [{ id: "c1", fornecedor: "Produtos Alvorada", vencimento: "2026-11-10", valorCentavos: 10000, saldoCentavos: 10000, situacao: "VENCIDO" }] } } : { ok: false, dados: {} });
  const enviar = async (url, corpo) => { enviados.push({ url, corpo }); return { ok: true }; };
  return criarCentral({ ui, ler, enviar });
}
const desenhado = async (central, aba, permissoes = ["financeiro_v2.ver", "financeiro_v2.documentos"]) => {
  const o = { fonte: "API", permissoes, unidadeId: "u", redesenhar: () => {} };
  central.desenhar(aba, o);
  await new Promise((r) => setTimeout(r, 0));
  return el("main", {}, central.desenhar(aba, o));
};

test("conferência: indicadores, pendências com motivo e próxima ação, aviso de não confirmado; filtro e detalhe só redesenham", async () => {
  const enviados = [];
  const c = montar(enviados);
  const t = textos(await desenhado(c, "conferencia")).join(" | ");
  for (const k of ["Contas vencidas", "Documentos faltantes", "Saídas do banco sem vínculo", "Possível pagamento no extrato", "Documentos recebidos pelo MOVA", "Próxima ação", "Empresa Sintética · Loja Alfa"]) assert.match(t, new RegExp(k));
  assert.match(t, /Possível pagamento no extrato \(NÃO confirmado\)/);
  assert.match(t, /Nada aqui baixa, cancela ou altera contas/);
  assert.equal((await c.agir({ dataset: { acao: "central-filtro", motivo: "POSSIVEL_PAGAMENTO_NO_EXTRATO" } })).ok, true);
  const filtrado = await desenhado(c, "conferencia");
  assert.deepEqual(achar(filtrado, (n) => n.tag === "tr" && n.attrs["data-id"] && ["a", "b"].includes(n.attrs["data-id"])).map((n) => n.attrs["data-id"]), ["a"]);
  await c.agir({ dataset: { acao: "central-detalhe", id: "a" } });
  assert.match(textos(await desenhado(c, "conferencia")).join(" "), /Saídas compatíveis|Conta Sintética/);
  await c.agir({ dataset: { acao: "central-saidas", motivo: "TARIFA_BANCARIA" } });
  assert.match(textos(await desenhado(c, "conferencia")).join(" "), /PJ CONTA PJ/);
  assert.equal(enviados.length, 0, "filtros, detalhes e saídas não enviam nada ao servidor");
});

test("documentos: fila com remetente mascarado; abrir original exige permissão; revisar envia só a conferência (não é baixa)", async () => {
  const enviados = [];
  const c = montar(enviados);
  const arvore = await desenhado(c, "documentos");
  const t = textos(arvore).join(" | ");
  assert.match(t, /Financeiro \(…0201\)/);
  assert.match(t, /NÃO é pagamento, baixa nem conciliação/);
  assert.equal(achar(arvore, (n) => n.attrs?.["data-acao"] === "arquivo").length, 1);
  const semDoc = textos(await desenhado(montar(), "documentos", ["financeiro_v2.ver"])).join(" ");
  assert.match(semDoc, /abrir exige permissão de documentos/);
  globalThis.prompt = () => "";
  const r1 = await c.agir({ dataset: { acao: "central-doc-relacionadas", sha: "a".repeat(64) } });
  assert.match(r1.texto, /Sugestão, não vínculo/);
  globalThis.prompt = () => "conferido no extrato";
  globalThis.document = { querySelector: (s) => (s.includes("data-tipo-doc") ? { value: "COMPROVANTE" } : s.includes("data-conta-doc") ? { value: "c1" } : null) };
  const r2 = await c.agir({ dataset: { acao: "central-doc-conferir", sha: "a".repeat(64), versao: "0", estado: "REVISADO" } });
  assert.match(r2.texto, /não é baixa nem conciliação/);
  assert.deepEqual(enviados, [{ url: "/api/fv2/acoes/mova/documento-conferir", corpo: { sha256: "a".repeat(64), versao: 0, estado: "REVISADO", tipo: "COMPROVANTE", obrigacaoId: "c1", observacao: "conferido no extrato" } }]);
  delete globalThis.prompt; delete globalThis.document;
});
