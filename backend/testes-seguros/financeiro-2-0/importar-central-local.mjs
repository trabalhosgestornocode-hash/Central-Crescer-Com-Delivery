// Importação da Central Financeira Unificada → Financeiro 2.0, SOMENTE no banco DESCARTÁVEL local.
// Não há caminho para produção: recusa qualquer banco que não seja fin20* em 127.0.0.1:54321 com MARCADOR_DESCARTAVEL.
//
//   PG_CLUSTER_DIR=<cluster descartável> node testes-seguros/financeiro-2-0/importar-central-local.mjs \
//      --central <Central.xlsx> --de-para <de-para.json> --org <uuid> --unidade <uuid> --db fin20xxx --saida <pasta local> [--aplicar]
//
// Sem --aplicar: SIMULAÇÃO (nada é gravado) + relatório de diferenças (JSON e Markdown) na pasta de saída.
// Com --aplicar: grava numa única transação (READ COMMITTED) e repete o plano para provar a idempotência.
// Os arquivos de entrada (planilha e de-para) e o relatório ficam FORA do repositório: contêm dados financeiros reais.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { lerCentralXlsx } from "../../src/modules/gestao-financeira/dominio/importacao/leitorCentralXlsx.js";
import { planejarImportacaoCentral } from "../../src/financeiro-calculos/importacaoCentral.js";

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const sair = (c, m) => { (c ? console.error : console.log)(m); process.exit(c); };
const ARQ = arg("central"), DP = arg("de-para"), ORG = arg("org"), UNI = arg("unidade"), DB = arg("db"), SAIDA = arg("saida");
const APLICAR = process.argv.includes("--aplicar");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMPORTADOR = "00000000-0000-4000-8000-0000000c0de1";   // autor sintético da importação local

if (!ARQ || !DP || !SAIDA) sair(2, "uso: --central <xlsx> --de-para <json> --org <uuid> --unidade <uuid> --db fin20xxx --saida <pasta> [--aplicar]");
if (!UUID.test(ORG ?? "") || !UUID.test(UNI ?? "")) sair(2, "RECUSADO: --org e --unidade precisam ser UUIDs");
if (!/^fin20[a-z0-9_]*$/.test(DB ?? "")) sair(2, "RECUSADO: só bancos descartáveis fin20*");
const CL = process.env.PG_CLUSTER_DIR;
if (!CL || !existsSync(path.join(CL, "MARCADOR_DESCARTAVEL"))) sair(2, "RECUSADO: PG_CLUSTER_DIR sem MARCADOR_DESCARTAVEL");
const PSQL = existsSync("C:/Program Files/PostgreSQL/17/bin/psql.exe") ? "C:/Program Files/PostgreSQL/17/bin/psql.exe" : "psql";
const AMBIENTE = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^PG/.test(k)));   // nenhum PG* do terminal desvia o destino
AMBIENTE.PGCLIENTENCODING = "UTF8";
const psql = (sql, { usuario = "postgres" } = {}) => {
  const r = spawnSync(PSQL, ["-X", "-h", "127.0.0.1", "-p", "54321", "-U", usuario, "-d", DB, "-v", "ON_ERROR_STOP=1", "-tA", "-q", "-f", "-"],
    { input: sql, encoding: "utf8", maxBuffer: 256 << 20, env: AMBIENTE });
  if (r.status !== 0) throw new Error(r.stderr.split("\n").filter((l) => /ERRO|ERROR|DETAIL|DETALHE/.test(l)).slice(0, 4).join("\n") || r.stderr);
  return r.stdout.trim();
};
const dd = psql("show data_directory").replace(/\\/g, "/").toLowerCase();
if (!dd.startsWith(path.resolve(CL).replace(/\\/g, "/").toLowerCase())) sair(2, "RECUSADO: o servidor em 127.0.0.1:54321 não é o cluster descartável informado");

const j = (sql) => JSON.parse(psql(sql) || "null");
function lerSistema() {
  const w = `organizacao_id = '${ORG}' and unidade_id = '${UNI}'`;
  return j(`select json_build_object(
    'contas', coalesce((select json_agg(json_build_object('id', id, 'nome', nome)) from fin_contas where ${w}), '[]'),
    'categorias', coalesce((select json_agg(json_build_object('id', id, 'nome', nome, 'tipo', tipo)) from fin_plano_contas where organizacao_id = '${ORG}'), '[]'),
    'fornecedores', coalesce((select json_agg(json_build_object('id', id, 'nome', nome)) from fin_fornecedores where organizacao_id = '${ORG}'), '[]'),
    'lancamentos', coalesce((select json_agg(json_build_object('id', l.id, 'conta', c.nome, 'data', l.data_movimento, 'sentido', l.sentido, 'valorCentavos', l.valor_centavos,
        'descricao', l.descricao, 'status', l.status,
        'transferencia', (pc.papel in ('transferencia', 'saldo_anterior') or exists (select 1 from fin_transferencias t where t.status is distinct from 'cancelada'
                          and l.id in (t.lancamento_saida_id, t.lancamento_entrada_id)))))
      from fin_lancamentos l join fin_contas c on c.id = l.conta_id left join fin_plano_contas pc on pc.id = l.categoria_id
      where l.organizacao_id = '${ORG}' and l.unidade_id = '${UNI}'), '[]'),
    'obrigacoes', coalesce((select json_agg(json_build_object('id', o.id, 'chave', o.chave_origem, 'impressao',
        concat_ws('|', upper(f.nome), upper(pc.nome), to_char(o.competencia, 'YYYY-MM'), o.vencimento, o.valor_original_centavos)))
        from fin_obrigacoes o join fin_fornecedores f on f.id = o.fornecedor_id join fin_plano_contas pc on pc.id = o.categoria_id where o.${w.replace(/ and /, " and o.")} and o.chave_origem like 'central:%'), '[]'),
    'pagamentos', coalesce((select json_agg(json_build_object('id', p.id, 'chave', p.chave_origem, 'impressao', concat_ws('|', o.chave_origem, upper(c.nome), p.data_pagamento, p.valor_centavos)))
        from fin_pagamentos p join fin_obrigacoes o on o.id = p.obrigacao_id join fin_contas c on c.id = p.conta_id where p.${w.replace(/ and /, " and p.")} and p.chave_origem like 'central:%' and p.status = 'ativo'), '[]'),
    'vinculos', coalesce((select json_agg(json_build_object('pagamentoChave', p.chave_origem, 'lancamentoId', v.lancamento_id)) from fin_conciliacao_saidas v
        join fin_pagamentos p on p.id = v.pagamento_id where v.${w.replace(/ and /, " and v.")} and v.status in ('sugerido', 'conciliado', 'divergente')), '[]'),
    'aberturas', coalesce((select json_agg(json_build_object('conta', c.nome, 'data', a.data_referencia, 'valorCentavos', a.valor_centavos)) from fin_saldos_abertura a join fin_contas c on c.id = a.conta_id where a.organizacao_id = '${ORG}' and a.unidade_id = '${UNI}'), '[]'),
    'mesesFechados', coalesce((select json_agg(to_char(mes, 'YYYY-MM')) from fin_periodos where ${w} and status = 'fechado'), '[]')
  )::text`);
}
// a impressão do banco usa nomes em maiúsculas sem normalizar acento; o núcleo normaliza → aplicar a mesma normalização aqui
const sa = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toUpperCase();
const normImp = (s) => String(s).split("|").map((x, i) => (i <= 1 ? sa(x) : x)).join("|");
const normImpPag = (s) => String(s).split("|").map((x, i) => (i === 1 ? sa(x) : x)).join("|");

const central = lerCentralXlsx(readFileSync(ARQ));
const dpArq = JSON.parse(readFileSync(DP, "utf8"));
// --proposta-completa (SÓ para ensaio no banco descartável): inclui os itens "a confirmar" e o fornecedor marcador.
const PROPOSTA = process.argv.includes("--proposta-completa");
const dePara = { contas: dpArq.contas, categorias: { ...dpArq.categorias, ...(PROPOSTA ? Object.fromEntries(Object.entries(dpArq.categorias_a_confirmar ?? {}).map(([k, v]) => [k, String(v).replace(/\s*\(.*$/, "")])) : {}) },
  fornecedorAusente: PROPOSTA ? dpArq.fornecedor_ausente_proposto ?? null : dpArq.fornecedor_ausente ?? null, fornecedoresPorId: {} };
// --fornecedores <csv ;> : complemento preenchido pela contadora (colunas ID e "Fornecedor (PREENCHER)"); linhas vazias são ignoradas
const FCSV = arg("fornecedores");
if (FCSV) {
  const [cab, ...ls] = readFileSync(FCSV, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean).map((l) => l.split(";"));
  const iId = cab.indexOf("ID"), iF = cab.findIndex((c) => /^Fornecedor/i.test(c));
  for (const l of ls) if (l[iF]?.trim()) dePara.fornecedoresPorId[l[iId]] = l[iF].trim();
  console.log("complemento de fornecedores:", Object.keys(dePara.fornecedoresPorId).length);
}
if (PROPOSTA) console.log("ATENÇÃO: --proposta-completa usa itens AINDA NÃO APROVADOS (só ensaio local)");
const planejar = () => {
  const s = lerSistema();
  s.obrigacoes = s.obrigacoes.map((o) => ({ ...o, impressao: normImp(o.impressao) }));
  s.pagamentos = s.pagamentos.map((p) => ({ ...p, impressao: normImpPag(p.impressao) }));
  return planejarImportacaoCentral({ central, sistema: s, dePara });
};

mkdirSync(SAIDA, { recursive: true });
const plano = planejar();
const carimbo = new Date().toISOString().replace(/[:.]/g, "-");
const relatorio = (p, rotulo) => {
  const f = path.join(SAIDA, `central-${rotulo}-${carimbo}`);
  writeFileSync(`${f}.json`, JSON.stringify(p, null, 1));
  const linhas = [`# Relatório de diferenças — ${rotulo}`, "", "```", JSON.stringify(p.resumo, null, 1), "```", "",
    "## Obrigações bloqueadas", ...p.obrigacoes.filter((o) => o.situacao === "bloqueada").map((o) => `- ${o.id}: ${o.motivos.join("; ")}`),
    "", "## Obrigações divergentes (não sobrescritas)", ...p.obrigacoes.filter((o) => o.situacao === "divergente").map((o) => `- ${o.id}`),
    "", "## Pagamentos bloqueados", ...p.pagamentos.filter((x) => x.situacao === "bloqueado").map((x) => `- ${x.id}: ${x.motivos.join("; ")}`),
    "", "## Pagamentos sem vínculo com o extrato (ficam pendentes de conciliação)", ...p.semVinculo.map((x) => `- ${x.pagamento}: ${x.motivo}`),
    "", "## Registros fora de contas a pagar", ...p.excluidas.map((x) => `- ${x.id} (${x.tipo}): ${x.motivo}`)];
  writeFileSync(`${f}.md`, linhas.join("\n"));
  return f;
};
console.log(`${APLICAR ? "APLICAR" : "SIMULAÇÃO"} — banco descartável ${DB}`);
console.log("resumo:", JSON.stringify(plano.resumo));
console.log("relatório:", relatorio(plano, APLICAR ? "antes" : "simulacao"));
if (!APLICAR) sair(0, "SIMULAÇÃO: nada foi gravado.");
if (plano.resumo.bloqueiaGravacao) sair(1, "RECUSADO: há registros DIVERGENTES de importação anterior — resolver antes (nada foi gravado).");

const novasO = plano.obrigacoes.filter((o) => o.situacao === "nova");
const novosP = plano.pagamentos.filter((p) => p.situacao === "novo");
const dados = JSON.stringify({
  fornecedores: plano.novosFornecedores,
  obrigacoes: novasO.map((o) => ({ chave: o.chave, ref: o.referencia, fornecedor: o.fornecedor, categoria_id: o.categoriaId, descricao: o.descricao.slice(0, 300),
    competencia: `${o.competencia}-01`, vencimento: o.vencimento, valor: o.valorCentavos,
    obs: `${o.pendencias.length ? `PENDENTE: ${o.pendencias.join('; ')}. ` : ''}Importado da Central. Pago na Central: ${o.pagoCentavos} centavos; diferença presumida: ${o.diferencaPresumidaCentavos} centavos (classificação pela contadora).` })),
  pagamentos: novosP.map((p) => ({ chave: p.chave, ref: p.referencia, obrigacao_chave: p.obrigacaoChave, conta_id: p.contaId, data: p.data, valor: p.valorCentavos })),
  saldos: plano.saldos.filter((s) => s.situacao === "novo").map((s) => ({ conta_id: s.contaId, data: s.data, valor: s.valorCentavos, nota: `Saldo inicial informado na Central (${s.fonte || "fonte não indicada"})` })),
  vinculos: plano.vinculos.map((v) => ({ grupo: randomUUID(), lancamento_id: v.lancamentoId, pagamentos: v.pagamentos, status: v.status, regra: v.regra, dif: v.diferencaCentavos, dias: v.diasDiferenca })),
});
if (dados.includes("$IMP$")) sair(2, "RECUSADO: delimitador presente nos dados");
const sql = `begin isolation level read committed;
set local lock_timeout = '5s';
set local role service_role;
create temp table _imp on commit drop as select $IMP$${dados}$IMP$::jsonb d;
insert into fin_fornecedores(organizacao_id, nome, criado_por, atualizado_por)
  select '${ORG}', f, '${IMPORTADOR}', '${IMPORTADOR}' from _imp, jsonb_array_elements_text(d->'fornecedores') f
  on conflict (organizacao_id, (lower(btrim(nome)))) do nothing;
insert into fin_obrigacoes(organizacao_id, unidade_id, fornecedor_id, categoria_id, descricao, competencia, vencimento, valor_original_centavos,
                           origem, chave_origem, referencia_origem, observacoes, criado_por, atualizado_por)
  select '${ORG}', '${UNI}', f.id, (o->>'categoria_id')::uuid, o->>'descricao', (o->>'competencia')::date, (o->>'vencimento')::date, (o->>'valor')::bigint,
         'importacao', o->>'chave', o->>'ref', o->>'obs', '${IMPORTADOR}', '${IMPORTADOR}'
  from _imp, jsonb_array_elements(d->'obrigacoes') o
  join fin_fornecedores f on f.organizacao_id = '${ORG}' and lower(btrim(f.nome)) = lower(btrim(o->>'fornecedor'))
  on conflict (organizacao_id, unidade_id, chave_origem) where chave_origem is not null do nothing;
insert into fin_pagamentos(organizacao_id, unidade_id, obrigacao_id, conta_id, data_pagamento, valor_centavos, origem, chave_origem, referencia_origem, criado_por, atualizado_por)
  select '${ORG}', '${UNI}', ob.id, (p->>'conta_id')::uuid, (p->>'data')::date, (p->>'valor')::bigint, 'importacao', p->>'chave', p->>'ref', '${IMPORTADOR}', '${IMPORTADOR}'
  from _imp, jsonb_array_elements(d->'pagamentos') p
  join fin_obrigacoes ob on ob.organizacao_id = '${ORG}' and ob.unidade_id = '${UNI}' and ob.chave_origem = p->>'obrigacao_chave'
  on conflict (organizacao_id, unidade_id, chave_origem) where chave_origem is not null do nothing;
insert into fin_conciliacao_saidas(organizacao_id, unidade_id, grupo, pagamento_id, lancamento_id, valor_alocado_centavos, status, regra, diferenca_centavos, dias_diferenca, criado_por, atualizado_por)
  select '${ORG}', '${UNI}', (v->>'grupo')::uuid, pg.id, (v->>'lancamento_id')::uuid, pg.valor_centavos, v->>'status', v->>'regra', (v->>'dif')::bigint, (v->>'dias')::int, '${IMPORTADOR}', '${IMPORTADOR}'
  from _imp, jsonb_array_elements(d->'vinculos') v
  cross join lateral jsonb_array_elements_text(v->'pagamentos') pc
  join fin_pagamentos pg on pg.organizacao_id = '${ORG}' and pg.unidade_id = '${UNI}' and pg.chave_origem = pc;
insert into fin_saldos_abertura(organizacao_id, unidade_id, conta_id, data_referencia, valor_centavos, origem, nota, criado_por)
  select '${ORG}', '${UNI}', (s->>'conta_id')::uuid, (s->>'data')::date, (s->>'valor')::bigint, 'importacao', s->>'nota', '${IMPORTADOR}'
  from _imp, jsonb_array_elements(d->'saldos') s
  on conflict (conta_id, data_referencia) do nothing;
select json_build_object('saldos', (select count(*) from fin_saldos_abertura where organizacao_id='${ORG}'), 'obrigacoes', (select count(*) from fin_obrigacoes where organizacao_id='${ORG}' and chave_origem like 'central:%'),
                         'pagamentos', (select count(*) from fin_pagamentos where organizacao_id='${ORG}' and chave_origem like 'central:%'),
                         'vinculos', (select count(*) from fin_conciliacao_saidas where organizacao_id='${ORG}'))::text;
commit;`;
let saida;
try { saida = psql(sql); } catch (e) { sair(1, `FALHA — transação desfeita, nada gravado.\n${e.message}`); }
console.log("gravado (totais no banco descartável):", saida.split("\n").filter(Boolean).pop());
const depois = planejar();
console.log("replanejamento após gravar:", JSON.stringify(depois.resumo));
console.log("relatório pós-gravação:", relatorio(depois, "depois"));
const idem = (depois.resumo.obrigacoes.nova ?? 0) === 0 && (depois.resumo.pagamentos.novo ?? 0) === 0 && depois.vinculos.length === 0 && (depois.resumo.saldosAbertura.novo ?? 0) === 0;
sair(idem ? 0 : 1, idem ? "IMPORTAÇÃO: OK — repetir não gravaria nada (idempotente)" : "ATENÇÃO: o replanejamento ainda encontra registros novos");
