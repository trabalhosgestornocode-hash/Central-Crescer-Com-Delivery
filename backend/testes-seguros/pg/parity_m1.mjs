// Prova de PARIDADE JS × SQL da mitigação M1 (LD-011): o conjunto de pendências de conciliação calculado pelo BANCO tem de ser
// IGUAL ao de `conciliar()` (aplicação) para os mesmos dados. Cenários determinísticos (casos de borda) + aleatórios com semente.
//
// Uso (cluster DESCARTÁVEL local; nunca outro banco):
//   export PG_CLUSTER_DIR=C:/Users/ponte/pg-descartavel        # com MARCADOR_DESCARTAVEL
//   bash backend/testes-seguros/pg/sim_supabase.sh               # cria o banco "sim" (120+121+122)
//   M1_FN=fin_conciliacao_pendencias_ids node backend/testes-seguros/pg/parity_m1.mjs [--aleatorios=200] [--semente=7]
// A função SQL precisa ter a assinatura (org uuid, unidade uuid, mes date) -> text[] e ser EXECUTÁVEL pelo service_role.
// Sem a M1 implementada o script falha de propósito (a função não existe).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const { conciliar } = await import(pathToFileURL(path.join(aqui, "../../src/financeiro-calculos/conciliacao.js")).href);

const FN = process.env.M1_FN || "fin_conciliacao_pendencias_ids";
const CLUSTER = process.env.PG_CLUSTER_DIR;
const PSQL = process.env.PSQL || "C:/Program Files/PostgreSQL/17/bin/psql.exe";
const PORT = process.env.PGPORT || "54321";
const DB = process.env.M1_DB || "sim";
const arg = (n, d) => Number((process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).split("=")[1]);
const ALEATORIOS = arg("aleatorios", 120); const SEMENTE = arg("semente", 7);

if (!CLUSTER || !existsSync(path.join(CLUSTER, "MARCADOR_DESCARTAVEL"))) { console.error("defina PG_CLUSTER_DIR de um cluster DESCARTÁVEL (arquivo MARCADOR_DESCARTAVEL)"); process.exit(2); }
function psql(sql, { quiet = true } = {}) {
  const r = spawnSync(PSQL, ["-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-d", DB, "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", env: { ...process.env, PGCLIENTENCODING: "UTF8" } });
  if (r.status !== 0) throw new Error((r.stderr || "").trim().split("\n").slice(0, 3).join(" | "));
  return (r.stdout || "").trim();
}
const dd = psql("show data_directory");
if (!dd.replaceAll("\\", "/").includes(CLUSTER.replaceAll("\\", "/"))) { console.error("cluster inesperado"); process.exit(2); }

// NONCE por execução: o script pode rodar várias vezes no mesmo banco sem colidir (as categorias usam ids fixos, `on conflict do nothing`).
const NONCE = (Date.now() % 0xffffffff).toString(16).padStart(8, "0");
const uuidFixo = (a, b) => `00000000-0000-4000-${String(a).padStart(4, "0")}-${String(b).padStart(12, "0")}`;
const uuid = (a, b) => `${NONCE}-0000-4000-${String(a).padStart(4, "0")}-${String(b).padStart(12, "0")}`;
const ORG = "00000000-0000-0000-0000-0000000000a1";
const ORG2 = "00000000-0000-0000-0000-0000000000b1";   // 2ª organização: prova de isolamento ENTRE organizações (dados nas mesmas datas)
const CAT2 = { receita: uuidFixo(11, 1), despesa: uuidFixo(11, 2), custo: uuidFixo(11, 3), transf: uuidFixo(11, 4), saldo: uuidFixo(11, 5) };
const CAT = { receita: uuidFixo(1, 1), despesa: uuidFixo(1, 2), custo: uuidFixo(1, 3), transf: uuidFixo(1, 4), saldo: uuidFixo(1, 5) };
let CUR = null;   // { org, cat } do cenário em materialização
const PAPEL = { [CAT.receita]: "receita_operacional", [CAT.despesa]: "despesa_fixa", [CAT.custo]: "custo_variavel", [CAT.transf]: "transferencia", [CAT.saldo]: "saldo_anterior" };
Object.assign(PAPEL, { [CAT2.receita]: "receita_operacional", [CAT2.despesa]: "despesa_fixa", [CAT2.custo]: "custo_variavel", [CAT2.transf]: "transferencia", [CAT2.saldo]: "saldo_anterior" });
const q = (v) => (v === null || v === undefined ? "null" : `'${String(v).replaceAll("'", "''")}'`);

function prng(seed) { let t = seed >>> 0; return () => { t += 0x6d2b79f5; let x = Math.imul(t ^ (t >>> 15), 1 | t); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }

/** Cenário = { nome, mes:'2030-01', contas:[{tipo,canal}], lancs:[{conta,cat,sentido,valor,dia,status}], refs:[{tipo,canal,valor,dia,status}], resols:[{escopo,dia,valor,status}], excecoesSangria:[catKey] } */
const D = (dia) => String(dia).padStart(2, "0");
const base = (nome, extra) => ({ nome, mes: "2030-01", contas: [{ tipo: "caixa_fisico", canal: null }, { tipo: "banco", canal: "STONE" }], lancs: [], refs: [], resols: [], excecoesSangria: [], ...extra });
const fixos = [
  base("sem nada"),
  base("só lançamentos (sem referência) ⇒ nada aberto", { lancs: [{ conta: 0, cat: "receita", sentido: "entrada", valor: 5000, dia: 3, status: "realizado" }] }),
  base("só venda (sem taxa) ⇒ sem_referencia, NÃO é pendência", { refs: [{ tipo: "venda", canal: null, valor: 100000, dia: 10, status: "ativa" }] }),
  base("venda + taxa, sem recebimento ⇒ ponte aberta (prova do R-1)", { refs: [{ tipo: "venda", canal: null, valor: 100000, dia: 10, status: "ativa" }, { tipo: "taxa", canal: "STONE", valor: 10000, dia: 10, status: "ativa" }] }),
  base("ponte fecha exatamente ⇒ conciliado", { lancs: [{ conta: 1, cat: "receita", sentido: "entrada", valor: 90000, dia: 5, status: "realizado" }], refs: [{ tipo: "venda", canal: null, valor: 100000, dia: 10, status: "ativa" }, { tipo: "taxa", canal: "STONE", valor: 10000, dia: 10, status: "ativa" }] }),
  base("ponte com resolução total ⇒ resolvida", { refs: [{ tipo: "venda", canal: null, valor: 100000, dia: 10, status: "ativa" }, { tipo: "taxa", canal: "STONE", valor: 10000, dia: 10, status: "ativa" }], resols: [{ escopo: "ponte_mensal", dia: 1, valor: 90000, status: "vigente" }] }),
  base("ponte com resolução parcial ⇒ parcialmente_resolvido (aberta)", { refs: [{ tipo: "venda", canal: null, valor: 100000, dia: 10, status: "ativa" }, { tipo: "taxa", canal: "STONE", valor: 10000, dia: 10, status: "ativa" }], resols: [{ escopo: "ponte_mensal", dia: 1, valor: 50000, status: "vigente" }] }),
  base("resolução REVOGADA não conta ⇒ continua aberta", { refs: [{ tipo: "venda", canal: null, valor: 100000, dia: 10, status: "ativa" }, { tipo: "taxa", canal: "STONE", valor: 10000, dia: 10, status: "ativa" }], resols: [{ escopo: "ponte_mensal", dia: 1, valor: 90000, status: "revogada" }] }),
  base("referência CANCELADA é ignorada", { refs: [{ tipo: "venda", canal: null, valor: 100000, dia: 10, status: "cancelada" }, { tipo: "taxa", canal: "STONE", valor: 10000, dia: 10, status: "ativa" }] }),
  base("caixa do dia: fluxo ≠ referência 'dinheiro' ⇒ caixa_dia aberto", { lancs: [{ conta: 0, cat: "receita", sentido: "entrada", valor: 7000, dia: 4, status: "realizado" }], refs: [{ tipo: "dinheiro", canal: null, valor: 6500, dia: 4, status: "ativa" }] }),
  base("caixa do dia: igual ⇒ conciliado", { lancs: [{ conta: 0, cat: "receita", sentido: "entrada", valor: 7000, dia: 4, status: "realizado" }], refs: [{ tipo: "dinheiro", canal: null, valor: 7000, dia: 4, status: "ativa" }] }),
  base("caixa do dia: sem referência ⇒ sem_referencia (não aberto)", { lancs: [{ conta: 0, cat: "receita", sentido: "entrada", valor: 7000, dia: 4, status: "realizado" }] }),
  base("sangria do dia diverge ⇒ sangria_dia aberto", { lancs: [{ conta: 0, cat: "despesa", sentido: "saida", valor: 3000, dia: 6, status: "realizado" }], refs: [{ tipo: "sangria", canal: null, valor: 2000, dia: 6, status: "ativa" }] }),
  base("sangria com EXCEÇÃO aprovada da categoria ⇒ não conta no fluxo", { lancs: [{ conta: 0, cat: "despesa", sentido: "saida", valor: 3000, dia: 6, status: "realizado" }], refs: [{ tipo: "sangria", canal: null, valor: 2000, dia: 6, status: "ativa" }], excecoesSangria: ["despesa"] }),
  base("lançamento PREVISTO e CANCELADO não contam", { lancs: [{ conta: 0, cat: "receita", sentido: "entrada", valor: 7000, dia: 4, status: "previsto" }, { conta: 0, cat: "receita", sentido: "entrada", valor: 9000, dia: 4, status: "cancelado" }], refs: [{ tipo: "dinheiro", canal: null, valor: 100, dia: 4, status: "ativa" }] }),
  base("saldo_anterior e categoria nula ficam fora do fluxo", { lancs: [{ conta: 0, cat: "saldo", sentido: "entrada", valor: 7000, dia: 4, status: "realizado" }, { conta: 0, cat: null, sentido: "entrada", valor: 800, dia: 4, status: "realizado" }], refs: [{ tipo: "dinheiro", canal: null, valor: 0, dia: 4, status: "ativa" }] }),
  base("referência de outro mês não entra", { refs: [{ tipo: "venda", canal: null, valor: 100000, dia: 10, status: "ativa", mesOffset: -1 }, { tipo: "taxa", canal: "STONE", valor: 10000, dia: 10, status: "ativa" }] }),
  base("PREVISTO muda o resultado (dinheiro exato só com o realizado)", { lancs: [{ conta: 0, cat: "receita", sentido: "entrada", valor: 7000, dia: 4, status: "realizado" }, { conta: 0, cat: "receita", sentido: "entrada", valor: 500, dia: 4, status: "previsto" }], refs: [{ tipo: "dinheiro", canal: null, valor: 7000, dia: 4, status: "ativa" }] }),
  base("CANCELADO muda o resultado", { lancs: [{ conta: 0, cat: "receita", sentido: "entrada", valor: 7000, dia: 4, status: "realizado" }, { conta: 0, cat: "receita", sentido: "entrada", valor: 500, dia: 4, status: "cancelado" }], refs: [{ tipo: "dinheiro", canal: null, valor: 7000, dia: 4, status: "ativa" }] }),
  base("exceção de sangria muda o resultado (sangria exata só sem a categoria excepcionada)", { lancs: [{ conta: 0, cat: "despesa", sentido: "saida", valor: 3000, dia: 6, status: "realizado" }, { conta: 0, cat: "custo", sentido: "saida", valor: 2000, dia: 6, status: "realizado" }], refs: [{ tipo: "sangria", canal: null, valor: 2000, dia: 6, status: "ativa" }], excecoesSangria: ["despesa"] }),
  base("saída de categoria saldo_anterior em caixa não conta na sangria", { lancs: [{ conta: 0, cat: "saldo", sentido: "saida", valor: 900, dia: 6, status: "realizado" }, { conta: 0, cat: "despesa", sentido: "saida", valor: 3000, dia: 6, status: "realizado" }], refs: [{ tipo: "sangria", canal: null, valor: 3000, dia: 6, status: "ativa" }] }),
  base("referência CANCELADA não pode fechar a diferença", { lancs: [{ conta: 0, cat: "receita", sentido: "entrada", valor: 7000, dia: 4, status: "realizado" }], refs: [{ tipo: "dinheiro", canal: null, valor: 7000, dia: 4, status: "cancelada" }, { tipo: "dinheiro", canal: null, valor: 6000, dia: 4, status: "ativa" }] }),
  base("resolução REVOGADA não fecha a diferença do caixa", { lancs: [{ conta: 0, cat: "receita", sentido: "entrada", valor: 7000, dia: 4, status: "realizado" }], refs: [{ tipo: "dinheiro", canal: null, valor: 6000, dia: 4, status: "ativa" }], resols: [{ escopo: "caixa_dia", dia: 4, valor: 1000, status: "revogada" }] }),
  base("venda + taxa ZERO informada (taxa 0 ≠ ausente)", { refs: [{ tipo: "venda", canal: null, valor: 5000, dia: 2, status: "ativa" }, { tipo: "taxa", canal: "STONE", valor: 0, dia: 2, status: "ativa" }] }),
  base("receita em conta que NÃO é caixa_fisico não entra no caixa", { lancs: [{ conta: 1, cat: "receita", sentido: "entrada", valor: 7000, dia: 4, status: "realizado" }], refs: [{ tipo: "dinheiro", canal: null, valor: 7000, dia: 4, status: "ativa" }] }),
  base("FRONTEIRA: receita no 1º dia do mês SEGUINTE não entra na ponte", { lancs: [{ conta: 1, cat: "receita", sentido: "entrada", valor: 9000, dia: 1, mesOffset: 1, status: "realizado" }], refs: [{ tipo: "venda", canal: null, valor: 10000, dia: 5, status: "ativa" }, { tipo: "taxa", canal: "STONE", valor: 1000, dia: 5, status: "ativa" }] }),
  base("FRONTEIRA: receita no ÚLTIMO dia do mês entra na ponte (conciliada)", { lancs: [{ conta: 1, cat: "receita", sentido: "entrada", valor: 9000, dia: 31, status: "realizado" }], refs: [{ tipo: "venda", canal: null, valor: 10000, dia: 5, status: "ativa" }, { tipo: "taxa", canal: "STONE", valor: 1000, dia: 5, status: "ativa" }] }),
  base("FRONTEIRA: receita no último dia do mês ANTERIOR não entra na ponte", { lancs: [{ conta: 1, cat: "receita", sentido: "entrada", valor: 9000, dia: 31, mesOffset: -1, status: "realizado" }], refs: [{ tipo: "venda", canal: null, valor: 10000, dia: 5, status: "ativa" }, { tipo: "taxa", canal: "STONE", valor: 1000, dia: 5, status: "ativa" }] }),
  base("FRONTEIRA: venda/taxa no 1º dia do mês seguinte não existem para este mês", { refs: [{ tipo: "venda", canal: null, valor: 10000, dia: 1, mesOffset: 1, status: "ativa" }, { tipo: "taxa", canal: "STONE", valor: 1000, dia: 1, mesOffset: 1, status: "ativa" }] }),
  base("CONTA INATIVA de caixa continua valendo (sem filtro por ativo)", { contas: [{ tipo: "caixa_fisico", canal: null, ativo: false }, { tipo: "banco", canal: null }], lancs: [{ conta: 0, cat: "receita", sentido: "entrada", valor: 7000, dia: 4, status: "realizado" }], refs: [{ tipo: "dinheiro", canal: null, valor: 6000, dia: 4, status: "ativa" }] }),
  base("vários itens abertos juntos (ponte + 2 caixas + 2 sangrias)", {
    lancs: [{ conta: 0, cat: "receita", sentido: "entrada", valor: 1000, dia: 2, status: "realizado" }, { conta: 0, cat: "receita", sentido: "entrada", valor: 1000, dia: 3, status: "realizado" }, { conta: 0, cat: "despesa", sentido: "saida", valor: 500, dia: 8, status: "realizado" }, { conta: 0, cat: "custo", sentido: "saida", valor: 700, dia: 9, status: "realizado" }],
    refs: [{ tipo: "venda", canal: null, valor: 50000, dia: 1, status: "ativa" }, { tipo: "taxa", canal: "IFOOD", valor: 5000, dia: 1, status: "ativa" }, { tipo: "dinheiro", canal: null, valor: 1200, dia: 2, status: "ativa" }, { tipo: "dinheiro", canal: null, valor: 900, dia: 3, status: "ativa" }, { tipo: "sangria", canal: null, valor: 100, dia: 8, status: "ativa" }, { tipo: "sangria", canal: null, valor: 100, dia: 9, status: "ativa" }],
  }),
];
function aleatorio(rnd, i) {
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const nC = 1 + Math.floor(rnd() * 3);
  const contas = Array.from({ length: nC }, () => ({ tipo: pick(["caixa_fisico", "banco", "adquirente", "carteira_plataforma", "outra"]), canal: pick([null, "STONE", "IFOOD", "stone"]), ativo: rnd() < 0.8 }));   // conta INATIVA continua valendo no motor (não há filtro por ativo)
  const lancs = Array.from({ length: Math.floor(rnd() * 25) }, () => ({ conta: Math.floor(rnd() * nC), cat: pick(["receita", "receita", "despesa", "custo", "transf", "saldo", null]), sentido: pick(["entrada", "saida"]), valor: 1 + Math.floor(rnd() * 20000), dia: pick([1, 28, 29, 30, 31, 1 + Math.floor(rnd() * 28)]), mesOffset: rnd() < 0.06 ? pick([-1, 1]) : 0, status: pick(["realizado", "realizado", "realizado", "previsto", "cancelado"]) }));   // dias de fronteira e meses vizinhos
  const refs = Array.from({ length: Math.floor(rnd() * 12) }, () => ({ tipo: pick(["venda", "taxa", "sangria", "dinheiro"]), canal: pick([null, "STONE", "IFOOD"]), valor: Math.floor(rnd() * 30000), dia: 1 + Math.floor(rnd() * 28), status: pick(["ativa", "ativa", "ativa", "cancelada"]), mesOffset: rnd() < 0.08 ? pick([-1, 1]) : 0 }));
  const resols = Array.from({ length: Math.floor(rnd() * 5) }, () => { const escopo = pick(["ponte_mensal", "caixa_dia", "sangria_dia"]); return { escopo, dia: escopo === "ponte_mensal" ? 1 : 1 + Math.floor(rnd() * 28), valor: pick([-1, 1]) * (1 + Math.floor(rnd() * 15000)), status: pick(["vigente", "vigente", "revogada"]) }; });
  return { nome: `aleatório ${i}`, mes: "2030-01", contas, lancs, refs, resols, excecoesSangria: rnd() < 0.3 ? [pick(["despesa", "custo"])] : [] };
}

const dataDeSc = (sc, dia, off = 0) => { const [a, m] = sc.mes.split("-").map(Number); return new Date(Date.UTC(a, m - 1 + off, dia)).toISOString().slice(0, 10); };
/** Oráculo JS: os MESMOS filtros do serviço (referências ativas do mês, resoluções vigentes, lançamentos de qualquer status — o motor filtra). */
function rodar(sc) {
  const noMes = (d) => d.slice(0, 7) === sc.mes;
  return conciliar({
    mes: sc.mes,
    lancamentos: sc.lancs.map((l, i) => ({ id: `l${i}`, contaId: `c${l.conta}`, sentido: l.sentido, valorCentavos: l.valor, papel: l.cat ? PAPEL[CAT[l.cat]] : null, status: l.status, categoriaId: l.cat ? CAT[l.cat] : null, data: dataDeSc(sc, l.dia, l.mesOffset ?? 0) })),
    contas: sc.contas.map((c, i) => ({ id: `c${i}`, nome: `C${i}`, tipo_conta: c.tipo, canal_referencia: c.canal })),
    referencias: sc.refs.filter((r) => r.status === "ativa").map((r, i) => ({ id: `r${i}`, data: dataDeSc(sc, r.dia, r.mesOffset ?? 0), tipo: r.tipo, canal: r.canal, valorCentavos: r.valor })).filter((r) => noMes(r.data)),
    excecoesSangria: new Set(sc.excecoesSangria.map((k) => CAT[k])),
    resolucoes: sc.resols.filter((r) => r.status === "vigente").map((r, i) => ({ id: `x${i}`, escopo: r.escopo, chave: dataDeSc(sc, r.dia), classificacao: "ajuste", valorCentavos: r.valor, nota: "n" })),
  });
}
/** Cenário "apertado": referências e resoluções construídas A PARTIR do fluxo real, para que diferenças de ZERO (e resoluções exatas/parciais) sejam comuns — é aí que
 * um desvio sutil do SQL (status, exceção, revogada, cancelada, saldo_anterior…) muda o resultado. */
function apertar(sc, rnd) {
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const r0 = rodar({ ...sc, refs: [], resols: [] });
  const refs = [...sc.refs]; const resols = [...sc.resols];
  for (const d of r0.caixaDias) {
    const dia = Number(d.data.slice(8)); const k = rnd();
    if (k < 0.45) refs.push({ tipo: "dinheiro", canal: null, valor: Math.max(0, d.fluxoCentavos), dia, status: "ativa" });
    else if (k < 0.8) { const delta = pick([-300, -50, 70, 900]); refs.push({ tipo: "dinheiro", canal: null, valor: Math.max(0, d.fluxoCentavos + delta), dia, status: "ativa" }); const q = rnd(); if (q < 0.35) resols.push({ escopo: "caixa_dia", dia, valor: -delta, status: pick(["vigente", "vigente", "revogada"]) }); else if (q < 0.5) resols.push({ escopo: "caixa_dia", dia, valor: -Math.trunc(delta / 2) || 1, status: "vigente" }); }
    if (rnd() < 0.12) refs.push({ tipo: "dinheiro", canal: null, valor: Math.max(0, d.fluxoCentavos), dia, status: "cancelada" });
  }
  for (const d of r0.sangriaDias) {
    const dia = Number(d.data.slice(8)); const k = rnd();
    if (k < 0.45) refs.push({ tipo: "sangria", canal: null, valor: Math.max(0, d.fluxoCentavos), dia, status: "ativa" });
    else if (k < 0.8) { const delta = pick([-200, 40, 500]); refs.push({ tipo: "sangria", canal: null, valor: Math.max(0, d.fluxoCentavos + delta), dia, status: "ativa" }); if (rnd() < 0.4) resols.push({ escopo: "sangria_dia", dia, valor: -delta, status: pick(["vigente", "revogada"]) }); }
  }
  if (rnd() < 0.8) { // ponte
    const taxa = pick([0, 0, 1500, 4000]); const delta = pick([0, 0, 0, -250, 800]);
    refs.push({ tipo: "venda", canal: null, valor: Math.max(0, r0.ponte.recebidoCentavos + taxa + delta), dia: 1, status: "ativa" });
    if (rnd() < 0.9) refs.push({ tipo: "taxa", canal: "STONE", valor: taxa, dia: 1, status: "ativa" });
    if (delta !== 0 && rnd() < 0.5) resols.push({ escopo: "ponte_mensal", dia: 1, valor: rnd() < 0.5 ? delta : Math.trunc(delta / 2) || 1, status: pick(["vigente", "revogada"]) });
  }
  return { ...sc, refs, resols };
}
let n = 0;
function materializar(sc) {
  n += 1;
  const unidade = uuid(9, n);
  const ids = { conta: (i) => uuid(2, n * 100 + i), lanc: (i) => uuid(3, n * 1000 + i), ref: (i) => uuid(4, n * 1000 + i), res: (i) => uuid(5, n * 1000 + i), exc: (i) => uuid(6, n * 100 + i) };
  const mes0 = `${sc.mes}-01`;
  const dataDe = (dia, off = 0) => { const [a, m] = sc.mes.split("-").map(Number); const d = new Date(Date.UTC(a, m - 1 + off, dia)); return d.toISOString().slice(0, 10); };
  const sql = [`set session_replication_role = replica;`,
    `insert into unidades(id, organizacao_id, nome) values (${q(unidade)}, ${q(CUR.org)}, 'M1 ${n}');`];
  sc.contas.forEach((c, i) => sql.push(`insert into fin_contas(id, organizacao_id, unidade_id, nome, tipo_conta, canal_referencia, ativo) values (${q(ids.conta(i))}, ${q(CUR.org)}, ${q(unidade)}, 'C${i}', ${q(c.tipo)}, ${q(c.canal)}, ${c.ativo === false ? 'false' : 'true'});`));
  sc.lancs.forEach((l, i) => sql.push(`insert into fin_lancamentos(id, organizacao_id, unidade_id, conta_id, categoria_id, descricao, sentido, valor_centavos, data_movimento, status, classificacao_pendente) values (${q(ids.lanc(i))}, ${q(CUR.org)}, ${q(unidade)}, ${q(ids.conta(l.conta))}, ${q(l.cat ? CUR.cat[l.cat] : null)}, 'L${i}', ${q(l.sentido)}, ${l.valor}, ${q(dataDe(l.dia, l.mesOffset ?? 0))}, ${q(l.status)}, ${l.cat ? "false" : "true"});`));
  sc.refs.forEach((r, i) => sql.push(`insert into fin_referencias(id, organizacao_id, unidade_id, data, tipo, canal, valor_centavos, fonte, status, motivo_cancelamento) values (${q(ids.ref(i))}, ${q(CUR.org)}, ${q(unidade)}, ${q(dataDe(r.dia, r.mesOffset ?? 0))}, ${q(r.tipo)}, ${q(r.canal)}, ${r.valor}, 'manual', ${q(r.status)}, ${r.status === "cancelada" ? "'x'" : "null"});`));
  sc.resols.forEach((r, i) => sql.push(`insert into fin_conciliacao_resolucoes(id, organizacao_id, unidade_id, escopo, chave, classificacao, valor_centavos, diferenca_no_momento_centavos, nota, status, motivo_revogacao) values (${q(ids.res(i))}, ${q(CUR.org)}, ${q(unidade)}, ${q(r.escopo)}, ${q(dataDe(r.dia))}, 'ajuste', ${r.valor}, ${r.valor}, 'nota de teste', ${q(r.status)}, ${r.status === "revogada" ? "'x'" : "null"});`));
  sc.excecoesSangria.forEach((k, i) => sql.push(`insert into fin_sangria_excecoes(id, organizacao_id, unidade_id, categoria_id, motivo, aprovada_por) values (${q(ids.exc(i))}, ${q(CUR.org)}, ${q(unidade)}, ${q(CUR.cat[k])}, 'motivo teste', ${q(uuid(0, 1))});`));
  sql.push(`set session_replication_role = origin;`);
  const oraculo = rodar(sc).resumo.pendenciasAbertasIds;
  return { unidade, mes0, sql: sql.join("\n"), esperado: [...oraculo].sort() };
}

// pré-requisitos: categorias do teste (papéis) na organização A
psql([`insert into fin_plano_contas(id, organizacao_id, tipo, natureza, nome, papel) values`,
  `(${q(CAT.receita)}, ${q(ORG)}, 'RECEITA', 'RECEBIMENTO', 'M1 REC', 'receita_operacional'),`,
  `(${q(CAT.despesa)}, ${q(ORG)}, 'DESPESA', 'FIXA', 'M1 DESP', 'despesa_fixa'),`,
  `(${q(CAT.custo)}, ${q(ORG)}, 'CUSTO', 'VARIAVEL', 'M1 CUSTO', 'custo_variavel'),`,
  `(${q(CAT.transf)}, ${q(ORG)}, 'TRANSFERENCIA', 'ENTRE CONTAS', 'M1 TRANSF', 'transferencia'),`,
  `(${q(CAT.saldo)}, ${q(ORG)}, 'RECEITA', 'SALDO ANTERIOR', 'M1 SALDO', 'saldo_anterior') on conflict (id) do nothing;`].join("\n"));

psql([`insert into organizacoes(id, nome) values (${q(ORG2)}, 'M1 Org 2') on conflict do nothing;`,
  `insert into fin_plano_contas(id, organizacao_id, tipo, natureza, nome, papel) values`,
  `(${q(CAT2.receita)}, ${q(ORG2)}, 'RECEITA', 'RECEBIMENTO', 'M1 REC', 'receita_operacional'),`,
  `(${q(CAT2.despesa)}, ${q(ORG2)}, 'DESPESA', 'FIXA', 'M1 DESP', 'despesa_fixa'),`,
  `(${q(CAT2.custo)}, ${q(ORG2)}, 'CUSTO', 'VARIAVEL', 'M1 CUSTO', 'custo_variavel'),`,
  `(${q(CAT2.transf)}, ${q(ORG2)}, 'TRANSFERENCIA', 'ENTRE CONTAS', 'M1 TRANSF', 'transferencia'),`,
  `(${q(CAT2.saldo)}, ${q(ORG2)}, 'RECEITA', 'SALDO ANTERIOR', 'M1 SALDO', 'saldo_anterior') on conflict (id) do nothing;`].join("\n"));
const rnd = prng(SEMENTE);
const comMuitoFluxo = (rnd, i) => { const sc = aleatorio(rnd, i); sc.contas[0] = { tipo: "caixa_fisico", canal: null }; sc.excecoesSangria = rnd() < 0.5 ? ["despesa"] : []; return sc; };
const cenarios = [...fixos,
  ...Array.from({ length: ALEATORIOS }, (_, i) => aleatorio(rnd, i + 1)),
  ...Array.from({ length: ALEATORIOS }, (_, i) => { const sc = apertar(comMuitoFluxo(rnd, i + 1), rnd); return { ...sc, nome: `apertado ${i + 1}` }; })];
let ok = 0; const falhas = []; let comPendencia = 0;
let k = 0;
for (const sc of cenarios) {
  k += 1; CUR = k % 2 ? { org: ORG, cat: CAT } : { org: ORG2, cat: CAT2 };   // alterna as duas organizações (dados nas MESMAS datas)
  const m = materializar(sc);
  try { psql(m.sql); } catch (e) { falhas.push(`${sc.nome}: INSERT falhou: ${e.message}`); continue; }
  if (m.esperado.length) comPendencia += 1;
  let obtido;
  try {
    const out = psql(`set role service_role; select coalesce(array_to_string(${FN}(${q(CUR.org)}, ${q(m.unidade)}, ${q(m.mes0)}), ','), '');`);
    obtido = out.split("\n").pop().split(",").filter(Boolean).sort();
  } catch (e) { falhas.push(`${sc.nome}: chamada de ${FN} falhou (${e.message})`); continue; }
  if (JSON.stringify(obtido) === JSON.stringify(m.esperado)) ok += 1;
  else falhas.push(`${sc.nome}: SQL=${JSON.stringify(obtido)} JS=${JSON.stringify(m.esperado)}`);
}
console.log(`paridade JS×SQL (${FN}): ${ok}/${cenarios.length} iguais · ${comPendencia} cenários com pendência aberta no oráculo (precisa haver variedade)`);
for (const f of falhas.slice(0, 15)) console.log("  ✗", f);
if (falhas.length > 15) console.log(`  … +${falhas.length - 15}`);
process.exit(falhas.length ? 1 : 0);
