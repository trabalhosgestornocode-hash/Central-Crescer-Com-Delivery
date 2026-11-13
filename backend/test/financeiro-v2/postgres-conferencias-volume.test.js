// Execução 06C — desempenho das listas da Central no PostgreSQL local isolado, com volume SINTÉTICO de vários meses.
// Prova que a página e a contagem são resolvidas NO BANCO: durante a consulta paginada, nenhuma leitura de propostas
// devolve mais linhas que o tamanho da página, e os totais não dependem da página. Nenhum dado real é usado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarRepositorioPostgres } from "../../src/modules/financeiro-v2/index.js";
import { ESCOPOS_PADRAO, ctx, montar } from "./helpers/cenario.js";
import { abrirPool, criarBancoDeTeste, motivoParaPular } from "./helpers/postgres.js";
import { saiposVendas } from "./helpers/arquivos.js";

const pular = { skip: motivoParaPular(), timeout: 600000 };
const MESES = ["2026-06", "2026-07", "2026-08", "2026-09"];
const POR_DIA = 10;

test("volume de 4 meses: lista de propostas e documentos paginada no banco, totais exatos e independentes da página", pular, async () => {
  const { urlApp } = await criarBancoDeTeste(ESCOPOS_PADRAO);
  const pool = await abrirPool(urlApp);
  const leituras = [];
  let espiando = false;
  // Espião do cliente SQL: registra quantas linhas cada SELECT de propostas devolveu (só durante a consulta medida).
  const espiao = {
    async connect() {
      const cliente = await pool.connect();
      return {
        async query(texto, valores) {
          const r = await cliente.query(texto, valores);
          if (espiando && /from fv2_proposta/.test(texto)) leituras.push({ paginada: /\blimit\b|count\(\*\)|group by/.test(texto), linhas: r.rows.length });
          return r;
        },
        release: (...a) => cliente.release(...a),
      };
    },
  };
  const { nucleo: n } = montar({ repositorio: criarRepositorioPostgres({ pool: espiao }), relogio: () => new Date("2026-10-15T15:00:00Z") });
  const c = ctx();
  for (const mes of MESES) {
    const dias = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5)), 0)).getUTCDate();
    const pedidos = [];
    for (let d = 1; d <= 30 && d <= dias; d += 1) {
      for (let k = 0; k < POR_DIA; k += 1) pedidos.push({ pedido: `V-${mes}-${d}-${k}`, data: `${String(d).padStart(2, "0")}/${mes.slice(5)}/${mes.slice(0, 4)} ${String(10 + (k % 10)).padStart(2, "0")}:00`, canal: "Balcão", itens: 1000 + k * 37 + d, forma: "Dinheiro" });
    }
    const r = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "application/octet-stream", conteudo: saiposVendas(pedidos), periodoInicio: `${mes}-01`, periodoFim: `${mes}-${dias}` });
    const imp = (await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia })).importacao;
    await n.gerarPropostas(c, { importacaoId: imp.id });
  }
  const totalPorMes = 30 * POR_DIA;

  espiando = true;
  const t0 = performance.now();
  const p1 = await n.consultarPropostasParaRevisao(c, { competencia: "2026-08", tamanho: 20 });
  const ms = performance.now() - t0;
  espiando = false;
  assert.deepEqual([p1.itens.length, p1.paginacao.total, p1.paginacao.paginas], [20, totalPorMes, totalPorMes / 20]);
  assert.ok(leituras.length > 0 && leituras.every((x) => x.paginada), "toda leitura de propostas foi paginada, contada ou agregada no banco");
  assert.ok(Math.max(...leituras.map((x) => x.linhas)) <= 20, "nenhuma leitura trouxe mais que uma página");
  assert.ok(ms < 3000, `consulta paginada lenta: ${Math.round(ms)} ms`);
  // A página não altera os totais; a última página é a que sobra.
  const ultima = await n.consultarPropostasParaRevisao(c, { competencia: "2026-08", tamanho: 20, pagina: totalPorMes / 20 });
  assert.deepEqual([ultima.itens.length, ultima.porEstado, ultima.paginacao.total], [20, p1.porEstado, totalPorMes]);
  assert.equal(Object.values(p1.porEstado).reduce((a, b) => a + b, 0), totalPorMes);
  const vistos = new Set();
  for (let pg = 1; pg <= 3; pg += 1) for (const x of (await n.consultarPropostasParaRevisao(c, { competencia: "2026-08", tamanho: 20, pagina: pg })).itens) vistos.add(x.id);
  assert.equal(vistos.size, 60, "páginas não se repetem");
  // Documentos: um por mês; filtro por competência resolvido no banco.
  const docs = await n.consultarDocumentosImportados(c, { competencia: "2026-08" });
  assert.deepEqual([docs.paginacao.total, docs.itens[0].registrosAtivos], [1, totalPorMes]);
  assert.equal((await n.consultarDocumentosImportados(c, {})).paginacao.total, MESES.length);
  // Pendências e fechamento são leituras DERIVADAS (apuração + vendas + tesouraria): montadas sobre os registros do escopo.
  const t1 = performance.now();
  const pend = await n.consultarPendencias(c, { competencia: "2026-08", tamanho: 20 });
  const msPendencias = performance.now() - t1;
  assert.equal(pend.itens.length, 20);
  assert.ok(pend.contagem.porGrupo.VENDAS_E_AJUSTES.abertas >= totalPorMes, "cada proposta de venda em aberto é uma pendência");
  console.log(`[fv2-volume] pendências derivadas (todos os registros do escopo): ${Math.round(msPendencias)} ms.`);
  console.log(`[fv2-volume] ${MESES.length * totalPorMes} propostas sintéticas; página de 20 em ${Math.round(ms)} ms; maior leitura de propostas: ${Math.max(...leituras.map((x) => x.linhas))} linha(s).`);
});
