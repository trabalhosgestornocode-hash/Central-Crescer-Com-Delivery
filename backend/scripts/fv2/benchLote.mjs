// Bancada LOCAL do lote de propostas (doc 51). Só PostgreSQL local isolado (FV2_REPOSITORIO=postgres, banco de
// scripts/fv2-banco-teste.mjs) e dados 100% SINTÉTICOS: aplica vendas por pedido pela rota de lote e mede consultas por
// venda, tempo por lote, falhas, repetição e duplicidade. A latência simulada (ms por consulta) imita a distância até o banco.
// Uso (na pasta backend):  FV2_REPOSITORIO=postgres node scripts/fv2/benchLote.mjs [latência ms] [vendas] [vendas por dia] [raiz do repo]
import { fileURLToPath } from "node:url";
const [LAT = "0", N = "480", POR_DIA = "60", RAIZ = fileURLToPath(new URL("../../..", import.meta.url)).replaceAll("\\", "/").replace(/\/$/, "")] = process.argv.slice(2);
const B = "file:///" + RAIZ + "/backend/";
const pg = (await import(B + "node_modules/pg/lib/index.js")).default;
let consultas = 0; const latencia = Number(LAT);
const orig = pg.Client.prototype.query;
pg.Client.prototype.query = function (...a) { consultas++; if (!latencia) return orig.apply(this, a); return new Promise((ok) => setTimeout(ok, latencia)).then(() => orig.apply(this, a)); };
const { ctx, montar } = await import(B + "test/financeiro-v2/helpers/cenario.js");
const { xlsx } = await import(B + "test/financeiro-v2/helpers/formatos.js");
const { ESCRITAS } = await import(B + "src/modules/fv2-integracao/escritas.js");
const { nucleo: n } = montar({ relogio: () => new Date("2026-11-28T12:00:00Z") });
const c = ctx();
const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
const CAB = ["Pedido", "Código da loja", "Nome da loja", "Tipo do pedido", "Turno", "Canal de venda", "Id do pedido no parceiro", "Número do pedido no parceiro", "Data da venda", "Consumidor", "Tem cupom", "Pagamento", "Está cancelado", "Motivo do cancelamento", "Itens", "Entrega", "Valor Entregador", "Entregador", "Bairro", "CEP", "Acréscimo", "Motivo de acréscimo", "Desconto", "Motivo do desconto", "Total", "Total taxa de serviço"];
const formas = ["Débito Master", "Crédito Visa", "Pago Online via Pix", "Dinheiro", "Débito Elo"];
const linhas = []; const dias = Math.ceil(Number(N) / Number(POR_DIA));
for (let i = 0; i < Number(N); i++) { const dia = String(1 + Math.floor(i / Number(POR_DIA))).padStart(2, "0"); const m = i % Number(POR_DIA); linhas.push(["Ficha", null, null, "F", "Dia", null, null, null, `${dia}/11/2026 ${String(10 + Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`, "Consumidor não identificado", "N", formas[i % 5], "N", null, 10 + (i % 40), null, null, null, null, "", 0, "", 0, "", 10 + (i % 40), 0]); }
const conteudo = xlsx([{ nome: "Vendas por período", linhas: [CAB, ...linhas] }]);
const r = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "application/octet-stream", conteudo, periodoInicio: "2026-11-01", periodoFim: `2026-11-${String(dias).padStart(2, "0")}` });
const imp = (await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? { aceitarPendencias: true, justificativa: "Sintético." } : {}) })).importacao;
await n.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
const lotes = []; let res;
do {
  const q0 = consultas; const t0 = performance.now();
  res = await ESCRITAS["/propostas/aprovar-e-aplicar-prontas"].fazer(n, c, { importacao: imp.id });
  const ms = performance.now() - t0; const q = consultas - q0;
  lotes.push({ aplicadas: res.aplicadas, falhas: res.falhas.length, restantes: res.restantes, segundos: +(ms / 1000).toFixed(1), msPorVenda: Math.round(ms / Math.max(1, res.aplicadas)), consultasPorVenda: +(q / Math.max(1, res.aplicadas)).toFixed(1) });
} while (res.restantes > 0 && res.falhas.length === 0);
const q0 = consultas; const rep = await ESCRITAS["/propostas/aprovar-e-aplicar-prontas"].fazer(n, c, { importacao: imp.id });
const vendas = (await n.consultarRegistros(c, { tipo: "VENDA" })).filter((v) => v.situacao === "ATIVA");
const total = vendas.reduce((s, v) => s + v.brutoCentavos, 0);
console.log(JSON.stringify({ versao: RAIZ, latenciaMs: latencia, vendas: Number(N), porDia: Number(POR_DIA), lotes, repeticao: { aplicadas: rep.aplicadas, prontas: rep.prontas, consultas: consultas - q0 }, vendasAtivas: vendas.length, totalCentavos: total, duplicadas: vendas.length - new Set(vendas.map((v) => v.fonte?.idExterno ?? v.fonteIdExterno)).size }));
process.exit(0);
