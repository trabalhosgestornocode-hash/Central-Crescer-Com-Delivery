#!/usr/bin/env node
// PARIDADE Foody × Parser — SOMENTE LEITURA. Compara, dia a dia, os pedidos que a sincronização Foody gravou para uma conta
// (titular + destinos do compartilhamento) com os pedidos do relatório Excel importado no Parser para a MESMA unidade titular.
//
// Uso:
//   FOODY_PARIDADE_CONN=<postgres://...> node scripts/foody-paridade.mjs --unidade <uuid titular> --de AAAA-MM-DD --ate AAAA-MM-DD [--saida rel.json]
//
// Garantias:
//   * a conexão vem só de FOODY_PARIDADE_CONN e nunca é impressa;
//   * tudo roda numa transação READ ONLY (o banco recusa qualquer escrita) e só há SELECT no código (teste de arquitetura);
//   * saída sem dado pessoal: contagens, somas de taxa e no máximo 10 números de pedido por categoria;
//   * o Parser é lido como ele mesmo consolida um período (importações concluídas, sobreposição resolvida pela mais recente).
import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { compararParidadeDia, resumirParidade, parede } from "../src/modules/foody/foody.paridade.js";
import { consolidarPedidosPeriodo } from "../src/modules/parser-food-delivery/parserFoodDelivery.periodo.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DIAS = 62;

export function lerArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[String(argv[i]).replace(/^--/, "")] = argv[i + 1];
  if (!UUID.test(String(a.unidade ?? ""))) throw new Error("--unidade <uuid da unidade titular> obrigatório");
  if (!DIA.test(String(a.de ?? "")) || !DIA.test(String(a.ate ?? "")) || a.ate < a.de) throw new Error("--de/--ate AAAA-MM-DD obrigatórios (ate >= de)");
  const dias = (Date.parse(`${a.ate}T00:00:00Z`) - Date.parse(`${a.de}T00:00:00Z`)) / 86_400_000 + 1;
  if (dias > MAX_DIAS) throw new Error(`no máximo ${MAX_DIAS} dias por execução`);
  if (a.saida && existsSync(a.saida)) throw new Error("--saida já existe (não sobrescrevo)");
  return { unidade: a.unidade.toLowerCase(), de: a.de, ate: a.ate, saida: a.saida ?? null };
}

const somarDia = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** SQL das três leituras. Parâmetros já validados (uuid/data) — nunca texto livre. */
export function consultas({ unidade, de, ate }) {
  const fim = somarDia(ate, 1);
  return {
    conexao: `select coalesce(json_agg(json_build_object('id', id, 'organizacao_id', organizacao_id, 'status', status)), '[]'::json)
      from foody_conexoes where unidade_id = '${unidade}' and status <> 'REVOGADA';`,
    foody: (conexaoId) => `select coalesce(json_agg(json_build_object('numero_pedido', numero_pedido, 'data_hora', data_hora, 'competencia', competencia,
        'situacao', situacao, 'taxa_entregador', taxa_entregador, 'valor_total', valor_total, 'operacao', operacao)), '[]'::json)
      from foody_pedidos where roteamento_ativo and competencia between '${de}' and '${ate}'
        and (conexao_id = '${conexaoId}' or (conexao_id is null and unidade_id = '${unidade}'));`,
    parser: `select coalesce(json_agg(json_build_object('id', p.id, 'importacao_id', p.importacao_id, 'organizacao_id', p.organizacao_id,
        'unidade_id', p.unidade_id, 'numero_pedido', p.numero_pedido, 'data_hora', to_char(p.data_hora at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'),
        'origem', p.origem, 'situacao', p.situacao, 'taxa_entregador', p.taxa_entregador, 'valor_total_pedido', p.valor_total_pedido,
        'operacao', p.operacao, 'fonte', json_build_object('criado_em', i.criado_em))), '[]'::json)
      from parser_fd_pedidos p join parser_fd_importacoes i on i.id = p.importacao_id and i.status = 'concluida' and i.unidade_id = p.unidade_id
      where p.unidade_id = '${unidade}' and p.data_hora >= '${de}T00:00:00Z' and p.data_hora < '${fim}T00:00:00Z';`,
  };
}

/** Pura: agrupa por dia e compara. */
export function montarRelatorio({ de, ate, foody, parser }) {
  const consolidadas = consolidarPedidosPeriodo(parser);
  const dias = [];
  for (let d = de; d <= ate; d = somarDia(d, 1)) {
    dias.push(compararParidadeDia({ competencia: d,
      foody: foody.filter((x) => String(x.competencia).slice(0, 10) === d),
      parser: consolidadas.filter((x) => parede(x.data_hora)?.slice(0, 10) === d) }));
  }
  return { periodo: { de, ate }, resumo: resumirParidade(dias.filter((x) => x.contagens.foody || x.contagens.parser)), dias,
    observacao: "Parser lido sem os ajustes manuais (overrides) de classificação; operação comparada pela coluna gravada na importação." };
}

function psqlJson(conn, sql) {
  const corpo = `begin transaction read only;\nset local timezone = 'UTC';\nset local statement_timeout = '60s';\n${sql}\nrollback;\n`;
  const r = spawnSync(process.env.PSQL ?? "psql", [conn, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    { input: corpo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
  if (r.status !== 0) throw new Error(`consulta falhou: ${String(r.stderr ?? "").split(conn).join("<conexão>").slice(0, 400)}`);
  const linhas = String(r.stdout).split(/\r?\n/).filter((l) => l.trim().startsWith("[") || l.trim().startsWith("{"));
  return JSON.parse(linhas.pop() ?? "[]");
}

/** `consultar(conn, sql)` pode ser síncrono ou assíncrono (homologação usa uma sessão transacional única). */
export async function executar(argv, { conn = process.env.FOODY_PARIDADE_CONN, consultar = psqlJson } = {}) {
  if (!conn) throw new Error("FOODY_PARIDADE_CONN ausente");
  const a = lerArgs(argv);
  const q = consultas(a);
  const cx = await consultar(conn, q.conexao);
  if (cx.length !== 1) throw new Error(cx.length ? "mais de uma conexão viva para a unidade" : "unidade sem conexão Foody viva");
  const relatorio = montarRelatorio({ de: a.de, ate: a.ate, foody: await consultar(conn, q.foody(cx[0].id)), parser: await consultar(conn, q.parser) });
  return { relatorio, saida: a.saida };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  try {
    const { relatorio, saida } = await executar(process.argv.slice(2));
    const texto = JSON.stringify(relatorio, null, 2);
    if (saida) writeFileSync(saida, texto, { flag: "wx" });
    process.stdout.write(`${JSON.stringify(relatorio.resumo)}\n`);
    process.exitCode = relatorio.resumo.resultado === "PARIDADE" ? 0 : 3;
  } catch (e) {
    process.stderr.write(`paridade: ${e.message}\n`);
    process.exitCode = 2;
  }
}
