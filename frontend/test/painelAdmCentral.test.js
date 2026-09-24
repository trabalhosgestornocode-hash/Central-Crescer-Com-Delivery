// H.4-B.5 — Central de Comunicação: construtores puros (sem DOM). Vocabulário, saúde, fluxo, empresas, histórico, detalhe, configurações e o TESTE CONTROLADO
// (modal, preview, loading, sucesso, falha, entrega pendente, DELIVERED, READ, timeout visual), mais o cliente da API e o CSS responsivo.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  htmlCabecalhoCentral, htmlCardsSaude, htmlSaudeComunicacao, htmlFluxoComunicacao, ETAPAS_FLUXO, chipStatusMensagem, ROTULO_STATUS_MENSAGEM, TOOLTIP_ENVIADO,
  htmlHistoricoCentral, htmlDetalheMensagem, htmlConfiguracoesCentral, htmlModalTeste, htmlAcompanhamentoTeste, etapasDoTeste, testeTerminou, htmlAbaTeste,
  htmlAbasCentral, ABAS_CENTRAL, TIMEOUT_ENTREGA_SEGUNDOS, TEXTO_CONFIRMACAO_TESTE, estadoWorkerCentral,
} from "../src/painelAdmCentral.js";
import { painelAdmApi } from "../src/painelAdmApi.js";
import { viewComunicacao } from "../src/painelAdmViews.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const TEXTO_TESTE = "Mensagem de teste — Crescer com Delivery.\n\nEste é um teste de comunicação da unidade Subway Saci — Matriz.\n\nNenhuma ação é necessária.\n\n— Crescer com Delivery";
const preparo = (extra = {}) => ({
  organizacao: { organizacaoId: "o1", nome: "Grupo Jailton e Vanessa" }, unidade: { unidadeId: "u1", nome: "Subway Saci — Matriz" },
  unidadesDisponiveis: [{ unidadeId: "u1", nome: "Subway Saci — Matriz" }], contato: { telefoneMascarado: "********88", consentimento: true, verificado: true, optOut: false },
  whatsapp: "conectado", modo: "DISABLED", piloto: { ativo: true, destinatarioPermitido: true }, limite: { usados: 0, maximo: 1 }, previewTexto: TEXTO_TESTE, podeEnviar: true, bloqueios: [], ...extra,
});
const st = (situacao, extra = {}) => ({ mensagemId: "m-1", situacao, status: "SENT", enviadoEm: "2026-09-23T20:00:00Z", entregueEm: null, lidoEm: null, ...extra });

describe("cabeçalho, saúde e fluxo", () => {
  test("título e subtítulo da Central", () => {
    const h = htmlCabecalhoCentral();
    assert.match(h, /Central de Comunicação/);
    assert.match(h, /Acompanhe a automação do WhatsApp, entregas, destinatários e alertas do Crescer com Delivery\./);
  });
  test("cards: Automação (Desativada/Ativada), Gateway (Conectado/Desconectado), Piloto e Organizações", () => {
    const base = { worker: { estado: "desabilitado" }, piloto: { ativo: true, quantidadeDestinos: 1 }, empresas: { habilitadas: 0 } };
    assert.match(htmlCardsSaude({ ...base, gateway: { estado: "conectado" }, comunicacao: { modo: "DISABLED" } }), /Desativada[\s\S]*Conectado/);
    const on = htmlCardsSaude({ ...base, gateway: { estado: "desconectado" }, comunicacao: { modo: "NORMAL" }, empresas: { habilitadas: 1 } });
    assert.match(on, /Ativada/); assert.match(on, /Desconectado/); assert.match(on, /1 habilitada\b/);
    assert.equal(htmlCardsSaude(null), "");
  });
  test("estadoWorkerCentral: desativado / atenção / saudável só com evidência", () => {
    assert.equal(estadoWorkerCentral({ estado: "desabilitado" }).rotulo, "Desativado");
    assert.equal(estadoWorkerCentral({ estado: "habilitado" }).rotulo, "Atenção");
    assert.equal(estadoWorkerCentral({ estado: "habilitado", rodandoNestaInstancia: true, ultimoCicloEm: "x", resultadoUltimoCiclo: "skipped" }).rotulo, "Saudável");
  });
  test("saúde: backend, worker (último ciclo), gateway (sessão), recuperação offline desativada, pipeline — sem segredo", () => {
    const html = htmlSaudeComunicacao({
      backend: { online: true, versao: "99b978e" }, worker: { estado: "habilitado", rodandoNestaInstancia: true, ultimoCicloEm: "2026-09-23T20:00:00Z", resultadoUltimoCiclo: "skipped" },
      gateway: { estado: "conectado", ultimoContatoEm: "2026-09-23T20:00:10Z", leaseValida: true }, entrega: { estado: "operacional", motivo: null },
    });
    for (const t of ["Saúde da Comunicação", "Backend", "Online", "99b978e", "Ciclo ignorado — automação desativada", "Sessão: válida", "Recuperação de fila offline", "Desativado", "Pipeline de entrega", "Operacional"]) assert.ok(html.includes(t), t);
    assert.doesNotMatch(html, /HMAC|token|secret|senha|auth-state|epoch|owner/i);
    assert.match(htmlSaudeComunicacao({ backend: { online: true }, worker: { estado: "habilitado" }, gateway: { estado: "desconectado" }, entrega: { estado: "atencao", motivo: "WhatsApp desconectado" } }), /Atenção/);
  });
  test("fluxo visual: as 7 etapas na ordem e 'Enviado' não é 'Entregue'", () => {
    assert.deepEqual(ETAPAS_FLUXO.map((e) => e.titulo), ["Pendência detectada", "Elegibilidade", "Agendamento", "Fila", "Enviado", "Entregue", "Lido"]);
    const html = htmlFluxoComunicacao();
    for (const e of ETAPAS_FLUXO) assert.ok(html.includes(e.titulo) && html.includes(e.texto.slice(0, 20)));
    assert.match(html, /ainda não é entrega/);
  });
});

describe("rótulos de status: SENT nunca é 'Entregue'", () => {
  test("tabela de rótulos exata", () => {
    assert.deepEqual(ROTULO_STATUS_MENSAGEM, {
      SCHEDULED: "Agendado", PROCESSING: "Preparando envio", SENDING: "Enviando", SENT: "Enviado ao provedor", DELIVERED: "Entregue", READ: "Lido",
      FAILED: "Falhou", DELIVERY_UNKNOWN: "Entrega não confirmada", CANCELLED: "Cancelado", BLOCKED: "Bloqueado",
    });
  });
  test("SENT carrega o tooltip explicativo e nunca o texto 'Entregue'; DELIVERED/READ usam os próprios rótulos", () => {
    const sent = chipStatusMensagem("SENT");
    assert.match(sent, /Enviado ao provedor/); assert.ok(sent.includes(TOOLTIP_ENVIADO.replace(/"/g, "&quot;")));
    assert.doesNotMatch(sent, /Entregue/);
    assert.match(chipStatusMensagem("DELIVERED"), /Entregue/); assert.match(chipStatusMensagem("READ"), /Lido/);
    assert.equal(TOOLTIP_ENVIADO, "O WhatsApp recebeu a solicitação de envio, mas a entrega ao destinatário ainda não foi confirmada.");
  });
});

describe("histórico, detalhe e configurações", () => {
  const pacote = { total: 1, pagina: 1, porPagina: 20, limitadoA500: false, itens: [{
    id: "m1", idAbreviado: "fb67bb11…", empresa: "Grupo Jailton e Vanessa", unidade: "Subway Saci — Matriz", tipo: "teste_comunicacao", origem: "teste_controlado",
    destinatario: "********88", status: "SENT", tentativas: 1, maxTentativas: 1, criadoEm: "2026-09-23T19:22:00Z", entregueEm: null, lidoEm: null,
  }] };
  const orgs = [{ organizacaoId: "o1", nome: "Grupo Jailton e Vanessa", unidades: [{ unidadeId: "u1", nome: "Subway Saci — Matriz" }] }];
  test("colunas, filtros (empresa/unidade/status/origem/período/busca), origem amigável e telefone mascarado", () => {
    const html = htmlHistoricoCentral(pacote, {}, orgs);
    for (const c of ["Data/Hora", "Empresa", "Unidade", "Tipo", "Origem", "Destinatário", "Status", "Tentativas", "Entrega", "Leitura", "Ações"]) assert.ok(html.includes(`<th>${c}</th>`), c);
    for (const f of ['name="organizacaoId"', 'name="unidadeId"', 'name="status"', 'name="origem"', 'name="desde"', 'name="ate"', 'name="busca"']) assert.ok(html.includes(f), f);
    for (const o of ["Automação", "Reforço", "Aviso tardio", "Teste controlado"]) assert.ok(html.includes(`>${o}</option>`), o);
    assert.match(html, /Teste controlado<\/td>/); assert.match(html, /\*{8}88/); assert.match(html, /1\/1/);
    assert.doesNotMatch(html, /\+55\d+|conteudo/); assert.doesNotMatch(html, /Telefone<|type="tel"/);
  });
  test("carregando, vazio e paginação", () => {
    assert.match(htmlHistoricoCentral(null, {}, orgs), /aria-busy/);
    assert.match(htmlHistoricoCentral({ itens: [], total: 0, pagina: 1, porPagina: 20 }, {}, orgs), /Nenhuma mensagem encontrada/);
    assert.match(htmlHistoricoCentral({ ...pacote, total: 45 }, {}, orgs), /Página 1 de 3/);
  });
  test("filtro de unidade acompanha a empresa escolhida", () => {
    const duas = [...orgs, { organizacaoId: "o2", nome: "Outra", unidades: [{ unidadeId: "u9", nome: "Unidade Outra" }] }];
    const html = htmlHistoricoCentral(pacote, { organizacaoId: "o2" }, duas);
    assert.match(html, /Unidade Outra/); assert.doesNotMatch(html, /<option value="u1">/);
  });
  test("detalhe: ids abreviados, timestamps, tentativas e erro — nunca telefone completo", () => {
    const html = htmlDetalheMensagem({ ...pacote.itens[0], providerMessageIdAbreviado: "3EB0ABCD…", enviadoEm: "2026-09-23T19:22:46Z", tentativasDetalhe: [{ numero: 1, iniciadoEm: "2026-09-23T19:22:45Z", finalizadoEm: "2026-09-23T19:22:46Z", resultado: "SENT" }], erro: null });
    for (const t of ["Detalhes da mensagem", "fb67bb11…", "3EB0ABCD…", "Enviada ao provedor", "Aceita pelo WhatsApp", "Motivo do cancelamento", "Tentativa 1"]) assert.ok(html.includes(t), t);
    assert.doesNotMatch(html, /\+55\d+/);
  });
  test("configurações são SOMENTE LEITURA (nenhum input/form) e separam ativação de configuração", () => {
    const html = htmlConfiguracoesCentral({
      tiposDeAlerta: ["dashboard_ifood_d1"], janelaComercial: { seg_sex: { inicio: "08:00", fim: "18:00" }, sab: { inicio: "08:00", fim: "13:00" }, dom: null },
      reforcoD1: { janela: "20:00–22:00", cutoff: "22:30", espacamentoMinimoHoras: 2, diasUteis: "segunda a sábado" }, cooldownsHoras: { atencao: 8, critico: 4 }, limites: { max_por_contato_por_dia: 3 },
      validadeDaMensagemHoras: 24, espalhamentoMaximoMinutos: 30, observacao: "x",
    });
    for (const t of ["Ativação da comunicação", "Configuração operacional", "Segunda a sexta: 08:00–18:00", "Domingo: sem envio", "cutoff 22:30", "Somente leitura"]) assert.ok(html.includes(t), t);
    assert.doesNotMatch(html, /<input|<form|<select|<textarea/);
    assert.match(html, /nunca altera a ativação/);
  });
});

describe("TESTE CONTROLADO — modal", () => {
  test("confirmar: empresa, unidade, contato mascarado, gateway, consentimento, verificação, preview EXATO, confirmação explícita e botão final desabilitado até marcar", () => {
    const html = htmlModalTeste(preparo());
    for (const t of ["Enviar teste de comunicação", "Grupo Jailton e Vanessa", "Subway Saci — Matriz", "********88", "Conectado", "confirmado", "verificado", "desativada (necessário para o teste)", "Enviar mensagem de teste"]) assert.ok(html.includes(t), t);
    assert.ok(html.includes("Este é um teste de comunicação da unidade Subway Saci — Matriz."));
    assert.ok(html.includes(TEXTO_CONFIRMACAO_TESTE));
    assert.equal(TEXTO_CONFIRMACAO_TESTE, "Confirmo o envio de uma mensagem de teste para este destinatário.");
    assert.match(html, /data-padm-acao="confirmar-teste" disabled/, "botão final começa desabilitado");
    assert.match(html, /<input type="checkbox" id="padm-teste-confirma"\s*\/>/);
    assert.doesNotMatch(html, /\+55\d+/);
    assert.doesNotMatch(html, /pendência|alerta D-1|Último lembrete/i, "o texto do teste não é mensagem de pendência");
  });
  test("bloqueios: mostra os motivos, desabilita a confirmação e o telefone continua mascarado", () => {
    const html = htmlModalTeste(preparo({ podeEnviar: false, modo: "NORMAL", whatsapp: "desconectado", bloqueios: [{ codigo: "MODO_NAO_DISABLED", mensagem: "O teste só pode ser feito com a automação desativada." }, { codigo: "GATEWAY_INDISPONIVEL", mensagem: "O WhatsApp não está conectado no momento." }] }));
    assert.match(html, /Não é possível enviar agora/); assert.match(html, /automação desativada/); assert.match(html, /não está conectado/);
    assert.match(html, /id="padm-teste-confirma" disabled/);
  });
  test("várias unidades: seletor de unidade; limite atingido aparece", () => {
    const html = htmlModalTeste(preparo({ unidadesDisponiveis: [{ unidadeId: "u1", nome: "Matriz" }, { unidadeId: "u2", nome: "Filial" }], limite: { usados: 1, maximo: 1 } }));
    assert.match(html, /<select id="padm-teste-unidade">/); assert.match(html, /limite atingido \(1 de 1\)/);
  });
  test("loading (sem preparo), enviando, erro", () => {
    assert.match(htmlModalTeste(null), /aria-busy/);
    const env = htmlModalTeste(preparo(), { fase: "enviando" });
    assert.match(env, /Preparando destinatário/); assert.match(env, /Enviando/); assert.doesNotMatch(env, /Entregue|Lido/);
    const er = htmlModalTeste(preparo(), { fase: "erro", erro: "O WhatsApp não está conectado no momento." });
    assert.match(er, /padm-teste-aviso--erro/); assert.match(er, /Nenhuma mensagem foi enviada/);
  });
});

describe("TESTE CONTROLADO — acompanhamento (SENT → DELIVERED → READ)", () => {
  const rot = (s, o) => etapasDoTeste(s, o).map((e) => `${e.rotulo}:${e.estado}`);
  test("SENT: 'Enviado ao provedor' ok, 'Aguardando confirmação de entrega' em andamento e NENHUM 'Entregue' aceso", () => {
    assert.deepEqual(rot(st("ENVIADO_AO_PROVEDOR")), ["Preparando destinatário:ok", "Enviando:ok", "Enviado ao provedor:ok", "Aguardando confirmação de entrega:andamento", "Lido:pendente"]);
    const html = htmlAcompanhamentoTeste(st("ENVIADO_AO_PROVEDOR"));
    assert.doesNotMatch(html, /Mensagem entregue/); assert.doesNotMatch(html, /padm-etapa--ok"[^>]*>[^<]*<svg[^>]*>[\s\S]*?<\/svg><span>Entregue</);
    assert.match(html, /Aguardando confirmação de entrega/);
  });
  test("DELIVERED acende 'Entregue' (leitura opcional); READ acende tudo", () => {
    assert.deepEqual(rot(st("ENTREGUE", { status: "DELIVERED", entregueEm: "2026-09-23T20:00:05Z" })), ["Preparando destinatário:ok", "Enviando:ok", "Enviado ao provedor:ok", "Entregue:ok", "Lido:pendente"]);
    assert.match(htmlAcompanhamentoTeste(st("ENTREGUE", { entregueEm: "2026-09-23T20:00:05Z" })), /Mensagem entregue\. A leitura é opcional/);
    assert.deepEqual(rot(st("LIDO", { status: "READ", entregueEm: "x", lidoEm: "y" })), ["Preparando destinatário:ok", "Enviando:ok", "Enviado ao provedor:ok", "Entregue:ok", "Lido:ok"]);
    assert.match(htmlAcompanhamentoTeste(st("LIDO", { entregueEm: "x", lidoEm: "y" })), /Mensagem entregue e lida/);
  });
  test("timeout visual (~2,5 min sem DELIVERED): 'Entrega ainda não confirmada' — NÃO é falha, sem retry, com diagnóstico", () => {
    assert.equal(TIMEOUT_ENTREGA_SEGUNDOS, 150);
    const antes = htmlAcompanhamentoTeste(st("ENVIADO_AO_PROVEDOR"), { segundosAguardando: 149 });
    assert.doesNotMatch(antes, /ainda não confirmada/);
    const depois = htmlAcompanhamentoTeste(st("ENVIADO_AO_PROVEDOR"), { segundosAguardando: 151 });
    assert.match(depois, /Entrega ainda não confirmada/); assert.match(depois, /Nenhum reenvio será feito/); assert.doesNotMatch(depois, /falhou|Falhou/);
    assert.match(depois, /Abrir diagnóstico/);
    assert.equal(testeTerminou(st("ENVIADO_AO_PROVEDOR")), false, "o timeout visual não encerra o acompanhamento sozinho");
  });
  test("falha e entrega incerta: mensagem clara, sem reenvio", () => {
    const f = htmlAcompanhamentoTeste(st("FALHOU", { status: "FAILED", erro: "destinatário inexistente" }));
    assert.match(f, /O envio de teste falhou: destinatário inexistente/); assert.match(f, /Nenhuma nova tentativa foi feita/);
    assert.match(htmlAcompanhamentoTeste(st("ENTREGA_NAO_CONFIRMADA", { status: "DELIVERY_UNKNOWN" })), /Nenhum reenvio foi feito/);
    for (const s of ["LIDO", "FALHOU", "CANCELADO", "ENTREGA_NAO_CONFIRMADA"]) assert.equal(testeTerminou(st(s)), true, s);
    for (const s of ["PREPARANDO", "ENVIANDO", "ENVIADO_AO_PROVEDOR", "ENTREGUE"]) assert.equal(testeTerminou(st(s)), false, s);
  });
  test("modal em acompanhamento mostra o alvo mascarado e os tempos", () => {
    const html = htmlModalTeste(preparo(), { fase: "acompanhando", status: st("ENTREGUE", { status: "DELIVERED", entregueEm: "2026-09-23T20:00:05Z" }) });
    assert.match(html, /\*{8}88/); assert.match(html, /Enviado ao provedor:/); assert.match(html, /Entregue:/);
  });
});

describe("aba Teste e navegação", () => {
  const orgs = [{ organizacaoId: "o1", nome: "Grupo Jailton e Vanessa", contato: { telefoneMascarado: "********88" } }, { organizacaoId: "o2", nome: "Sem contato", contato: null }];
  test("botão habilitado só com automação desativada e empresa com destinatário", () => {
    const ok = htmlAbaTeste({ resumo: { comunicacao: { modo: "DISABLED" } }, orgs });
    assert.match(ok, /data-padm-acao="abrir-teste" >Enviar teste|data-padm-acao="abrir-teste"\s*>/); assert.doesNotMatch(ok, /abrir-teste"[^>]*disabled/);
    const on = htmlAbaTeste({ resumo: { comunicacao: { modo: "NORMAL" } }, orgs });
    assert.match(on, /abrir-teste"[^>]*disabled/); assert.match(on, /só pode ser feito com a automação desativada/);
    assert.match(htmlAbaTeste({ resumo: { comunicacao: { modo: "DISABLED" } }, orgs: [orgs[1]] }), /Nenhuma empresa tem destinatário configurado/);
  });
  test("lista de testes realizados", () => {
    const html = htmlAbaTeste({ resumo: { comunicacao: { modo: "DISABLED" } }, orgs, testes: { itens: [{ id: "t1", criadoEm: "2026-09-23T20:00:00Z", empresa: "Grupo Jailton e Vanessa", status: "DELIVERED", entregueEm: "2026-09-23T20:00:05Z", lidoEm: null }] } });
    assert.match(html, /Testes realizados/); assert.match(html, /Entregue/);
    assert.match(htmlAbaTeste({ resumo: { comunicacao: { modo: "DISABLED" } }, orgs }), /Nenhum teste realizado ainda/);
  });
  test("abas: Visão geral, Empresas, Histórico, Fila, Configurações, Teste; a inicial é a Visão geral", () => {
    assert.deepEqual(ABAS_CENTRAL.map(([, l]) => l), ["Visão geral", "Empresas", "Histórico", "Fila", "Configurações", "Teste"]);
    assert.match(htmlAbasCentral("historico"), /data-padm-com-aba="historico" role="tab" aria-selected="true"/);
    assert.equal(viewComunicacao.aba, "visao-geral");
  });
});

describe("CSS responsivo", () => {
  test("CSS responsivo: fluxo, saúde, detalhe e filtros têm regras de celular", () => {
    const css = readFileSync(join(aqui, "..", "src", "styles.css"), "utf8");
    const bloco = css.slice(css.indexOf("Central de Comunicação (H.4-B.5)"));
    assert.ok(bloco.includes("@media (max-width: 1100px)") && bloco.includes(".padm-fluxo { grid-template-columns: repeat(2"), "fluxo em 2 colunas em telas médias");
    assert.ok(bloco.includes("@media (max-width: 700px)") && bloco.includes(".padm-fluxo { grid-template-columns: 1fr; }"), "fluxo em 1 coluna no celular");
    assert.ok(bloco.includes(".padm-saude-lista li { grid-template-columns: 1fr; }") && bloco.includes(".padm-filtros { grid-template-columns: 1fr 1fr; }") && bloco.includes(".padm-detalhe > div { grid-template-columns: 1fr;"));
    assert.match(bloco, /\.padm-tabela--larga \{ min-width/);
  });
});
