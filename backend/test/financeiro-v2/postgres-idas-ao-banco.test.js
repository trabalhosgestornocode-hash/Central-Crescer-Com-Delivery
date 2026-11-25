// 25/11 — IDAS AO BANCO por consulta, com volume próximo ao de uma loja real (~1.000 vendas no mês, cada uma com pagamento e
// proposta). Em produção cada ida custa ~60 ms (Render Ohio ↔ banco us-west-2): o tempo da Central de Conferências e do resumo
// era a SOMA das idas sequenciais (lotes de 200 ids), não o tempo do banco. Este teste conta as idas e trava um teto, para a
// lentidão não voltar sem ninguém perceber. Nenhum dado real é usado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarRepositorioPostgres } from "../../src/modules/financeiro-v2/index.js";
import { ESCOPOS_PADRAO, ctx, montar } from "./helpers/cenario.js";
import { abrirPool, criarAutoridadeDeTeste, criarBancoDeTeste, motivoParaPular } from "./helpers/postgres.js";
import { saiposVendas } from "./helpers/arquivos.js";

const pular = { skip: motivoParaPular(), timeout: 900000 };
const MES = "2026-10";
const POR_DIA = 35; // 30 dias × 35 = 1.050 vendas (Açaí em nov/2026: 1.043)
// Tetos (idas ao banco por consulta). Medido em 25/11 com este volume: Central 93 idas ANTES (lotes de 200), 54 DEPOIS (lotes
// de 1.000); resumo 19; contas a pagar 8; entregadores 9. O teto da Central fica abaixo do valor antigo: voltar aos lotes
// pequenos derruba o teste.
const TETO = { consultarPendencias: 60, consultarResumoFinanceiro: 25, consultarContasAPagar: 10, consultarEntregadoresProprios: 12 };

test("volume de loja real: Central de Conferências, resumo, contas e entregadores com poucas idas ao banco", pular, async () => {
  const { urlApp, urlAdmin, urlAutoridade } = await criarBancoDeTeste(ESCOPOS_PADRAO);
  const pool = await abrirPool(urlApp);
  let idas = 0;
  let contando = false;
  const espiao = {
    async connect() {
      const cliente = await pool.connect();
      return {
        async query(t, v) {
          if (contando) {
            idas += 1;
            if (process.env.IDAS_DETALHE) console.log("IDA", (/ from ([a-z0-9_]+)/.exec(t)?.[1] ?? String(t).trim().slice(0, 40)));
          }
          return cliente.query(t, v);
        },
        release: (...a) => cliente.release(...a),
      };
    },
    async query(t, v) { if (contando) idas += 1; return pool.query(t, v); },
  };
  const { nucleo: n } = montar({ repositorio: criarRepositorioPostgres({ pool: espiao, sessoes: criarAutoridadeDeTeste({ urlAutoridade, urlAdmin }) }), relogio: () => new Date("2026-11-25T15:00:00Z") });
  const c = ctx();
  const pedidos = [];
  for (let d = 1; d <= 30; d += 1) for (let k = 0; k < POR_DIA; k += 1) {
    pedidos.push({ pedido: `V-${d}-${k}`, data: `${String(d).padStart(2, "0")}/10/2026 ${String(10 + (k % 10)).padStart(2, "0")}:00`, canal: "Balcão", itens: 1000 + k * 37 + d, forma: k % 3 ? "Dinheiro" : "Pix" });
  }
  const r = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "application/octet-stream", conteudo: saiposVendas(pedidos), periodoInicio: `${MES}-01`, periodoFim: `${MES}-30` });
  const imp = (await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia })).importacao;
  await n.gerarPropostas(c, { importacaoId: imp.id });
  for (let volta = 0; volta < 30; volta += 1) {
    const lote = await n.consultarPropostasParaRevisao(c, { competencia: MES, tamanho: 100, estado: ["PROPOSTA", "AGUARDANDO_REVISAO", "APROVADA"] });
    const abertas = lote.itens.filter((p) => ["PROPOSTA", "AGUARDANDO_REVISAO", "APROVADA"].includes(p.estado));
    if (!abertas.length) break;
    for (const p of abertas) await n.aprovarEAplicarProposta(c, { propostaId: p.id });
  }
  const medir = async (op, entrada) => {
    idas = 0; contando = true;
    const t0 = performance.now();
    const saida = await n[op](c, entrada);
    contando = false;
    return { op, idas, ms: Math.round(performance.now() - t0), saida };
  };
  const medidas = [
    await medir("consultarPendencias", { competencia: MES, situacao: "A_RESOLVER", tamanho: 100 }),
    await medir("consultarResumoFinanceiro", { competencia: MES }),
    await medir("consultarContasAPagar", { tamanho: 100 }),
    await medir("consultarEntregadoresProprios", {}),
  ];
  const vendas = (await n.consultarVendas(c, { competencia: MES }).catch(() => null))?.resumo;
  console.log(JSON.stringify({ vendas: vendas ?? null, medidas: medidas.map(({ op, idas: i, ms }) => ({ op, idas: i, ms, emProducaoMs: i * 60 })) }));
  for (const m of medidas) assert.ok(m.idas <= TETO[m.op], `${m.op}: ${m.idas} idas ao banco (teto ${TETO[m.op]})`);
  await pool.end();
});
