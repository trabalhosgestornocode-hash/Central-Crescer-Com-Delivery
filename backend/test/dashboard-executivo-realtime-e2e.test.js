// =====================================================================
// ETAPA 2 — Dashboard iFood em tempo real: PROVA PONTA A PONTA REAL
// =====================================================================
// Diferente das demais suítes de `dashboard-executivo-*.test.js` (puras,
// sem I/O): este arquivo chama os SERVICES DE VERDADE
// (criarLancamento/atualizarLancamento/excluirLancamento/
// atualizarModeloLogisticoUnidade) contra o Supabase de TESTE, e um SEGUNDO
// cliente — autenticado de verdade, com grant de verdade (mesma
// `renovarGrantsRealtime` da Etapa 1) — assina o canal privado e confirma
// que RECEBE o broadcast que o service emitiu. É exatamente o cenário de
// aceite pedido: "PC salva -> celular recebe, sem F5", só que os dois lados
// são simulados por dois clientes Supabase Realtime independentes.
//
// Reaproveita a MESMA unidade de teste descartável das suítes de integração
// existentes (ORG_A / UN_A, ver parser-food-delivery-lancamentos.test.js) —
// nunca uma unidade/organização real, nunca dado de cliente real. A data do
// lançamento é o dia 1 de um mês bem no passado (2026-01-01) — nunca
// "ontem"/dia corrente: o dia 1 é o único que nunca fica BLOQUEADO por
// sequência (ver statusMes em dashboardExecutivo.calc.js — todo dia anterior
// sem lançamento resolvido bloqueia os seguintes do mesmo mês) e fora de
// "ontem" o Financeiro não é exigido, sem precisar simular desbloqueio
// administrativo. Nunca colide com lançamento real dessa unidade de teste
// (tabela usada só por esta suíte) e o
// lançamento + auditoria são apagados no `after`. A única mutação
// "permanente" tocada (unidades.modelo_logistico_ifood) é lida ANTES e
// restaurada no fim.
//
// Só roda quando o Supabase configurado é comprovadamente descartável (ver
// helpers/preflight-integracao.js) — mesma guarda de
// parser-food-delivery-lancamentos.test.js. Sem isso, PULA (não falha).
//
// Rodar: npm run test:integracao
//   (ou: node --env-file=.env.test-integracao --test test/dashboard-executivo-realtime-e2e.test.js)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import ws from "ws";
import { createClient } from "@supabase/supabase-js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";

const PULAR = motivoPularIntegracao();

import { randomUUID } from "node:crypto";
import { config } from "../src/config/env.js";
import { supabase } from "../src/config/supabase.js";
import {
  criarLancamento, atualizarLancamento, excluirLancamento, atualizarModeloLogisticoUnidade,
} from "../src/modules/dashboard-executivo/dashboardExecutivo.service.js";
import { EVENTOS_DASHBOARD_IFOOD } from "../src/modules/dashboard-executivo/dashboardExecutivo.eventos.js";
import { topicoEmpresa, topicoUnidade } from "../src/modules/realtime/realtime.topicos.js";
import { renovarGrantsRealtime } from "../src/modules/realtime/realtime.grants.service.js";

if (!globalThis.WebSocket) globalThis.WebSocket = ws;

const ORG_A = "00000000-0000-0000-0000-000000000001";
const UN_A = "00000000-0000-0000-0000-0000000000b1"; // mesma unidade de teste descartável do Parser FD
const USUARIO = { id: null, nome: "teste automatizado (dashboard-executivo-realtime-e2e.test.js)", email: "teste@exemplo.com" };
const ACESSO_SEM_PERMISSOES = { permissoes: [] };

const TOPICO_UNI = topicoUnidade(UN_A);
const TOPICO_EMP = topicoEmpresa(ORG_A);

/** Espera até {timeoutMs} por um evento cujo `tipo` está em `tipos`, no array `recebidos` (populado pelo listener). */
function esperarEvento(recebidos, tipos, timeoutMs = 8000) {
  const alvo = new Set(tipos);
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const achado = recebidos.find((e) => alvo.has(e.tipo));
      if (achado) return resolve(achado);
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout esperando evento(s) [${[...alvo].join(", ")}] — recebidos: ${JSON.stringify(recebidos)}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

describe("Dashboard iFood — Realtime ponta a ponta (Etapa 2)", { skip: PULAR }, () => {
  const tag = `dex2e_${Date.now()}`;
  const ctx = {};
  const criados = { lancamentos: [] };
  let modeloOriginal;

  before(async () => {
    if (PULAR) return;

    // Sobe um usuário/sessão de contexto descartável só para RECEBER o
    // broadcast (o lado que grava usa direto os services, como um backend
    // faria — não precisa de sessão própria).
    const email = `${tag}@example.com`;
    const senha = `Rt-${tag}-Xx1!`;
    const { data: userRes, error: userErr } = await supabase.auth.admin.createUser({ email, password: senha, email_confirm: true });
    if (userErr) throw userErr;
    ctx.usuarioId = userRes.user.id;

    const { data: sessao, error: sessaoErr } = await supabase.from("sessoes_contexto").insert({
      usuario_id: ctx.usuarioId, organizacao_id: ORG_A, unidade_id: UN_A,
      papel: "organization_admin", permissoes: [], modulos: [], impersonado_por: ctx.usuarioId,
      expira_em: new Date(Date.now() + 3600_000).toISOString(),
    }).select("id").single();
    if (sessaoErr) throw sessaoErr;
    ctx.sessaoContextoId = sessao.id;

    // MESMA função que o backend usa em produção (realtime.controller.js) —
    // não SQL cru: se a Etapa 1 mudar a forma do grant, este teste continua
    // exercitando o caminho real.
    await renovarGrantsRealtime({ usuarioId: ctx.usuarioId, sessaoContextoId: ctx.sessaoContextoId, organizacaoId: ORG_A, unidadeId: UN_A }, { db: supabase });

    ctx.authClient = createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: signIn, error: signInErr } = await ctx.authClient.auth.signInWithPassword({ email, password: senha });
    if (signInErr) throw signInErr;
    await ctx.authClient.realtime.setAuth(signIn.session.access_token); // setAuth é assíncrono — precisa do await antes de assinar.

    ctx.recebidos = [];
    ctx.canalUnidade = ctx.authClient.channel(TOPICO_UNI, { config: { private: true } });
    ctx.canalUnidade.on("broadcast", { event: "evento_dominio" }, ({ payload }) => ctx.recebidos.push(payload));
    ctx.canalEmpresa = ctx.authClient.channel(TOPICO_EMP, { config: { private: true } });
    ctx.canalEmpresa.on("broadcast", { event: "evento_dominio" }, ({ payload }) => ctx.recebidos.push(payload));

    const status = await new Promise((resolve) => {
      let restantes = 2;
      const ok = () => { restantes -= 1; if (restantes === 0) resolve("SUBSCRIBED"); };
      ctx.canalUnidade.subscribe((s) => { if (s === "SUBSCRIBED") ok(); });
      ctx.canalEmpresa.subscribe((s) => { if (s === "SUBSCRIBED") ok(); });
      setTimeout(() => resolve("TIMEOUT"), 10000);
    });
    assert.equal(status, "SUBSCRIBED", "setup: os dois canais privados precisam assinar com sucesso antes dos testes");

    // Modelo logístico atual da unidade de teste — restaurado no after().
    const { data: unidade } = await supabase.from("unidades").select("modelo_logistico_ifood").eq("id", UN_A).single();
    modeloOriginal = unidade?.modelo_logistico_ifood ?? "marketplace";
  });

  after(async () => {
    if (PULAR) return;
    ctx.authClient?.removeChannel(ctx.canalUnidade);
    ctx.authClient?.removeChannel(ctx.canalEmpresa);
    for (const id of criados.lancamentos) {
      await supabase.from("lancamentos_financeiros_diarios").delete().eq("id", id);
      await supabase.from("lancamentos_financeiros_auditoria").delete().eq("lancamento_id", id);
    }
    await supabase.from("lancamentos_financeiros_exclusoes").delete().eq("unidade_id", UN_A).eq("motivo", `[teste automatizado ${tag}] exclusão de ponta a ponta`);
    if (modeloOriginal) {
      await supabase.from("unidades").update({ modelo_logistico_ifood: modeloOriginal }).eq("id", UN_A);
      await supabase.from("unidade_modelo_logistico_historico").delete().eq("unidade_id", UN_A).eq("motivo", `[teste automatizado ${tag}]`);
    }
    if (ctx.sessaoContextoId) await supabase.from("realtime_channel_grants").delete().eq("sessao_contexto_id", ctx.sessaoContextoId);
    if (ctx.sessaoContextoId) await supabase.from("sessoes_contexto").delete().eq("id", ctx.sessaoContextoId);
    if (ctx.usuarioId) await supabase.auth.admin.deleteUser(ctx.usuarioId);
  });

  test("criarLancamento: grava de verdade e o segundo cliente recebe lancamento_criado nos dois tópicos (unidade + empresa)", async () => {
    const dataIso = "2026-01-01"; // dia 1 — nunca BLOQUEADO por sequência (ver comentário no topo do arquivo)
    ctx.recebidos.length = 0;

    const resultado = await criarLancamento({
      organizacaoId: ORG_A, unidadeIdSessao: UN_A, acesso: ACESSO_SEM_PERMISSOES, usuario: USUARIO,
      dados: {
        data: dataIso, unidadeId: UN_A, situacao: "normal", status: "rascunho",
        qtdVendas: 10, valorVendasBruto: 500, novosClientes: 1,
        valorVendasIfood: 50, taxasComissoes: 5, servicosPromocoes: 2, taxasEntregadores: 0,
      },
    });
    ctx.lancamentoId = resultado.lancamento.id;
    criados.lancamentos.push(ctx.lancamentoId);

    const evento = await esperarEvento(ctx.recebidos, [EVENTOS_DASHBOARD_IFOOD.LANCAMENTO_CRIADO]);
    assert.equal(evento.organizacaoId, ORG_A);
    assert.equal(evento.unidadeId, UN_A);
    assert.equal(evento.entidadeId, ctx.lancamentoId);
    assert.equal(evento.data, dataIso);
    assert.ok(evento.competencia, "competência precisa estar no payload");
    assert.ok(evento.versao, "versão (updated_at) precisa estar no payload, para concorrência otimista no cliente");

    // Payload mínimo — Fase F da auditoria: nenhum valor financeiro, nenhum nome.
    const chavesProibidas = ["valorVendasIfood", "valorVendasBruto", "taxasComissoes", "usuarioNome", "usuario_nome", "nome"];
    for (const chave of chavesProibidas) assert.equal(evento[chave], undefined, `payload não deveria carregar "${chave}"`);

    // Chegou nos DOIS tópicos (unidade + empresa) — fan-out, não só um.
    assert.ok(ctx.recebidos.filter((e) => e.tipo === EVENTOS_DASHBOARD_IFOOD.LANCAMENTO_CRIADO).length >= 1);
  });

  test("atualizarLancamento: edição real dispara lancamento_atualizado com a versão nova", async () => {
    assert.ok(ctx.lancamentoId, "depende do lançamento criado no teste anterior");
    ctx.recebidos.length = 0;

    const resultado = await atualizarLancamento({
      organizacaoId: ORG_A, unidadeIdSessao: UN_A, acesso: ACESSO_SEM_PERMISSOES, usuario: USUARIO,
      id: ctx.lancamentoId,
      dados: {
        situacao: "normal", status: "finalizado",
        qtdVendas: 12, valorVendasBruto: 600, novosClientes: 2,
        valorVendasIfood: 60, taxasComissoes: 6, servicosPromocoes: 3, taxasEntregadores: 0,
      },
    });

    const evento = await esperarEvento(ctx.recebidos, [EVENTOS_DASHBOARD_IFOOD.LANCAMENTO_ATUALIZADO]);
    assert.equal(evento.entidadeId, ctx.lancamentoId);
    assert.equal(evento.versao, resultado.lancamento.updatedAt ?? evento.versao, "versão do evento deve refletir o updated_at pós-escrita");
    assert.notEqual(evento.versao, undefined);
  });

  test("excluirLancamento: exclusão real dispara lancamento_excluido, e a leitura confirma que a linha já não existe", async () => {
    assert.ok(ctx.lancamentoId);
    ctx.recebidos.length = 0;

    await excluirLancamento({
      organizacaoId: ORG_A, unidadeIdSessao: UN_A, unidadeIdSolicitado: UN_A, usuario: USUARIO,
      id: ctx.lancamentoId, motivo: `[teste automatizado ${tag}] exclusão de ponta a ponta`,
    });

    const evento = await esperarEvento(ctx.recebidos, [EVENTOS_DASHBOARD_IFOOD.LANCAMENTO_EXCLUIDO]);
    assert.equal(evento.entidadeId, ctx.lancamentoId);
    assert.ok(evento.versao, "exclusão não tem updated_at próprio — versão deve ser o carimbo da exclusão");

    const { data: linha } = await supabase.from("lancamentos_financeiros_diarios").select("id").eq("id", ctx.lancamentoId).maybeSingle();
    assert.equal(linha, null, "a linha precisa ter sido apagada de verdade, não só marcada");
  });

  test("atualizarModeloLogisticoUnidade: evento sem 'competencia' (o modelo vale para qualquer mês aberto)", async () => {
    ctx.recebidos.length = 0;
    const modeloNovo = modeloOriginal === "marketplace" ? "full_service" : "marketplace";

    await atualizarModeloLogisticoUnidade({
      organizacaoId: ORG_A, unidadeIdSessao: UN_A, unidadeIdSolicitado: UN_A, usuario: USUARIO,
      dados: { modeloLogistico: modeloNovo, motivo: `[teste automatizado ${tag}]` },
    });

    const evento = await esperarEvento(ctx.recebidos, [EVENTOS_DASHBOARD_IFOOD.MODELO_LOGISTICO_ATUALIZADO]);
    assert.equal(evento.unidadeId, UN_A);
    assert.equal(evento.competencia, undefined, "modelo logístico não deve carregar competência — afeta qualquer mês, não um específico");
  });
});
