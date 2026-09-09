// Integração da camada de AJUSTES OPERACIONAIS do Parser Food Delivery
// (entregadores mestre + lançamentos manual/taxa_adicional/avulso + custo
// real + auditoria + isolamento multi-tenant). Mesmo padrão de
// parser-food-delivery-paginacao.test.js: Supabase de TESTE, unidade
// descartável `...b1`, cleanup no `after`. NÃO roda contra produção.
// Rodar: npm run test:integracao   (ou: node --env-file=.env.test-integracao --test test/parser-food-delivery-lancamentos.test.js)
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
const PULAR = motivoPularIntegracao();
import { randomUUID } from "node:crypto";
import { supabase } from "../src/config/supabase.js";
import { obterImportacao, analisarPeriodo } from "../src/modules/parser-food-delivery/parserFoodDelivery.service.js";
import { criarEntregador, listarEntregadores, editarEntregador } from "../src/modules/parser-food-delivery/parserFoodDelivery.entregadores.js";
import {
  criarLancamento, editarLancamento, excluirLancamento, restaurarLancamento, listarLancamentos,
} from "../src/modules/parser-food-delivery/parserFoodDelivery.lancamentos.js";

const ORG_A = "00000000-0000-0000-0000-000000000001";
const UN_A = "00000000-0000-0000-0000-0000000000b1";       // unidade de teste dedicada
const USUARIO = { id: null, nome: "teste automatizado (parser-food-delivery-lancamentos.test.js)", email: "teste@exemplo.com" };

const criados = { importacoes: [], lancamentos: [], entregadores: [] };

async function criarImportacaoComPedido({ prefixo, taxa = 12 }) {
  const impId = randomUUID();
  const pedId = randomUUID();
  await supabase.from("parser_fd_importacoes").insert({
    id: impId, organizacao_id: ORG_A, unidade_id: UN_A,
    periodo_inicio: "2026-03-01", periodo_fim: "2026-03-07",
    nome_arquivo: `lanc-${prefixo}.xls`, hash_arquivo: `hash-${prefixo}-${impId}`,
    total_pedidos: 1, pedidos_subway: 1, coluna_detalhes_encontrada: true,
    entregues: 1, cancelados: 0, cancelados_com_taxa: 0, cancelados_sem_taxa: 0,
    cancelados_recebem_taxa: 0, cancelados_nao_recebem_taxa: 0, cancelados_revisao: 0,
    taxas_brutas: taxa, taxas_descartadas: 0, taxas_validas: taxa,
    codigos_sem_taxa: [], status: "concluida", usuario_nome: USUARIO.nome,
  });
  await supabase.from("parser_fd_pedidos").insert({
    id: pedId, importacao_id: impId, organizacao_id: ORG_A, unidade_id: UN_A,
    numero_pedido: `${prefixo}-1`, data_hora: "2026-03-02T12:00:00Z",
    situacao: "Entregue", entregador: "Vitor", taxa_entregador: taxa, valor_total_pedido: 60,
    operacao: "subway", status_conciliacao: "incluido", dados_brutos: {},
  });
  criados.importacoes.push(impId);
  return { impId, pedId, numeroPedido: `${prefixo}-1` };
}

after(async () => {
  for (const id of criados.lancamentos) await supabase.from("parser_fd_lancamentos").delete().eq("id", id);
  for (const id of criados.importacoes) {
    await supabase.from("parser_fd_pedidos").delete().eq("importacao_id", id);
    await supabase.from("parser_fd_importacoes").delete().eq("id", id);
  }
  await supabase.from("parser_fd_auditoria").delete().in("unidade_id", [UN_A]).in("acao",
    ["lancamento_criado", "lancamento_editado", "lancamento_excluido", "lancamento_restaurado", "entregador_criado", "entregador_editado", "entregador_status_alterado"]);
  for (const id of criados.entregadores) await supabase.from("parser_fd_entregadores").delete().eq("id", id);
});

async function entregador(nome) {
  const e = await criarEntregador({ organizacaoId: ORG_A, unidadeId: UN_A, nome, usuario: USUARIO });
  criados.entregadores.push(e.id);
  return e;
}

describe("Lançamentos operacionais — custo real com entregadores", { skip: PULAR }, () => {
  test("taxa adicional: caso Ronaldo/Vitor — 1 e 2 taxas no mesmo pedido, entregador original intacto", async () => {
    const { impId, pedId, numeroPedido } = await criarImportacaoComPedido({ prefixo: "TA" });
    const ronaldo = await entregador("Ronaldo");

    const l1 = await criarLancamento({
      organizacaoId: ORG_A, unidadeId: UN_A, usuario: USUARIO,
      origem: "taxa_adicional", pedidoId: pedId, entregadorId: ronaldo.id,
      valor: 8, motivo: "endereco_incorreto", data: "2026-03-02",
      observacao: "Cliente informou endereço incorreto; entregador retornou à loja.",
    });
    criados.lancamentos.push(l1.id);
    assert.equal(l1.origem, "taxa_adicional");
    assert.equal(l1.numeroPedido, numeroPedido);

    const l2 = await criarLancamento({
      organizacaoId: ORG_A, unidadeId: UN_A, usuario: USUARIO,
      origem: "taxa_adicional", pedidoId: pedId, entregadorId: ronaldo.id,
      valor: 5, motivo: "retorno_a_loja", data: "2026-03-02",
    });
    criados.lancamentos.push(l2.id);

    const det = await obterImportacao({ organizacaoId: ORG_A, unidadeId: UN_A, importacaoId: impId });
    // Entregador final do pedido NÃO muda.
    assert.equal(det.pedidos[0].entregador, "Vitor");
    assert.equal(det.pedidos[0].taxaEntregador, 12);
    // Custo total do pedido = principal + adicionais.
    assert.equal(det.pedidos[0].custoTotalPedido, 25);
    assert.equal(det.pedidos[0].custosAdicionais.length, 2);
    // taxas_validas persistida (Central de Performance) continua SÓ iFood.
    assert.equal(det.resumo.taxasValidas, 12);
    // Custo real compõe.
    assert.equal(det.resumo.custoReal.ifood, 12);
    assert.equal(det.resumo.custoReal.taxasAdicionais, 13);
    assert.equal(det.resumo.custoReal.total, 25);
  });

  test("avulso: cria/edita/exclui(soft)/restaura; entra no custo real; nunca vira pedido iFood", async () => {
    const { impId } = await criarImportacaoComPedido({ prefixo: "AV" });
    const jose = await entregador("José Avulso");

    const l = await criarLancamento({
      organizacaoId: ORG_A, unidadeId: UN_A, usuario: USUARIO,
      origem: "avulso", entregadorId: jose.id, valor: 20, motivo: "buscar_paes", data: "2026-03-02",
    });
    criados.lancamentos.push(l.id);
    assert.equal(l.pedidoId, null);

    const editado = await editarLancamento({ organizacaoId: ORG_A, unidadeId: UN_A, lancamentoId: l.id, usuario: USUARIO, valor: 25 });
    assert.equal(editado.valor, 25);

    const det1 = await obterImportacao({ organizacaoId: ORG_A, unidadeId: UN_A, importacaoId: impId });
    assert.equal(det1.pedidos.length, 1, "avulso não pode virar pedido iFood");
    assert.equal(det1.resumo.custoReal.avulsos, 25);

    const excl = await excluirLancamento({ organizacaoId: ORG_A, unidadeId: UN_A, lancamentoId: l.id, motivo: "teste de exclusão lógica", usuario: USUARIO });
    assert.equal(excl.excluido, true);
    const det2 = await obterImportacao({ organizacaoId: ORG_A, unidadeId: UN_A, importacaoId: impId });
    assert.equal(det2.resumo.custoReal.avulsos, 0, "lançamento excluído sai do custo");

    const rest = await restaurarLancamento({ organizacaoId: ORG_A, unidadeId: UN_A, lancamentoId: l.id, usuario: USUARIO });
    assert.equal(rest.excluido, false);
  });

  test("entrega manual: origem 'manual', com classificação; nao_recebe_taxa não soma", async () => {
    const { impId } = await criarImportacaoComPedido({ prefixo: "MA" });
    const e = await entregador("Manual Silva");
    const l = await criarLancamento({
      organizacaoId: ORG_A, unidadeId: UN_A, usuario: USUARIO,
      origem: "manual", entregadorId: e.id, valor: 10, data: "2026-03-02",
      situacao: "Entregue", classificacao: "nao_recebe_taxa",
    });
    criados.lancamentos.push(l.id);
    assert.equal(l.origem, "manual");
    assert.equal(l.motivo, "inclusao_manual");
    const det = await obterImportacao({ organizacaoId: ORG_A, unidadeId: UN_A, importacaoId: impId });
    assert.equal(det.resumo.custoReal.manuais, 0);
  });

  test("validações: valor negativo, valor 0 sem justificativa, motivo 'outro' sem descrição", async () => {
    const e = await entregador("Val Silva");
    const base = { organizacaoId: ORG_A, unidadeId: UN_A, usuario: USUARIO, origem: "avulso", entregadorId: e.id, data: "2026-03-02", motivo: "buscar_paes" };
    await assert.rejects(() => criarLancamento({ ...base, valor: -5 }), (err) => err.statusCode === 400);
    await assert.rejects(() => criarLancamento({ ...base, valor: 0 }), (err) => err.statusCode === 400);
    await assert.rejects(() => criarLancamento({ ...base, valor: 10, motivo: "outro" }), (err) => err.statusCode === 400);
    const ok = await criarLancamento({ ...base, valor: 0, observacao: "cortesia autorizada pela gerência" });
    criados.lancamentos.push(ok.id);
    assert.equal(ok.valor, 0);
  });

  test("isolamento multi-tenant: unidade fora da sessão e pedido de outro tenant são bloqueados", async () => {
    const e = await entregador("Cross Tenant");
    const { impId, pedId } = await criarImportacaoComPedido({ prefixo: "XT" });

    // (a) unidade não pertence à organização da sessão -> 403 em resolverUnidade
    await assert.rejects(() => criarLancamento({
      organizacaoId: randomUUID(), unidadeId: UN_A, usuario: USUARIO,
      origem: "avulso", entregadorId: e.id, valor: 5, motivo: "buscar_paes", data: "2026-03-02",
    }), (err) => err.statusCode === 403);

    // (b) pedido existe mas é de outra organização -> 403 em resolverPedidoVinculado
    await supabase.from("parser_fd_pedidos").update({ organizacao_id: "538eea61-6c18-4cf5-bce7-b7c75dce6b2a" }).eq("id", pedId);
    try {
      await assert.rejects(() => criarLancamento({
        organizacaoId: ORG_A, unidadeId: UN_A, usuario: USUARIO,
        origem: "taxa_adicional", pedidoId: pedId, entregadorId: e.id, valor: 5, motivo: "reentrega", data: "2026-03-02",
      }), (err) => err.statusCode === 403);
    } finally {
      await supabase.from("parser_fd_pedidos").update({ organizacao_id: ORG_A }).eq("id", pedId);
    }
    void impId;
  });

  test("período: lançamento fora do intervalo não entra; dentro entra", async () => {
    const e = await entregador("Periodo Silva");
    const dentro = await criarLancamento({ organizacaoId: ORG_A, unidadeId: UN_A, usuario: USUARIO, origem: "avulso", entregadorId: e.id, valor: 30, motivo: "documentos", data: "2026-03-03" });
    const fora = await criarLancamento({ organizacaoId: ORG_A, unidadeId: UN_A, usuario: USUARIO, origem: "avulso", entregadorId: e.id, valor: 99, motivo: "documentos", data: "2026-04-15" });
    criados.lancamentos.push(dentro.id, fora.id);
    const p = await analisarPeriodo({ organizacaoId: ORG_A, unidadeId: UN_A, dataInicio: "2026-03-01", dataFim: "2026-03-07" });
    const ids = p.lancamentos.map((l) => l.id);
    assert.ok(ids.includes(dentro.id));
    assert.ok(!ids.includes(fora.id));
  });

  test("entregadores: dedup por nome normalizado; inativo não pode ser usado sem reativar", async () => {
    const e = await entregador("Duplicado Teste");
    await assert.rejects(() => criarEntregador({ organizacaoId: ORG_A, unidadeId: UN_A, nome: "DUPLICADO   teste", usuario: USUARIO }), (err) => err.statusCode === 400);

    await editarEntregador({ organizacaoId: ORG_A, unidadeId: UN_A, entregadorId: e.id, ativo: false, usuario: USUARIO });
    await assert.rejects(() => criarLancamento({
      organizacaoId: ORG_A, unidadeId: UN_A, usuario: USUARIO, origem: "avulso",
      entregadorId: e.id, valor: 10, motivo: "buscar_paes", data: "2026-03-02",
    }), (err) => err.statusCode === 400);

    const ativos = await listarEntregadores({ organizacaoId: ORG_A, unidadeId: UN_A });
    assert.ok(!ativos.some((x) => x.id === e.id));
  });

  test("auditoria: criar/editar/excluir registram ator e antes/depois", async () => {
    const e = await entregador("Audit Silva");
    const l = await criarLancamento({ organizacaoId: ORG_A, unidadeId: UN_A, usuario: USUARIO, origem: "avulso", entregadorId: e.id, valor: 15, motivo: "servico_operacional", data: "2026-03-02" });
    criados.lancamentos.push(l.id);
    await editarLancamento({ organizacaoId: ORG_A, unidadeId: UN_A, lancamentoId: l.id, usuario: USUARIO, valor: 18 });
    await excluirLancamento({ organizacaoId: ORG_A, unidadeId: UN_A, lancamentoId: l.id, motivo: "teste auditoria", usuario: USUARIO });

    const { data } = await supabase.from("parser_fd_auditoria").select("*").eq("lancamento_id", l.id).order("criado_em", { ascending: true });
    const acoes = (data || []).map((r) => r.acao);
    assert.ok(acoes.includes("lancamento_criado"));
    assert.ok(acoes.includes("lancamento_editado"));
    assert.ok(acoes.includes("lancamento_excluido"));
    const editRow = data.find((r) => r.acao === "lancamento_editado");
    assert.equal(Number(editRow.valor_antes), 15);
    assert.equal(Number(editRow.valor_depois), 18);
    assert.equal(editRow.usuario_nome, USUARIO.nome);
  });
});
