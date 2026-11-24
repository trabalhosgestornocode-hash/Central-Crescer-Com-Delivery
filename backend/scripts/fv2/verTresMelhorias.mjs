// VERIFICAÇÃO VISUAL LOCAL (dados 100% SINTÉTICOS em memória; nenhum banco, nenhum .env, nenhuma rede).
// Gera frontend/financeiro-v2/_verificacao-tres-melhorias.html com as telas REAIS desenhadas a partir das respostas REAIS
// do núcleo: DRE com a quantidade de entregas, prévia da baixa agrupada (8 contas × 1 saída) e o pagamento agrupado.
// Uso: node scripts/fv2/verTresMelhorias.mjs  → abrir o HTML gerado por um servidor estático local. Não é rota do aplicativo.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = join(aqui, "..", "..", "..");
const imp = (p) => import(pathToFileURL(join(raiz, p)));
const { criarNucleoFinanceiro, criarRepositorioMemoria, criarCofreMemoria, ACAO } = await imp("backend/src/modules/financeiro-v2/index.js");
const { CONSULTAS } = await imp("backend/src/modules/fv2-integracao/consultas.js");
const telas = await imp("frontend/financeiro-v2/telas.js");
const tes = await imp("frontend/financeiro-v2/telasTesouraria.js");

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const UNI = "aaaaaaaa-0000-4000-8000-0000000000a1";
const c = { organizacaoId: ORG, unidadeId: UNI, usuarioId: "cccccccc-0000-4000-8000-000000000001", permissoes: Object.values(ACAO) };
// Porta do parser SINTÉTICA: 3 entregas elegíveis (uma repetida), 1 sem direito à taxa e um PIX (que não conta).
const fonte = { apurar: async () => ({ disponivel: true, dias: [{ data: "2026-11-03", fonte: "foody" }], entregas: [
  { id: "p1", tipo: "ENTREGA", entregadorChave: "a", entregadorNome: "Entregador A", data: "2026-11-03", valorCentavos: 700, elegivel: true },
  { id: "p1", tipo: "ENTREGA", entregadorChave: "a", entregadorNome: "Entregador A", data: "2026-11-03", valorCentavos: 700, elegivel: true },
  { id: "p2", tipo: "ENTREGA", entregadorChave: "a", entregadorNome: "Entregador A", data: "2026-11-04", valorCentavos: 700, elegivel: true },
  { id: "p3", tipo: "ENTREGA", entregadorChave: "b", entregadorNome: "Entregador B", data: "2026-11-04", valorCentavos: 700, elegivel: true },
  { id: "p4", tipo: "ENTREGA", entregadorChave: "b", entregadorNome: "Entregador B", data: "2026-11-05", valorCentavos: 700, elegivel: false },
  { id: "l1", tipo: "AJUSTE", entregadorChave: "b", entregadorNome: "Entregador B", data: "2026-11-05", valorCentavos: 2100, elegivel: true },
] }) };
const cofreMem = criarCofreMemoria();
const n = criarNucleoFinanceiro({ repositorio: criarRepositorioMemoria(), escoposAutorizados: [{ organizacaoId: ORG, unidadeId: UNI }], relogio: () => new Date("2026-11-20T15:00:00Z"), cofre: cofreMem, entregadores: { fonte } });
await n.implantarPlanoDeContas(c, { modelo: "SUBWAY" });

const forn = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Funcionários — Vale-refeição" });
const ent = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Empresa de entregas (sintética)" });
const banco = await n.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco (sintético)", instituicao: "Banco Teste" });
await n.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-11-03", brutoCentavos: 5000000, fonte: { sistema: "MANUAL", idExterno: "V1" }, pagamentos: [{ forma: "PIX", valorCentavos: 5000000 }] });
const conta = (categoria, valor, descricao, contraparteId = ent.id, extra = {}) => n.registrarObrigacao(c, { contraparteId, valorOriginalCentavos: valor, categoria, descricao, competencia: "2026-11", dataEmissao: "2026-11-17", vencimento: "2026-11-17", ...extra });
await conta("ENTREGADORES_PROPRIOS", 623000, "Entregadores próprios — semanas de novembro (sintético)");
await conta("ENTREGAS_TERCEIRIZADAS", 355500, "Empresa de entregas — 02/11 a 15/11 (sintético)");
for (const d of ["02", "04", "08"]) await conta("COMISSOES_DE_PLATAFORMA", 2398, `Entrega sob demanda contratada no iFood de 2026-11-${d}`, ent.id, { fonte: { sistema: "IFOOD", idExterno: `ifood-conciliacao:2026-11-${d}:ENTREGA_SOB_DEMANDA:v1` } });
const VR = [12000, 10500, 12000, 10500, 18000, 18000, 12000, 10500].map((v, i) => [`FUNCIONÁRIO ${i + 1}`, v]);
const ids = [];
for (const [nome, v] of VR) ids.push((await conta("VALE_REFEICAO", v, `VALE REFEIÇÃO ${nome} ENTRE OS DIAS 16/11 A 30/11 (sintético)`, forn.id)).obrigacoes[0].id);
const pix = (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-11-17", sentido: "SAIDA", valorCentavos: 103500, natureza: "PAGAMENTO", descricao: "DEBITO PAGAMENTO PIX ( Doc.: PGTO PIX / OPERADORA DE BENEFICIOS SINTETICA )", fonte: { sistema: "UNICRED", idExterno: "EXT-SINT-1" } })).movimentacao;

const p = { competencia: "2026-11" };
const dre = await CONSULTAS["/dre"](n, c, p);
const previa = await n.previaDaBaixaAgrupada(c, { obrigacaoIds: ids, movimentacaoId: pix.id });
const cofre = await n.registrarDocumento(c, { origem: "MANUAL", arquivoId: (await n.cofre?.guardar?.(c, { conteudo: new TextEncoder().encode("%PDF-1.4\n%%EOF\n"), tipoMime: "application/pdf" }))?.arquivoId ?? "x", hashSha256: "0".repeat(64), tipo: "COMPROVANTE", recebidoEm: "2026-11-17", descricao: "Comprovante sintético" });
let pagamento = null;
try {
  await n.vincularPagamentoAgrupado(c, { movimentacaoId: pix.id, versaoMovimentacao: pix.versao, obrigacaoIds: ids, ...(cofre?.documento ? { documentoId: cofre.documento.id } : {}), justificativa: "Verificação visual (sintético).", confirmar: true });
  pagamento = await n.consultarPagamentoAgrupado(c, { movimentacaoId: pix.id });
} catch (e) { pagamento = { erro: e.message }; }
const cal = await n.consultarCalendarioFinanceiro(c, { mes: "2026-11" });
const ctxTela = { permissoes: Object.values(ACAO) };
const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Verificação — três melhorias (sintético)</title><link rel="stylesheet" href="fv2.css">
<style>body{padding:24px;max-width:1180px;margin:0 auto}.painel-verif{border:1px dashed #999;padding:16px;margin:24px 0;border-radius:8px}</style></head><body>
<p class="aviso aviso--alerta">Página de verificação local com dados SINTÉTICOS. Não é rota do aplicativo.</p>
<main id="conteudo">
<section class="painel-verif" id="v-dre">${telas.dre(dre, { unidadeNome: "Unidade sintética" })}</section>
<section class="painel-verif" id="v-previa">${tes.detalheBaixaAgrupada(previa, ctxTela)}</section>
<section class="painel-verif" id="v-pagamento">${pagamento?.erro ? `<p>${pagamento.erro}</p>` : tes.detalhePagamentoAgrupado(pagamento, ctxTela)}</section>
${cal ? `<section class="painel-verif" id="v-dia">${tes.diaDoCalendario(cal.dias.find((d) => d.data === "2026-11-17"), ctxTela)}</section>` : ""}
</main>
<script>for (const b of document.querySelectorAll("[data-alternar]")) b.addEventListener("click", () => { const alvo = document.getElementById(b.getAttribute("aria-controls")); const ab = b.getAttribute("aria-expanded") !== "true"; b.setAttribute("aria-expanded", String(ab)); if (alvo) alvo.hidden = !ab; });</script>
</body></html>`;
writeFileSync(join(raiz, "frontend", "financeiro-v2", "_verificacao-tres-melhorias.html"), html);
console.log(JSON.stringify({ entregas: dre.entregas, soma: previa.somaCentavos, diferenca: previa.escolhida?.diferencaCentavos, bloqueios: previa.escolhida?.bloqueios, pagamento: pagamento?.erro ?? pagamento?.contas?.length, calendario: Boolean(cal) }, null, 1));
