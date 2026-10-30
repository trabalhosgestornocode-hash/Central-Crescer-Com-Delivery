// Dashboard Operacional 2.0 — fechamento diário de ponta a ponta (service + cálculo + diagnóstico + WhatsApp simulado + Excel)
// sobre o cenário SINTÉTICO de test/helpers/operacional-sintetico.js. Valores esperados calculados à mão (comentários).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "ficticio_service_role_key_0123456789abcdef";
process.env.SUPABASE_ANON_KEY ??= "ficticio_anon_key_0123456789abcdef0123";

const svc = await import("../src/modules/checklist-operacional/checklistOperacional.operacional.service.js");
const { obterDashboard } = await import("../src/modules/checklist-operacional/checklistOperacional.service.js");
const { gerarExcelFechamento } = await import("../src/modules/checklist-operacional/checklistOperacional.exportar.js");
const { decidirStatus, JANELA_CONSOLIDACAO_MS } = await import("../src/modules/checklist-operacional/checklistOperacional.fechamento.js");
const { bancoSintetico, repoFake, opFake, TENANT_A1, ORG_A, UN_A2, PII, local, pedido } = await import("./helpers/operacional-sintetico.js");

const AGORA_CONSOLIDADO = () => new Date("2026-10-28T12:00:00.000Z");   // 09:00 de 28/10 em SP: janela de 6 h já encerrada
const ambiente = (opcoes = {}) => {
  const b = bancoSintetico();
  return { ...b, deps: { repo: repoFake(b.db), op: opFake(b.db, opcoes), ia: {} } };
};
const gerar = (amb, extra = {}) => svc.gerarFechamento({ ...TENANT_A1, competencia: amb.competencia, agora: AGORA_CONSOLIDADO, deps: amb.deps, ...extra });

describe("fechamento — os 11 indicadores no cenário sintético", () => {
  test("pedidos por competência: entrada, conclusão e cancelamento nunca misturados", async () => {
    const amb = ambiente();
    const { fechamento: f, resultado } = await gerar(amb);
    assert.equal(resultado, "REGISTRADO");
    const p = f.indicadores.pedidos;
    // 35 reais recebidos em 27/10 (o de teste fica fora; o de 26/10 23:55 não entra)
    assert.equal(p.recebidos, 35);
    // 31 concluídos que chegaram em 27/10 + o de 26/10 concluído às 00:25 de 27/10; o de 23:50 conclui em 28/10 (fora)
    assert.equal(p.concluidosNoDia, 32);
    assert.equal(p.canceladosNoDia, 3);
    // coorte de entrada: a identidade só vale aqui
    assert.deepEqual(p.coorte, { recebidos: 35, concluidos: 32, cancelados: 3, emAberto: 0 });
    assert.equal(p.coorte.concluidos + p.coorte.cancelados + p.coorte.emAberto, p.coorte.recebidos);
    assert.equal(p.pedidosTeste, 1);
  });

  test("tempos médios com amostra, meta, início, fim e população declarados", async () => {
    const { fechamento: f } = await gerar(ambiente());
    const { preparo, entrega, vida } = f.indicadores;
    // preparo: 23×14 + 4×30 + 2×11 = 464 / 29 = 16,0
    assert.deepEqual([preparo.media, preparo.amostras, preparo.meta, preparo.desvioDaMetaMin], [16, 29, 20, -4]);
    // entrega: 22×13 + 4×20 + 2×10 + 16 = 402 / 29 = 13,9
    assert.deepEqual([entrega.media, entrega.amostras, entrega.meta], [13.9, 29, 15]);
    // vida: 22×27 + 4×50 + 2×21 + 30 = 866 / 29 = 29,9
    assert.deepEqual([vida.media, vida.amostras, vida.meta], [29.9, 29, 35]);
    for (const t of [preparo, entrega, vida]) { assert.ok(t.inicio && t.fim && t.populacao && t.fonte); assert.equal(t.estado, "calculado"); }
  });

  test("atrasos: quantidade, % e principal etapa — sem atribuir responsável", async () => {
    const { fechamento: f } = await gerar(ambiente());
    const a = f.indicadores.atrasos;
    // 4 pedidos lentos (as 3 etapas) + o de 23:50 (entrega 16 > 15) = 5 de 29 avaliados
    assert.deepEqual([a.pedidosAtrasados, a.pedidosAvaliados, a.pct], [5, 29, 17.2]);
    assert.equal(a.principalEtapa.etapa, "entrega");
    assert.equal(a.causaAtribuida, false);
  });

  test("cancelamentos por motivo/origem/estágio oficiais; horários de pico; disputas; descontos; clientes", async () => {
    const { fechamento: f } = await gerar(ambiente());
    const i = f.indicadores;
    assert.deepEqual(i.cancelamentos.motivos.map((m) => [m.codigo, m.quantidade]), [["502", 2], ["411", 1]]);
    assert.deepEqual(i.cancelamentos.porOrigem.map((o) => o.origem), ["RESTAURANT", "CONSUMER_VIA_OPERATION"]);
    assert.equal(i.cancelamentos.taxaDaCoortePct, 8.6);
    assert.equal(i.movimento.picos[0].hora, 19);
    assert.deepEqual([i.disputas.abertasNoDia, i.disputas.expiradasNoDia, i.disputas.aceitasNoDia], [2, 1, 1]);
    // desconto da loja: 4 pedidos × R$ 8 (k = 0, 5, 10, 15)
    assert.equal(i.descontos.loja, 32);
    assert.equal(i.descontos.pedidosComDescontoLoja, 4);
    assert.match(i.descontos.natureza, /operacional/);
    // clientes: 5 normais + 4 lentos sem pedido anterior; 1 sem detalhes
    assert.deepEqual([i.clientes.novos, i.clientes.recorrentes, i.clientes.semInformacao], [9, 25, 1]);
    assert.match(i.clientes.unidadeDeContagem, /pedidos/);
  });

  test("status CONSOLIDADO depois da janela; pendências de qualidade listadas (nunca escondidas)", async () => {
    const { fechamento: f } = await gerar(ambiente());
    assert.equal(f.status, "CONSOLIDADO");
    assert.ok(f.pendencias.some((p) => p.codigo === "DETALHES_DESATUALIZADOS"));
    assert.equal(f.fuso, "America/Sao_Paulo");
    assert.equal(f.fuso_origem, "padrao_plataforma");
    assert.match(f.execucao_id, /^[0-9a-f-]{36}$/);
  });

  test("diagnóstico determinístico: achado principal com evidência; nunca causa", async () => {
    const { fechamento: f } = await gerar(ambiente());
    const d = f.diagnostico;
    assert.equal(d.texto.origem, "deterministico");
    assert.equal(d.texto.motivoFallback, "ia_desligada");
    assert.ok(d.achados.some((a) => a.codigo === "DISPUTAS_EXPIRADAS"));
    assert.ok(d.achados.some((a) => a.codigo === "CANCELAMENTO_ELEVADO"));
    for (const a of d.achados) {
      assert.ok(a.fato && a.referencia && a.acao);
      assert.doesNotMatch(`${a.fato} ${a.acao}`, /porque|devido a|culpa|causad/i);
    }
  });

  test("isolamento: nada de outra unidade da mesma empresa nem de outra empresa", async () => {
    const amb = ambiente();
    const { fechamento: f } = await gerar(amb);
    const s = JSON.stringify(f);
    assert.equal(s.includes("A2-1"), false);
    assert.equal(s.includes("B1-1"), false);
    assert.equal(f.indicadores.disputas.abertasNoDia, 2, "disputa da outra empresa fora");
    // e a outra unidade enxerga só o dela
    const outra = await svc.gerarFechamento({ organizacaoId: ORG_A, unidadeId: UN_A2, competencia: amb.competencia, agora: AGORA_CONSOLIDADO, deps: amb.deps });
    assert.equal(outra.fechamento.indicadores.pedidos.recebidos, 1);
    await assert.rejects(svc.obterFechamento({ organizacaoId: ORG_A, unidadeId: UN_A2, id: f.id, deps: amb.deps }), /não encontrado/);
  });

  test("NENHUM dado pessoal no fechamento armazenado", async () => {
    const { fechamento: f } = await gerar(ambiente());
    const s = JSON.stringify(f);
    for (const v of Object.values(PII)) assert.equal(s.includes(v), false, v);
  });
});

describe("fechamento — mesmos números do Dashboard (sem divergência)", () => {
  test("tempos, atrasos e contagens = Dashboard Operacional do mesmo dia ('ontem')", async () => {
    const amb = ambiente();
    const { fechamento: f } = await gerar(amb);
    const d = await obterDashboard({ ...TENANT_A1, filtro: { periodo: "ontem" }, agora: AGORA_CONSOLIDADO, deps: { repo: amb.deps.repo } });
    assert.equal(d.resumo.pedidos, f.indicadores.pedidos.recebidos);
    assert.equal(d.resumo.pedidosAtrasados, f.indicadores.atrasos.pedidosAtrasados);
    for (const e of ["preparo", "entrega", "vida"]) {
      assert.equal(d.resumo.porEtapa[e].media, f.indicadores[e].media, e);
      assert.equal(d.resumo.porEtapa[e].amostras, f.indicadores[e].amostras, e);
    }
  });

  test("Excel do fechamento lê os MESMOS números da versão armazenada", async () => {
    const { fechamento: f } = await gerar(ambiente());
    const wb = XLSX.read(gerarExcelFechamento({ fechamento: f, unidadeNome: "U" }), { type: "buffer" });
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets.Resumo, { header: 1 });
    const valor = (rot) => linhas.find((l) => l[0] === rot)?.[1];
    assert.equal(valor("Pedidos recebidos"), f.indicadores.pedidos.recebidos);
    assert.equal(valor("Tempo médio de preparo (min)"), f.indicadores.preparo.media);
    assert.equal(valor("Descontos pagos pela loja (R$)"), f.indicadores.descontos.loja);
    assert.equal(linhas.find((l) => l[0] === "Versão")[1], f.versao);
    assert.deepEqual(wb.SheetNames, ["Resumo", "Tempos", "Cancelamentos", "Movimento", "Disputas", "Descontos e clientes", "Diagnóstico", "Rastreabilidade"]);
    const tudo = wb.SheetNames.map((n) => JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 }))).join(" ");
    for (const v of Object.values(PII)) assert.equal(tudo.includes(v), false, v);
    assert.equal(/mediana|P90/i.test(tudo), false, "sem mediana/P90 no relatório gerencial");
  });
});

describe("fechamento — versionamento, idempotência e revisão", () => {
  test("gerar de novo sem mudança nos dados = SEM_MUDANCA (nenhuma versão nova)", async () => {
    const amb = ambiente();
    const a = await gerar(amb);
    const b = await gerar(amb);
    assert.equal(b.resultado, "SEM_MUDANCA");
    assert.equal(b.fechamento.id, a.fechamento.id);
    assert.equal(amb.db.fechamentos.length, 1);
  });

  test("mesma execução repetida (retentativa) = JA_REGISTRADO", async () => {
    const amb = ambiente();
    const execucaoId = "11111111-1111-4111-8111-111111111111";
    await gerar(amb, { execucaoId });
    const r = await gerar(amb, { execucaoId });
    assert.equal(r.resultado, "JA_REGISTRADO");
  });

  test("dados mudaram depois do CONSOLIDADO: manual sem motivo é recusado; com motivo vira REVISADO v2 (v1 preservada)", async () => {
    const amb = ambiente();
    const v1 = (await gerar(amb)).fechamento;
    // um pedido concluído é cancelado depois (correção do iFood)
    const alvo = amb.db.pedidos.find((p) => p.display_id === "1000");
    Object.assign(alvo, { status_oficial: "CANCELLED", status_oficial_em: local("2026-10-27", "13:00"), cancel_event_at: local("2026-10-27", "13:00"), atualizado_em: "2026-10-28T11:00:00.000Z" });
    amb.db.eventos.push({ event_id: "ev-can-tardio", order_id: alvo.order_id, organizacao_id: alvo.organizacao_id, unidade_id: alvo.unidade_id, event_code: "CAN", event_created_at: local("2026-10-27", "13:00"), received_at: "2026-10-28T11:00:00.000Z", metadata: { CANCEL_CODE: "410", CANCEL_CODE_DESCRIPTION: "O pedido não foi entregue", CANCEL_ORIGIN: "CONSUMER", CANCEL_STAGE: "[CONCLUDED]" } });
    await assert.rejects(gerar(amb), /motivo da revisão/);
    const r = await gerar(amb, { motivo: "Cancelamento registrado pelo iFood após o fechamento." });
    assert.equal(r.resultado, "REGISTRADO");
    assert.equal(r.fechamento.status, "REVISADO");
    assert.equal(r.fechamento.versao, 2);
    assert.equal(r.fechamento.substitui_id, v1.id);
    assert.equal(r.fechamento.indicadores.pedidos.canceladosNoDia, 4);
    assert.equal(amb.db.fechamentos.find((f) => f.id === v1.id).indicadores.pedidos.canceladosNoDia, 3, "versão anterior intacta");
  });

  test("reprocessamento agendado com dados alterados vira REVISADO com motivo automático", async () => {
    const amb = ambiente();
    await gerar(amb);
    const alvo = amb.db.pedidos.find((p) => p.display_id === "1001");
    alvo.status_oficial = "CANCELLED"; alvo.cancel_event_at = local("2026-10-27", "13:00"); alvo.atualizado_em = "2026-10-28T11:00:00.000Z";
    const r = await gerar(amb, { origem: "agendado" });
    assert.equal(r.fechamento.status, "REVISADO");
    assert.match(r.fechamento.motivo, /Reprocessamento/);
  });

  test("hoje = PRELIMINAR; antes de 6 h do fim do dia = PRELIMINAR; depois = CONSOLIDADO", async () => {
    const amb = ambiente();
    const hoje = await svc.gerarFechamento({ ...TENANT_A1, competencia: "2026-10-28", agora: AGORA_CONSOLIDADO, deps: amb.deps });
    assert.equal(hoje.fechamento.status, "PRELIMINAR");
    const cedo = await svc.gerarFechamento({ ...TENANT_A1, competencia: amb.competencia, agora: () => new Date("2026-10-28T05:00:00.000Z"), deps: ambiente().deps });
    assert.equal(cedo.fechamento.status, "PRELIMINAR");
    assert.match(cedo.fechamento.fonte.statusMotivo, /Aguardando eventos atrasados/);
  });

  test("INCOMPLETO: antes do primeiro pedido (sem cobertura) e dia sem nenhum evento", async () => {
    const amb = ambiente();
    const antes = await svc.gerarFechamento({ ...TENANT_A1, competencia: "2026-10-01", agora: AGORA_CONSOLIDADO, deps: amb.deps });
    assert.equal(antes.fechamento.status, "INCOMPLETO");
    assert.ok(antes.fechamento.pendencias.some((p) => p.codigo === "SEM_COBERTURA"));
    assert.equal(antes.fechamento.diagnostico.principal.codigo, "DADOS_INCOMPLETOS");
    // dia depois da cobertura, sem nenhum evento: não dá para afirmar que não houve pedido
    const b = bancoSintetico();
    b.db.pedidos.push(pedido({ data: "2026-10-20", hora: "12:00", display: "antigo" }).linha);
    const vazio = await svc.gerarFechamento({ ...TENANT_A1, competencia: "2026-10-23", agora: AGORA_CONSOLIDADO, deps: { repo: repoFake(b.db), op: opFake(b.db), ia: {} } });
    assert.equal(vazio.fechamento.status, "INCOMPLETO");
    assert.ok(vazio.fechamento.pendencias.some((p) => p.codigo === "SEM_SINAL_DE_RECEBIMENTO"));
    assert.equal(vazio.fechamento.indicadores.preparo.estado, "indisponivel");
  });

  test("linha de OUTRO tenant vinda da fonte é recusada pela trava dupla → INCOMPLETO (falha não vira 'sem problema')", async () => {
    const intruso = pedido({ org: "b0000000-0000-4000-8000-00000000000b", un: "b1000000-0000-4000-8000-0000000000b1", data: "2026-10-27", hora: "12:00", display: "INTRUSO" }).linha;
    const amb = ambiente({ pedidoForaDoTenant: intruso });
    const { fechamento: f } = await gerar(amb);
    assert.equal(f.status, "INCOMPLETO");
    assert.ok(f.pendencias.some((p) => p.codigo === "PROJECAO_COM_FALHA"));
    assert.equal(JSON.stringify(f).includes("INTRUSO"), false);
    assert.equal(amb.db.projecoes.has(intruso.order_id), false);
  });

  test("competência futura ou inválida é recusada", async () => {
    await assert.rejects(svc.gerarFechamento({ ...TENANT_A1, competencia: "2026-10-29", agora: AGORA_CONSOLIDADO, deps: ambiente().deps }), /futura/);
    await assert.rejects(svc.gerarFechamento({ ...TENANT_A1, competencia: "2026-02-30", agora: AGORA_CONSOLIDADO, deps: ambiente().deps }), /inválida/);
  });

  test("decidirStatus: INCOMPLETO prevalece sobre a janela; pendências não-bloqueantes não impedem CONSOLIDADO", () => {
    const janela = { inicioMs: 0, fimMs: 1000 };
    const coorte = { emAberto: 2 };
    const base = { competencia: "2026-10-27", hoje: "2026-10-28", agoraMs: 1000 + JANELA_CONSOLIDACAO_MS + 1, janela, coorte };
    assert.equal(decidirStatus({ ...base, cobertura: { fracaoSemDetalhes: 0.2, pedidosSemDetalhes: 2 } }).status, "INCOMPLETO");
    const ok = decidirStatus({ ...base, cobertura: { fracaoSemDetalhes: 0 } });
    assert.equal(ok.status, "CONSOLIDADO");
    assert.ok(ok.pendencias.some((p) => p.codigo === "PEDIDOS_EM_ABERTO"));
  });
});

describe("Pedidos e Ficha 360° pelo service", () => {
  test("lista do período sem dado pessoal; ficha só do próprio tenant; projeção incremental", async () => {
    const amb = ambiente();
    const lista = await svc.listarPedidos({ ...TENANT_A1, filtro: { periodo: "ontem" }, agora: AGORA_CONSOLIDADO, deps: amb.deps });
    assert.equal(lista.total, 36, "35 reais + 1 de teste (marcado)");
    assert.ok(lista.itens.find((i) => i.teste));
    for (const v of Object.values(PII)) assert.equal(JSON.stringify(lista).includes(v), false);
    const gravacoes = amb.db.chamadas.linhasGravadas;
    await svc.listarPedidos({ ...TENANT_A1, filtro: { periodo: "ontem" }, agora: AGORA_CONSOLIDADO, deps: amb.deps });
    assert.equal(amb.db.chamadas.linhasGravadas, gravacoes, "segunda leitura sem mudança na fonte não reprojeta nada");

    const item = lista.itens.find((i) => i.numero === "1100");
    const { ficha } = await svc.obterFicha({ ...TENANT_A1, chave: item.chave, agora: AGORA_CONSOLIDADO, deps: amb.deps });
    assert.equal(ficha.identificacao.numero, "1100");
    assert.equal(ficha.indicadores.preparo.atraso, true);
    await assert.rejects(svc.obterFicha({ organizacaoId: ORG_A, unidadeId: UN_A2, chave: item.chave, agora: AGORA_CONSOLIDADO, deps: amb.deps }), /não encontrado/);
    await assert.rejects(svc.obterFicha({ ...TENANT_A1, chave: "../../etc", deps: amb.deps }), /inválido/);
  });

  test("evento novo depois da projeção faz a ficha se atualizar sozinha (incremental)", async () => {
    const amb = ambiente();
    const lista = await svc.listarPedidos({ ...TENANT_A1, filtro: { periodo: "ontem" }, agora: AGORA_CONSOLIDADO, deps: amb.deps });
    const item = lista.itens.find((i) => i.numero === "1002");
    const alvo = amb.db.pedidos.find((p) => p.display_id === "1002");
    amb.db.eventos.push({ event_id: "ev-opa-novo", order_id: alvo.order_id, organizacao_id: alvo.organizacao_id, unidade_id: alvo.unidade_id, event_code: "OPA", event_created_at: local("2026-10-27", "11:50"), received_at: "2026-10-28T12:30:00.000Z", metadata: {} });
    const { ficha } = await svc.obterFicha({ ...TENANT_A1, chave: item.chave, agora: () => new Date("2026-10-28T12:31:00.000Z"), deps: amb.deps });
    assert.equal(ficha.historico.alteracoes.quantidade, 1);
    assert.equal(ficha.produtos.desatualizado, true);
  });
});

describe("WhatsApp — SOMENTE simulação", () => {
  test("prévia com todas as seções, situação do fechamento, sem dado pessoal e dentro do limite", async () => {
    const amb = ambiente();
    const { fechamento: f } = await gerar(amb);
    const p = await svc.previaWhatsapp({ ...TENANT_A1, id: f.id, deps: amb.deps });
    assert.equal(p.status, "READY_FOR_REVIEW");
    assert.equal(p.envioReal, false);
    assert.equal(p.transporte, "noop");
    for (const s of ["*CRESCER COM DELIVERY*", "*PEDIDOS*", "*TEMPOS (médias)*", "*ATRASOS*", "*MOVIMENTO*", "*CANCELAMENTOS*", "*DISPUTAS*", "*DESCONTOS*", "*CLIENTES*", "*DIAGNÓSTICO*", "*AÇÃO RECOMENDADA*"]) assert.ok(p.mensagem.includes(s), s);
    assert.ok(p.mensagem.includes("CONSOLIDADO"));
    assert.ok(p.mensagem.includes("Recebidos: 35"));
    assert.ok(p.mensagem.length <= 1500, `${p.mensagem.length}`);
    assert.equal(p.mensagem.includes("RELATÓRIO COMPLETO"), false, "sem URL configurada, nenhum link");
    for (const v of Object.values(PII)) assert.equal(p.mensagem.includes(v), false, v);
    assert.equal(/mediana|P90/i.test(p.mensagem), false);
  });

  test("simular registra tentativa noop; repetir NÃO duplica; versão nova gera nova tentativa", async () => {
    const amb = ambiente();
    const { fechamento: f } = await gerar(amb);
    const a = await svc.simularWhatsapp({ ...TENANT_A1, id: f.id, criadoPor: "u1", deps: amb.deps });
    assert.equal(a.simulacao.status, "SIMULATED");
    assert.equal(a.simulacao.transporte, "noop");
    assert.equal(a.envioReal, false);
    const b = await svc.simularWhatsapp({ ...TENANT_A1, id: f.id, criadoPor: "u1", deps: amb.deps });
    assert.equal(b.duplicada, true);
    assert.equal(amb.db.simulacoes.length, 1);
  });

  test("link só entra com base https configurada", async () => {
    const amb = ambiente();
    const { fechamento: f } = await gerar(amb);
    const p = await svc.previaWhatsapp({ ...TENANT_A1, id: f.id, deps: { ...amb.deps, env: { OPERACIONAL_RELATORIO_URL_BASE: "https://central.exemplo" } } });
    assert.match(p.mensagem, /RELATÓRIO COMPLETO\*\nhttps:\/\/central\.exemplo\/#checklist-operacional/);
    const q = await svc.previaWhatsapp({ ...TENANT_A1, id: f.id, deps: { ...amb.deps, env: { OPERACIONAL_RELATORIO_URL_BASE: "http://inseguro" } } });
    assert.equal(q.mensagem.includes("RELATÓRIO COMPLETO"), false);
  });
});
