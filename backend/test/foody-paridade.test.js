// Paridade Foody × Parser: comparador PURO, montagem do relatório e o script (só leitura) — com banco falso e, quando há
// CHECKLIST_PERFIL_PG_URL local, contra Postgres real (parser_fd_* + foody_* preenchidos pela sincronização manual de verdade).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compararParidadeDia, resumirParidade, parede } from "../src/modules/foody/foody.paridade.js";
import { lerArgs, montarRelatorio, executar, consultas } from "../scripts/foody-paridade.mjs";
import { motivoPular, criarBancoDescartavel, psqlSync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal } from "./helpers/schema-real-pg.js";

const D = "2026-11-04";
const f = (o) => ({ numero_pedido: "100", data_hora: `${D}T11:00:00`, competencia: D, situacao: "Finalizado", taxa_entregador: 10, valor_total: 40, operacao: "subway", ...o });
const p = (o) => ({ numero_pedido: "100", data_hora: `${D}T11:00:00Z`, situacao: "Finalizado", taxa_entregador: 10, valor_total_pedido: 40, operacao: "subway", ...o });

describe("comparador puro", () => {
  test("dia idêntico (inclusive Açaí no destino e cancelado): PARIDADE", () => {
    const r = compararParidadeDia({ competencia: D,
      foody: [f({}), f({ numero_pedido: "101", data_hora: `${D}T12:00:00`, operacao: "acai_no_grau", taxa_entregador: 7, valor_total: 30 }),
        f({ numero_pedido: "102", data_hora: `${D}T13:00:00`, situacao: "Cancelado" })],
      parser: [p({}), p({ numero_pedido: "101", data_hora: `${D}T12:00:00Z`, operacao: "acai_no_grau", taxa_entregador: 7, valor_total_pedido: 30 }),
        p({ numero_pedido: "102", data_hora: `${D}T13:00:00Z`, situacao: "Cancelado" })] });
    assert.equal(r.resultado, "PARIDADE", JSON.stringify(r.motivos));
    assert.deepEqual(r.contagens, { foody: 3, parser: 3, pareados: 3, soFoody: 0, soParser: 0 });
    assert.deepEqual(r.somas.taxaEntregador, { foody: 27, parser: 27, diferencaPares: 0, soFoody: 0, soParser: 0 });
    assert.deepEqual(r.porOperacao.foody, { subway: 2, acai_no_grau: 1 });
  });
  test("pedido faltando de cada lado, taxa e situação divergentes, troca Subway↔Açaí: DIVERGENTE com cada motivo", () => {
    const r = compararParidadeDia({ competencia: D,
      foody: [f({}), f({ numero_pedido: "200", data_hora: `${D}T14:00:00` }), f({ numero_pedido: "300", data_hora: `${D}T15:00:00`, taxa_entregador: 12 }),
        f({ numero_pedido: "400", data_hora: `${D}T16:00:00`, situacao: "Cancelado" }), f({ numero_pedido: "500", data_hora: `${D}T17:00:00`, operacao: "acai_no_grau", valor_total: null })],
      parser: [p({}), p({ numero_pedido: "201", data_hora: `${D}T14:30:00Z` }), p({ numero_pedido: "300", data_hora: `${D}T15:00:00Z` }),
        p({ numero_pedido: "400", data_hora: `${D}T16:00:00Z` }), p({ numero_pedido: "500", data_hora: `${D}T17:00:00Z` })] });
    assert.equal(r.resultado, "DIVERGENTE");
    assert.deepEqual(r.motivos, ["PEDIDO_SO_NA_FOODY", "PEDIDO_SO_NO_PARSER", "CANCELAMENTO_DIVERGENTE", "TAXA_DIVERGENTE", "TROCA_DE_OPERACAO"]);
    assert.deepEqual(r.divergencias.soFoody.exemplos, ["200"]); assert.deepEqual(r.divergencias.soParser.exemplos, ["201"]);
    assert.deepEqual(r.divergencias.taxa.exemplos, ["300"]); assert.deepEqual(r.divergencias.cancelamento.exemplos, ["400"]);
    assert.equal(r.divergencias.situacao.quantidade, 0, "cancelamento não se mistura com outra situação");
    assert.deepEqual(r.divergencias.trocaOperacao.exemplos, ["500"]);
    assert.equal(r.divergencias.valor.quantidade, 0, "valor nulo (mínimo) na Foody não é divergência");
    assert.equal(r.somas.taxaEntregador.diferencaPares, 2); assert.equal(r.somas.taxaEntregador.soFoody, 10); assert.equal(r.somas.taxaEntregador.soParser, 10);
    assert.deepEqual(r.cancelamentos, { foody: 1, parser: 0, comTaxaFoody: 1, comTaxaParser: 0 });
    assert.deepEqual(r.limitacoes, ["VALOR_MINIMO_TITULAR"]);
  });
  test("taxa ausente na Foody (API sem valor) continua divergência, contada à parte; situação ≠ cancelamento; triagem dos dois lados", () => {
    const r = compararParidadeDia({ competencia: D,
      foody: [f({ taxa_entregador: null }), f({ numero_pedido: "2", data_hora: `${D}T12:00:00`, situacao: "Entregue" }),
        f({ numero_pedido: "3", data_hora: `${D}T13:00:00`, operacao: "triagem" })],
      parser: [p({}), p({ numero_pedido: "2", data_hora: `${D}T12:00:00Z` }), p({ numero_pedido: "3", data_hora: `${D}T13:00:00Z`, operacao: "revisao_necessaria" })] });
    assert.deepEqual(r.motivos, ["SITUACAO_DIVERGENTE", "TAXA_DIVERGENTE"]);
    assert.deepEqual(r.divergencias.taxaAusenteFoody.exemplos, ["100"]); assert.equal(r.somas.taxaEntregador.diferencaPares, -10);
    assert.deepEqual(r.triagem, { foody: 1, parser: 1 });
    const s = resumirParidade([r]);
    assert.equal(s.taxaLogistica.ausenteNaFoody, 1); assert.equal(s.taxaLogistica.diferencaPares, -10); assert.equal(s.cancelamentos.divergentes, 0);
    assert.deepEqual(s.triagem, { foody: 1, parser: 1 });
    assert.deepEqual(s.limitacoes.map((x) => x.codigo), ["SEM_DATA_CANCELAMENTO", "SEM_ORIGEM_PEDIDO", "ENTREGADOR_SO_HASH", "VALOR_MINIMO_TITULAR"]);
  });
  test("mesmo número com horário diferente (único no dia): pareia e aponta só a divergência de horário", () => {
    const r = compararParidadeDia({ competencia: D, foody: [f({ data_hora: `${D}T11:05:00` })], parser: [p({})] });
    assert.equal(r.contagens.pareados, 1); assert.equal(r.divergencias.horario.quantidade, 1); assert.equal(r.resultado, "PARIDADE");
  });
  test("número repetido no dia (não é único): pareia só por número+hora; sobra vira 'só de um lado'", () => {
    const r = compararParidadeDia({ competencia: D, foody: [f({}), f({ data_hora: `${D}T19:00:00` })], parser: [p({}), p({ data_hora: `${D}T20:00:00Z` })] });
    assert.equal(r.contagens.pareados, 1); assert.equal(r.contagens.soFoody, 1); assert.equal(r.contagens.soParser, 1);
  });
  test("triagem na Foody não reprova o dia, mas é contada; revisão do Parser não conta como troca", () => {
    const r = compararParidadeDia({ competencia: D, foody: [f({ operacao: "revisao_necessaria" }), f({ numero_pedido: "2", data_hora: `${D}T12:00:00` })],
      parser: [p({ operacao: "acai_no_grau" }), p({ numero_pedido: "2", data_hora: `${D}T12:00:00Z`, operacao: "revisao_necessaria" })] });
    assert.equal(r.resultado, "PARIDADE"); assert.equal(r.divergencias.triagemFoody.quantidade, 1); assert.equal(r.divergencias.trocaOperacao.quantidade, 0);
  });
  test("hora de parede: o Parser legado ('Z') e a Foody (sem fuso) viram a mesma string, sem conversão", () => {
    assert.equal(parede("2026-11-04T23:59:59Z"), "2026-11-04T23:59:59");
    assert.equal(parede("2026-11-04 23:59:59"), "2026-11-04T23:59:59");
    assert.equal(parede(null), null);
  });
  test("resumo de vários dias: PARIDADE só se todos tiverem", () => {
    const ok = compararParidadeDia({ competencia: D, foody: [f({})], parser: [p({})] });
    const ruim = compararParidadeDia({ competencia: "2026-11-03", foody: [], parser: [p({})] });
    assert.equal(resumirParidade([ok]).resultado, "PARIDADE");
    const r = resumirParidade([ok, ruim]);
    assert.equal(r.resultado, "DIVERGENTE"); assert.deepEqual(r.motivos, ["PEDIDO_SO_NO_PARSER"]); assert.equal(r.diasComParidade, 1);
    assert.equal(resumirParidade([]).resultado, "DIVERGENTE", "sem dado nenhum não é paridade");
  });
  test("saída sem dado pessoal e amostra limitada a 10", () => {
    const muitos = Array.from({ length: 25 }, (_, i) => p({ numero_pedido: String(900 + i), data_hora: `${D}T1${i % 10}:0${i % 6}:00Z` }));
    const r = compararParidadeDia({ competencia: D, foody: [], parser: muitos });
    assert.equal(r.divergencias.soParser.quantidade, 25); assert.equal(r.divergencias.soParser.exemplos.length, 10);
    assert.doesNotMatch(JSON.stringify(r), /cliente|customer|telefone|phone|endereco|address|courierName|entregador_hash/i);
  });
});

describe("script (só leitura)", () => {
  test("argumentos: uuid, datas, limite de 62 dias, não sobrescreve arquivo", () => {
    assert.throws(() => lerArgs(["--unidade", "x", "--de", D, "--ate", D]), /unidade/);
    assert.throws(() => lerArgs(["--unidade", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--de", D, "--ate", "2026-11-03"]), /ate >= de/);
    assert.throws(() => lerArgs(["--unidade", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--de", "2026-01-01", "--ate", "2026-03-31"]), /62 dias/);
    assert.throws(() => lerArgs(["--unidade", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--de", D, "--ate", D, "--saida", "package.json"]), /não sobrescrevo/);
  });
  test("consultas: só SELECT, nada de escrita; janela do Parser em hora de parede legada", () => {
    const q = consultas({ unidade: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", de: D, ate: D });
    for (const s of [q.conexao, q.foody("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), q.parser]) {
      assert.match(s.trim(), /^select /i); assert.doesNotMatch(s, /\b(insert|update|delete|truncate|alter|drop|create|grant)\b/i);
    }
    assert.match(q.parser, /p\.data_hora >= '2026-11-04T00:00:00Z' and p\.data_hora < '2026-11-05T00:00:00Z'/);
    const fonte = readFileSync(new URL("../scripts/foody-paridade.mjs", import.meta.url), "utf8");
    assert.match(fonte, /begin transaction read only;/); assert.match(fonte, /rollback;/);
  });
  test("executar com banco falso: consolida importações sobrepostas do Parser (a mais recente vence)", async () => {
    const parser = [
      { id: "a", importacao_id: "i1", organizacao_id: "o", unidade_id: "u", ...p({}), fonte: { criado_em: "2026-11-05T01:00:00Z" } },
      { id: "b", importacao_id: "i2", organizacao_id: "o", unidade_id: "u", ...p({ taxa_entregador: 10 }), fonte: { criado_em: "2026-11-05T02:00:00Z" } },
    ];
    const respostas = [[{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }], [f({})], parser];
    const { relatorio } = await executar(["--unidade", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--de", D, "--ate", D], { conn: "x", consultar: () => respostas.shift() });
    assert.equal(relatorio.resumo.resultado, "PARIDADE"); assert.equal(relatorio.dias[0].contagens.parser, 1, "a sobreposição não conta duas vezes");
  });
  test("sem conexão viva: erro claro", async () => {
    await assert.rejects(() => executar(["--unidade", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--de", D, "--ate", D], { conn: "x", consultar: () => [] }), /sem conexão/);
  });
});

describe("script contra Postgres real (descartável)", { skip: motivoPular, timeout: 600_000 }, () => {
  let b;
  const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", O = "11111111-1111-4111-8111-111111111111";
  const q = (t) => { const r = psqlSync(b.url, t); assert.equal(r.ok, true, r.err); return r.out.trim(); };
  before(() => {
    b = criarBancoDescartavel("foodyparidade");
    assert.deepEqual(construirSchemaReal(b.url), []);
    q(`insert into organizacoes (id, nome) values ('${O}', 'org'); insert into unidades (id, organizacao_id, nome) values ('${U}', '${O}', 'uni');
       insert into foody_conexoes (id, organizacao_id, unidade_id, status, token_cifrado, token_impressao)
         values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '${O}', '${U}', 'ATIVA', 'k1:ficticio', 'abcdefabcdef');
       insert into foody_sync_execucoes (id, organizacao_id, unidade_id, conexao_id, competencia, janela_inicio, janela_fim, origem, regra_versao, status)
         values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '${O}', '${U}', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '${D}', '${D}T03:00:00Z', '2026-11-05T03:00:00Z', 'manual', 1, 'CONCLUIDA');
       insert into foody_pedidos (organizacao_id, unidade_id, conexao_id, foody_uid, numero_pedido, competencia, data_hora, status_foody, situacao, taxa_entregador,
         valor_total, operacao, entregador_presente, entregador_tipo, fonte_hash, primeira_execucao_id, ultima_execucao_id)
         values ('${O}', '${U}', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'u1', '100', '${D}', '${D} 23:59:59', 'closed', 'Finalizado', 10, 40, 'subway', false, 'sem_entregador',
           repeat('a', 64), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
       insert into parser_fd_importacoes (id, organizacao_id, unidade_id, periodo_inicio, periodo_fim, hash_arquivo)
         values ('99999999-9999-4999-8999-999999999999', '${O}', '${U}', '${D}', '${D}', 'h');
       insert into parser_fd_pedidos (importacao_id, organizacao_id, unidade_id, numero_pedido, data_hora, situacao, taxa_entregador, valor_total_pedido, status_conciliacao, dados_brutos)
         values ('99999999-9999-4999-8999-999999999999', '${O}', '${U}', '100', '${D}T23:59:59Z', 'Finalizado', 10, 40, 'incluido', '{}');`);
  });
  after(() => b?.derrubar?.());
  test("23:59:59 de parede nos dois lados = mesmo dia e mesmo pedido; transação só leitura de verdade", async () => {
    const { relatorio } = await executar(["--unidade", U, "--de", D, "--ate", D], { conn: b.url });
    assert.equal(relatorio.resumo.resultado, "PARIDADE", JSON.stringify(relatorio.dias[0]));
    assert.equal(relatorio.dias[0].contagens.pareados, 1);
    // A sessão do script é read only: uma escrita no mesmo molde é recusada pelo banco.
    const r = psqlSync(b.url, "begin transaction read only; insert into organizacoes (id, nome) values (gen_random_uuid(), 'x'); rollback;");
    assert.equal(r.ok, false); assert.match(r.err, /read-only/);
  });
});
