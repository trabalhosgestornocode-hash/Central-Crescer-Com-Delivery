#!/usr/bin/env node
// HOMOLOGAÇÃO da sincronização MANUAL Foody no Supabase de TESTE (wiqqsxnysbzhcrzrrean) — NÃO DESTRUTIVA.
//
// O que faz (código REAL: repositório, RPC da 149, compartilhamento 148, sincronização, fechamentos e paridade):
//   1. impressão do banco ANTES (contagem exata de TODAS as tabelas de public + auth.users);
//   2. cria um cenário SINTÉTICO e marcado ("HOMOLOG FOODY <carimbo>"): 2 organizações, 2 unidades eh_teste, 3 contas fictícias
//      (@teste.invalid), conexão cadastrada e ativada pela RPC, compartilhamento proposto e aprovado em atos separados;
//   3. sincroniza 2 dias com a API Foody FALSA (nenhuma chamada à Foody real: qualquer fetch é recusado), confere distribuição,
//      fechamentos por organização, idempotência, concorrência, falha de autenticação e isolamento;
//   4. grava uma importação SINTÉTICA do Parser com os mesmos pedidos e roda a paridade (só leitura) → PARIDADE;
//   5. tudo numa ÚNICA sessão, numa ÚNICA transação que termina em ROLLBACK (nada é gravado; nenhuma trava é desligada) e
//      confere, numa sessão nova, que a impressão DEPOIS é idêntica à de ANTES.
// Recusa qualquer banco que não seja o de TESTE. A conexão vem de FOODY_CONN (operador com-teste.mjs) e nunca é impressa.
//
//   node com-teste.mjs node backend/testes-seguros/foody-sync-teste/homologar.mjs [--evidencias <pasta>]
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { abrirSessaoTransacional } from "./sessao-pg.mjs";
import { criarClientePg } from "../../test/helpers/pg-supabase-mini.js";
import { pedidoApi } from "../../test/helpers/foody-fixtures.js";
import { criarRepositorioFoody } from "../../src/modules/foody/foody.repository.js";
import { criarSegurancaFoody } from "../../src/modules/foody/foody.seguranca.js";
import { prepararConexao } from "../../src/modules/foody/foody.conexao.js";
import { criarClienteFoody } from "../../src/modules/foody/foody.client.js";
import { proporDestino, aprovarDestino } from "../../src/modules/foody/foody.compartilhamento.service.js";
import { solicitarSyncManual, criarEstadoSyncManual } from "../../src/modules/foody/foody.sync.manual.js";
import { executar as executarParidade } from "../../scripts/foody-paridade.mjs";

const PROJETO_TESTE = "wiqqsxnysbzhcrzrrean", PROJETO_PROD = "uqybgauuxcrqzquultfu";
const falhar = (m) => { process.stderr.write(`homologação: ${m}\n`); process.exit(2); };
// ENSAIO (FOODY_ALVO=local): o MESMO roteiro num Postgres local descartável com o schema real (CHECKLIST_PERFIL_PG_URL local).
let CONN = String(process.env.FOODY_CONN ?? ""), descartavel = null;
if (process.env.FOODY_ALVO === "local") {
  const { motivoPular, criarBancoDescartavel } = await import("../../test/helpers/pg-descartavel.js");
  const { construirSchemaReal } = await import("../../test/helpers/schema-real-pg.js");
  if (motivoPular) falhar(String(motivoPular));
  descartavel = criarBancoDescartavel("foodyhomologensaio");
  const erros = construirSchemaReal(descartavel.url);
  if (erros.length) falhar(`schema local: ${erros.join("; ").slice(0, 300)}`);
  CONN = descartavel.url;
} else {
  if (process.env.FOODY_ALVO !== "teste") falhar("FOODY_ALVO precisa ser 'teste' (ou 'local' para o ensaio).");
  let host = ""; try { host = new URL(CONN).hostname; } catch { falhar("FOODY_CONN inválida."); }
  if (!host.includes(PROJETO_TESTE) || CONN.includes(PROJETO_PROD)) falhar("recusado: não é o Supabase de TESTE.");
}
const evid = (() => { const i = process.argv.indexOf("--evidencias"); return i > 0 ? process.argv[i + 1] : null; })();
// Nenhuma rede além do banco (psql é processo à parte): a API Foody é falsa e qualquer fetch real é bloqueado.
globalThis.fetch = async (url) => { throw new Error(`fetch bloqueado na homologação: ${String(url).slice(0, 40)}`); };

let sessao = null;
const q = (sql) => sessao.consultar(sql);
const resultados = [];
const checar = (nome, ok, detalhe = "") => { resultados.push({ nome, ok: Boolean(ok), detalhe: String(detalhe).slice(0, 300) }); if (!ok) throw new Error(`FALHOU: ${nome} — ${detalhe}`); };

async function impressao(s) {
  const tabelas = String(await s.consultar(`select string_agg(quote_ident(tablename), ',' order by tablename) from pg_tables where schemaname = 'public';`)).split(",");
  const partes = tabelas.map((t) => `'${t.replace(/"/g, "")}', (select count(*) from public.${t})`);
  const contagens = {};
  for (let i = 0; i < partes.length; i += 40) Object.assign(contagens, JSON.parse(await s.consultar(`select json_build_object(${partes.slice(i, i + 40).join(", ")})::text;`)));
  contagens["auth.users"] = Number(await s.consultar(`select count(*) from auth.users;`));
  return contagens;
}

const CARIMBO = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const ORG_T = randomUUID(), UNI_T = randomUUID(), ORG_D = randomUUID(), UNI_D = randomUUID();
const ADM_T = randomUUID(), ADM_D = randomUUID(), GER_T = randomUUID();
const PERFIS = [ADM_T, ADM_D, GER_T];
const TOKEN = `tok_HOMOLOG_ficticio_${CARIMBO}_0123456789`;
const SEGREDO = `segredo-homologacao-teste-${CARIMBO}-com-mais-de-32`;

async function criarCenario() {
  await q(`insert into organizacoes (id, nome, observacoes) values ('${ORG_T}', 'HOMOLOG FOODY titular ${CARIMBO}', 'sintético — homologação Foody, removido ao fim'),
       ('${ORG_D}', 'HOMOLOG FOODY destino ${CARIMBO}', 'sintético — homologação Foody, removido ao fim');
     insert into unidades (id, organizacao_id, nome, eh_teste) values ('${UNI_T}', '${ORG_T}', 'HOMOLOG Subway ${CARIMBO}', true), ('${UNI_D}', '${ORG_D}', 'HOMOLOG Açaí ${CARIMBO}', true);`);
  for (const [pid, sufixo] of [[ADM_T, "adm-t"], [ADM_D, "adm-d"], [GER_T, "ger-t"]]) {
    await q(`insert into auth.users (id, email) values ('${pid}', 'homolog-foody-${CARIMBO}-${sufixo}@teste.invalid');
       insert into perfis (id, nome, email) values ('${pid}', 'HOMOLOG ${sufixo}', 'homolog-foody-${CARIMBO}-${sufixo}@teste.invalid');
       insert into perfis_operacionais (id, conta_id, nome) values ('${pid}', '${pid}', 'HOMOLOG ${sufixo}');`);
  }
  await q(`insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values
       ('${ADM_T}', '${ADM_T}', '${ORG_T}', 'organization_admin'), ('${ADM_T}', '${ADM_T}', '${ORG_D}', 'organization_admin'),
       ('${ADM_D}', '${ADM_D}', '${ORG_D}', 'organization_admin'), ('${GER_T}', '${GER_T}', '${ORG_T}', 'unit_manager');`);
}

const D1 = "2026-11-02", D2 = "2026-11-03";
const AGORA = () => new Date("2026-11-04T15:00:00Z");
const ENV = { FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_UNIDADES: UNI_T, FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED: "true", FOODY_CENTRAL_ADMIN_ENABLED: "true" };
const ator = (perfilId, organizacaoId, papel = "organization_admin") => ({ perfilId, papel, impersonando: false, organizacaoId });
const dia = (d, n) => [
  pedidoApi({ uid: `h-${d}-s1`, id: `${n}01`, orderDetails: "1x Sub Frango Teriyaki 15cm", courierFee: 10, orderTotal: 40, date: `${d}T11:00:00-03:00` }),
  pedidoApi({ uid: `h-${d}-s2`, id: `${n}02`, orderDetails: "1x Sub Frango Teriyaki 30cm", courierFee: 8, orderTotal: 60, date: `${d}T23:59:59-03:00` }),
  pedidoApi({ uid: `h-${d}-a1`, id: `${n}03`, orderDetails: "1x Açaí Premium 500ml", courierFee: 7, orderTotal: 30, date: `${d}T12:00:00-03:00` }),
  pedidoApi({ uid: `h-${d}-t1`, id: `${n}04`, orderDetails: "1x Sub Frango Teriyaki 15cm\n1x Produto Novo Misterioso", courierFee: 9, orderTotal: 55, date: `${d}T13:00:00-03:00` }),
  pedidoApi({ uid: `h-${d}-c1`, id: `${n}05`, status: "cancelled", cancellationReason: "other", orderDetails: "1x Sub Frango Teriyaki 15cm", courierFee: 10, orderTotal: 40,
    date: `${d}T00:00:00-03:00`, cancelledDate: `${d}T00:10:00-03:00` }),
];
const todos = [...dia(D1, "71"), ...dia(D2, "72")];
let statusApi = 200, getsFoody = 0;
const criarCliente = ({ token, ...r }) => criarClienteFoody({ token, ...r, esperar: async () => {}, fetch: async (url, init) => {
  getsFoody++;
  if (init?.method !== "GET" || init?.body !== undefined) throw new Error("método diferente de GET");
  if (statusApi !== 200 || token !== TOKEN) return { ok: false, status: statusApi === 200 ? 401 : statusApi, json: async () => ({}) };
  const u = new URL(url); const ini = Date.parse(u.searchParams.get("startDate")), fim = Date.parse(u.searchParams.get("endDate"));
  return { ok: true, status: 200, json: async () => structuredClone(todos.filter((o) => Date.parse(o.date) >= ini && Date.parse(o.date) < fim)
    .sort((x, y) => Date.parse(x.date) - Date.parse(y.date))) };   // a API real ordena por `date`
} });

async function cenario() {
  const db = criarClientePg(CONN, { executor: (sql) => sessao.executar(sql) });
  const repo = criarRepositorioFoody(db);
  const seguranca = criarSegurancaFoody(SEGREDO);
  const tT = { organizacaoId: ORG_T, unidadeId: UNI_T };

  // Conexão pelo mesmo caminho da tela: RPC foody_conexao_administrar (CADASTRAR nasce PAUSADA; ATIVAR).
  const linha = prepararConexao({ organizacaoId: ORG_T, unidadeId: UNI_T, token: TOKEN }, seguranca);
  const cad = await repo.administrarConexao(tT, { acao: "CADASTRAR", ator: ADM_T, tokenCifrado: linha.token_cifrado, tokenImpressao: linha.token_impressao });
  checar("RPC CADASTRAR → PAUSADA", cad?.status === "PAUSADA", JSON.stringify(cad));
  const gerente = await repo.administrarConexao(tT, { acao: "ATIVAR", ator: GER_T }).then(() => "aceitou", (e) => e.codigo);
  checar("RPC recusa quem não é admin ativo (gestor)", gerente === "SEM_PERMISSAO", gerente);
  checar("RPC ATIVAR → ATIVA", (await repo.administrarConexao(tT, { acao: "ATIVAR", ator: ADM_T }))?.status === "ATIVA");
  const conexaoId = await q(`select id from foody_conexoes where unidade_id = '${UNI_T}';`);

  const svc = { env: ENV, repo, agora: AGORA };
  const p = await proporDestino({ ator: ator(ADM_T, ORG_T), conexaoId, destino: { organizacaoId: ORG_D, unidadeId: UNI_D, operacao: "acai_no_grau" } }, svc);
  checar("proposta PENDENTE", p.estado === "PENDENTE");
  // A trava de ATOS SEPARADOS (148) recusa a aprovação do destino na MESMA transação da proposta — e aqui tudo é uma transação só.
  const mesma = await aprovarDestino({ ator: ator(ADM_D, ORG_D), destinoId: p.id }, svc).then(() => "aceitou", (e) => e.codigo ?? e.message);
  checar("aprovação na mesma transação da proposta é RECUSADA (ato separado)", mesma !== "aceitou", mesma);
  // E a aprovação registrada não pode ser "recuada" para fingir o intervalo entre os atos (a trava vale também para o teste).
  const recuo = (await sessao.executar(`update foody_conexao_destinos set aprovado_titular_em = now() - interval '2 minutes' where id = '${p.id}';`)).error?.code ?? "aceitou";
  checar("aprovação registrada não pode ser recuada (42501)", recuo === "42501", recuo);
  // Sem destino ATIVO a coleta segue no modo da conta própria (sem compartilhamento). O fluxo com destino ATIVO tem prova em
  // autocommit no schema real (test/foody-sync-manual-e2e-pg.test.js) — numa transação revertida ele é, por desenho, impossível.

  const estado = criarEstadoSyncManual();
  const manual = (competencias, extra = {}) => solicitarSyncManual({ ator: ator(ADM_T, ORG_T), tenant: tT, competencias, ...extra },
    { env: ENV, repo, seguranca, criarCliente, agora: AGORA, estado, log: () => {} });

  const neg = await manual([D1], { ator: ator(GER_T, ORG_T, "unit_manager") }).then(() => "aceitou", (e) => e.codigo);
  checar("sync manual recusa gestor de unidade", neg === "SEM_PERMISSAO", neg);
  const negD = await solicitarSyncManual({ ator: ator(ADM_D, ORG_D), tenant: { organizacaoId: ORG_D, unidadeId: UNI_D }, competencias: [D1] },
    { env: { ...ENV, FOODY_CENTRAL_UNIDADES: `${UNI_T},${UNI_D}` }, repo, seguranca, criarCliente, agora: AGORA, estado, log: () => {} }).then(() => "aceitou", (e) => e.codigo);
  checar("destino não dispara coleta da conta alheia", negD === "SEM_CONEXAO", negD);
  checar("flag de coleta desligada → DESLIGADO", (await solicitarSyncManual({ ator: ator(ADM_T, ORG_T), tenant: tT, competencias: [D1] },
    { env: { ...ENV, FOODY_CENTRAL_ENABLED: "false" }, repo, seguranca, criarCliente, agora: AGORA, estado }).then(() => "x", (e) => e.codigo)) === "DESLIGADO");

  const r = await manual([D1, D2]);
  checar("2 dias sincronizados sem erro", r.dias.every((d) => !d.erro), JSON.stringify(r.dias.map((d) => d.erro ?? "ok")));
  for (const d of r.dias) {
    checar(`${d.competencia}: 5 pedidos únicos e inseridos`, d.contagens.unicos === 5 && d.contagens.inseridos === 5, JSON.stringify(d.contagens));
    checar(`${d.competencia}: sem destino ATIVO, Açaí fica mínimo na titular (nada roteado)`, d.distribuicao.titular === 4 && d.distribuicao.minimo === 1
      && Object.keys(d.distribuicao.destinos).length === 0, JSON.stringify(d.distribuicao));
    checar(`${d.competencia}: fechamento da titular registrado e nenhum do destino`, d.fechamento.resultado === "REGISTRADO" && !(d.fechamentosDestino?.length));
  }
  checar("fuso: 23:59:59 e 00:00:00 (-03:00) ficam no próprio dia", await q(`select count(*) from foody_pedidos where unidade_id = '${UNI_T}' and
    ((foody_uid like 'h-${D1}-%' and competencia = '${D1}') or (foody_uid like 'h-${D2}-%' and competencia = '${D2}'));`) === "10");
  checar("destino PENDENTE não recebe pedido algum", await q(`select count(*) from foody_pedidos where unidade_id = '${UNI_D}' or organizacao_id = '${ORG_D}';`) === "0");
  checar("nenhum uid ativo em dois tenants", await q(`select count(*) from (select conexao_id, foody_uid from foody_pedidos where roteamento_ativo and conexao_id = '${conexaoId}' group by 1,2 having count(*) > 1) x;`) === "0");
  checar("sem dado comercial do Açaí na titular", await q(`select count(*) from foody_pedidos where unidade_id = '${UNI_T}' and operacao = 'acai_no_grau' and (valor_total is not null or detalhes_pedido is not null);`) === "0");
  checar("cancelado gravado na titular", await q(`select count(*) from foody_pedidos where unidade_id = '${UNI_T}' and situacao = 'Cancelado';`) === "2");
  checar("fechamentos só da titular (2), nenhum no destino PENDENTE, autor = admin", await q(`select count(*) filter (where unidade_id = '${UNI_T}') || '/' || count(*) filter (where unidade_id = '${UNI_D}') || '/' || count(distinct gerado_por)
    from foody_fechamentos_logisticos where unidade_id in ('${UNI_T}', '${UNI_D}');`) === "2/0/1");
  checar("dados pessoais descartados (nenhum nome/telefone/endereço)", await q(`select count(*) from foody_pedidos where unidade_id in ('${UNI_T}', '${UNI_D}') and
    (detalhes_pedido ~* 'Maria Fictícia|Cliente Fictício|90000-0000|Rua do Cliente');`) === "0");

  const antes = await q(`select (select count(*) from foody_pedidos where unidade_id in ('${UNI_T}','${UNI_D}')) || '/' || (select count(*) from foody_fechamentos_logisticos where unidade_id in ('${UNI_T}','${UNI_D}'));`);
  const rep = await manual([D1]);
  checar("idempotência: repetir não cria pedido nem versão", rep.dias[0].contagens.inalterados === 5 && rep.dias[0].fechamento.resultado === "SEM_MUDANCA"
    && await q(`select (select count(*) from foody_pedidos where unidade_id in ('${UNI_T}','${UNI_D}')) || '/' || (select count(*) from foody_fechamentos_logisticos where unidade_id in ('${UNI_T}','${UNI_D}'));`) === antes);

  await q(`insert into foody_sync_execucoes (organizacao_id, unidade_id, conexao_id, competencia, janela_inicio, janela_fim, origem, regra_versao, iniciado_em)
     values ('${ORG_T}', '${UNI_T}', '${conexaoId}', '${D1}', '${D1}T03:00:00Z', '${D2}T03:00:00Z', 'agendado', 1, '2026-11-04T14:55:00Z');`);
  checar("concorrência: EM_ANDAMENTO recente bloqueia", (await manual([D1]).then(() => "x", (e) => e.codigo)) === "CONCORRENCIA");
  await q(`update foody_sync_execucoes set iniciado_em = '2026-11-04T10:00:00Z' where unidade_id = '${UNI_T}' and status = 'EM_ANDAMENTO';`);
  await manual([D1]);
  checar("abandonada vira FALHOU/ABANDONADA", await q(`select count(*) from foody_sync_execucoes where unidade_id = '${UNI_T}' and status = 'FALHOU' and erro_codigo = 'ABANDONADA';`) === "1");

  statusApi = 401;
  const f401 = await manual([D1, D2]);
  statusApi = 200;
  checar("401: AUTENTICACAO e o resto não executa", JSON.stringify(f401.dias.map((d) => d.erro)) === JSON.stringify(["AUTENTICACAO", "NAO_EXECUTADO"]));
  checar("401 marca a conexão", await q(`select ultimo_erro_codigo from foody_conexoes where id = '${conexaoId}';`) === "AUTENTICACAO");
  await manual([D2]);   // recupera: conexão volta sem erro

  // Paridade com uma importação SINTÉTICA do Parser (mesmos pedidos, hora de parede legada em "Z").
  const impId = randomUUID();
  await q(`insert into parser_fd_importacoes (id, organizacao_id, unidade_id, periodo_inicio, periodo_fim, hash_arquivo, nome_arquivo)
     values ('${impId}', '${ORG_T}', '${UNI_T}', '${D1}', '${D2}', 'homolog-${CARIMBO}', 'HOMOLOG ${CARIMBO}.xlsx');`);
  const linhasParser = todos.map((o) => {
    const parede = o.date.slice(0, 19);
    const op = /Açaí/.test(o.orderDetails) ? "acai_no_grau" : /Misterioso/.test(o.orderDetails) ? "revisao_necessaria" : "subway";
    return `('${impId}', '${ORG_T}', '${UNI_T}', '${o.id}', '${parede}Z', '${o.status === "cancelled" ? "Cancelado" : "Finalizado"}', ${o.courierFee}, ${o.orderTotal}, '${op}', 'incluido', '{}')`;
  });
  await q(`insert into parser_fd_pedidos (importacao_id, organizacao_id, unidade_id, numero_pedido, data_hora, situacao, taxa_entregador, valor_total_pedido, operacao, status_conciliacao, dados_brutos)
     values ${linhasParser.join(", ")};`);
  const { relatorio } = await executarParidade(["--unidade", UNI_T, "--de", D1, "--ate", D2],
    { conn: CONN, consultar: async (_c, sql) => { const r = await sessao.executar(sql); if (r.error) throw new Error(r.error.message); return r.data; } });
  checar("paridade Foody × Parser (sintético) = PARIDADE", relatorio.resumo.resultado === "PARIDADE", JSON.stringify(relatorio.resumo));
  checar("paridade: 10 pareados, 0 troca Subway↔Açaí, 0 em triagem (conta própria, sem compartilhamento)", relatorio.resumo.totais.pareados === 10 && relatorio.resumo.totais.trocaOperacao === 0 && relatorio.resumo.totais.triagemFoody === 0,
    JSON.stringify(relatorio.resumo.totais));
  checar("API Foody: só a falsa, só GET", getsFoody > 0);
  return { relatorioParidade: relatorio.resumo };
}

const inicio = new Date().toISOString();
let erro = null, extra = null, antes = null, limpezaOk = false, diferencas = [];
sessao = abrirSessaoTransacional(CONN, { ocultar: [TOKEN, SEGREDO] });
try {
  antes = await impressao(sessao);
  await criarCenario();
  extra = await cenario();
} catch (e) { erro = e; }
finally { await sessao.encerrar(); }   // ROLLBACK: nada do cenário sintético é gravado
try {
  const leitura = abrirSessaoTransacional(CONN);
  const depois = await impressao(leitura);
  await leitura.encerrar();
  diferencas = Object.keys({ ...antes, ...depois }).filter((k) => antes?.[k] !== depois[k]).map((k) => `${k}: ${antes?.[k]} → ${depois[k]}`);
  limpezaOk = Boolean(antes) && diferencas.length === 0;
} catch (e) { diferencas = [`conferência depois falhou: ${e.message}`]; }
const chavesFoody = Object.keys(antes ?? {}).filter((k) => k.startsWith("foody_"));
const saida = {
  alvo: descartavel ? "ENSAIO local (Postgres descartável, schema real)" : "Supabase TESTE (wiqqsxnysbzhcrzrrean)", inicio, fim: new Date().toISOString(), carimbo: CARIMBO,
  resultado: !erro && limpezaOk ? "PASS" : "FAIL", erro: erro ? String(erro.message).slice(0, 400) : null,
  verificacoes: resultados, aprovadas: resultados.filter((r) => r.ok).length, total: resultados.length,
  impressao: { tabelas: Object.keys(antes ?? {}).length, foodyAntes: Object.fromEntries(chavesFoody.map((k) => [k, antes[k]])), identicaDepois: limpezaOk, diferencas },
  metodo: "sessão única + transação com ROLLBACK (savepoint por comando; constraints imediatas)",
  paridade: extra?.relatorioParidade ?? null,
};
if (evid) { mkdirSync(evid, { recursive: true }); writeFileSync(join(evid, `homologacao-sync-${CARIMBO}.json`), JSON.stringify(saida, null, 2), { flag: "wx" }); }
process.stdout.write(`${JSON.stringify(saida, null, 2)}\n`);
descartavel?.derrubar?.();
process.exitCode = saida.resultado === "PASS" ? 0 : 1;
