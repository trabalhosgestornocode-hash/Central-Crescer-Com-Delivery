#!/usr/bin/env node
// Demonstração LOCAL de Entregadores Próprios: dados 100% sintéticos, em memória, só em 127.0.0.1. Não lê .env e não acessa banco.
//   node scripts/fv2/demoEntregadores.mjs --porta=5192
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ACAO, criarCofreMemoria, criarNucleoFinanceiro, criarRepositorioMemoria } from "../../src/modules/financeiro-v2/index.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";

const PORTA = Number(process.argv.find((a) => a.startsWith("--porta="))?.split("=")[1] ?? 5192);
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "frontend");
const ORG = "aaaaaaaa-0000-4000-8000-000000000001"; const UNI = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ctx = { organizacaoId: ORG, unidadeId: UNI, usuarioId: "cccccccc-0000-4000-8000-000000000001", permissoes: Object.values(ACAO) };
const AGORA = new Date("2026-11-18T15:00:00.000Z");
const NOMES = ["Entregador Alfa", "Entregador Bravo", "Entregador Charlie"];
function apuracao({ inicio }) {
  const base = new Date(`${inicio}T12:00:00Z`);
  const dia = (i) => new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10);
  const entregas = [];
  NOMES.forEach((nome, n) => { for (let d = 0; d < 7; d += 1) for (let q = 0; q < 3 + n; q += 1) entregas.push({ id: `pedido:${inicio}-${n}-${d}-${q}`, tipo: "ENTREGA", entregadorChave: nome.toLowerCase(), entregadorNome: nome, data: dia(d), numeroPedido: `${1000 + n * 100 + d * 10 + q}`, situacao: "Entregue", valorCentavos: 700 + q * 50, elegivel: true, emRevisao: false }); });
  const hoje = AGORA.toISOString().slice(0, 10);
  return { disponivel: true, atualizadoEm: AGORA.toISOString(), entregas: entregas.filter((e) => e.data <= hoje), dias: Array.from({ length: 7 }, (_, i) => ({ data: dia(i), fonte: dia(i) <= hoje ? "foody" : "sem_dados", provisorio: dia(i) >= hoje || inicio === "2026-11-09", aberto: dia(i) >= hoje, triagem: inicio === "2026-11-09" ? 2 : 0 })) };
}
const cofre = criarCofreMemoria();
const nucleo = criarNucleoFinanceiro({ repositorio: criarRepositorioMemoria(), escoposAutorizados: [{ organizacaoId: ORG, unidadeId: UNI }], relogio: () => AGORA, cofre, entregadores: { fonte: { apurar: async (p) => apuracao(p) }, inicioDaOperacao: "2026-11-23", cofreDeNotas: cofre } });
await nucleo.implantarPlanoDeContas(ctx, { modelo: "ACAITERIA" });
const banco = await nucleo.configurarContaFinanceira(ctx, { tipo: "BANCARIA", nome: "Banco Demonstração", instituicao: "Demo" });
await nucleo.registrarObrigacao(ctx, { contraparteNova: { tipo: "FORNECEDOR", nome: "Entregador Entregador Alfa" }, valorOriginalCentavos: 5000, categoria: "OUTRAS_DESPESAS", descricao: "Conta manual sintética", competencia: "2026-11", dataEmissao: "2026-11-09", vencimento: "2026-11-11" });
await nucleo.registrarMovimentacao(ctx, { contaId: banco.id, dataEfetiva: "2026-11-11", sentido: "SAIDA", valorCentavos: 20000, natureza: "PAGAMENTO", descricao: "PIX sintético do extrato" });
await nucleo.fecharSemanaDeEntregadores(ctx, { inicio: "2026-11-02", reconciliacao: true, justificativa: "Reconciliação sintética da demonstração." });

const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".jpeg": "image/jpeg" };
const json = (res, status, corpo) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(corpo)); };
const lerCorpo = async (req) => { const p = []; for await (const c of req) p.push(c); return p.length ? JSON.parse(Buffer.concat(p).toString("utf8")) : {}; };
createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  try {
    if (u.pathname === "/api/fv2/sessao") return json(res, 200, { modo: "DEMONSTRACAO", dataBase: AGORA.toISOString().slice(0, 10), csrf: "demo", pessoasDemo: [], escritaHabilitada: true, unidades: [{ id: UNI, nome: "Unidade Demonstração", permissoes: ctx.permissoes }] });
    if (u.pathname.startsWith("/api/fv2/acoes/")) {
      const e = ESCRITAS[u.pathname.slice("/api/fv2/acoes".length)];
      if (!e) return json(res, 404, { erro: "NAO_ENCONTRADO", mensagem: "Ação indisponível na demonstração." });
      const { unidade: _u, confirmar: _c, ...corpo } = await lerCorpo(req);
      return json(res, 200, (await e.fazer(nucleo, ctx, corpo)) ?? { ok: true });
    }
    if (u.pathname.startsWith("/api/fv2/")) {
      const c = CONSULTAS[u.pathname.slice("/api/fv2".length)];
      if (!c) return json(res, 404, { erro: "NAO_ENCONTRADO", mensagem: "Consulta indisponível na demonstração." });
      return json(res, 200, await c(nucleo, ctx, Object.fromEntries(u.searchParams)));
    }
    const caminho = normalize(u.pathname === "/" ? "/financeiro-v2/index.html" : u.pathname).replace(/^(\.\.[/\\])+/, "");
    const alvo = join(RAIZ, caminho);
    if (!alvo.startsWith(RAIZ)) return json(res, 403, {});
    const arquivo = await readFile(alvo);
    res.writeHead(200, { "content-type": TIPOS[extname(alvo)] ?? "application/octet-stream" });
    return res.end(arquivo);
  } catch (e) {
    if (e?.code === "ENOENT") return json(res, 404, {});
    return json(res, 400, { erro: e?.codigo ?? "FALHA", codigo: e?.codigo ?? "FALHA", mensagem: e?.message ?? "Falha.", motivo: e?.detalhes?.motivo ?? null });
  }
}).listen(PORTA, "127.0.0.1", () => process.stdout.write(`Demonstração em http://127.0.0.1:${PORTA}/financeiro-v2/index.html#/entregadores-proprios\n`));
