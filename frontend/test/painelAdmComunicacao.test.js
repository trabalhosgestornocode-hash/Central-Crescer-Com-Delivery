// Checkpoint H.3-A — construtores puros da área Comunicação/WhatsApp do
// Painel Administrativo. Mesmo estilo de desenvolvimento.test.js: só
// funções HTML->string, sem DOM (não há jsdom neste projeto).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  htmlComunicacaoCards, htmlComunicacaoEmpresas, htmlComunicacaoFila, htmlComunicacaoHistorico,
  htmlSeletorPerfil, htmlDrawerComunicacao, TELAS_PADM,
} from "../src/painelAdmViews.js";

test("a aba Comunicação existe na navegação do Painel Administrativo", () => {
  const tela = TELAS_PADM.find((t) => t.id === "comunicacao");
  assert.ok(tela, "esperava uma tela 'comunicacao' em TELAS_PADM");
  assert.equal(tela.label, "Comunicação");
});

test("cards da visão geral mostram os 3 estados distintos (item 5) sem confundir Gateway/worker/comunicação", () => {
  const html = htmlComunicacaoCards({
    gateway: { estado: "conectado" }, worker: { estado: "habilitado" }, comunicacao: { modo: "DISABLED" },
    empresas: { total: 48, configuradas: 0, habilitadas: 0, pausadas: 0 },
    fila: { scheduled: 0, processing: 0, sending: 0 }, ultimas24h: { enviadas: 0, falhas: 0 },
  });
  assert.ok(html.includes("Conectado"));
  assert.ok(html.includes("Habilitado"));
  assert.ok(html.includes("Pausada")); // rótulo de negócio do modo DISABLED — nunca a palavra "DISABLED" pra o gestor
  assert.ok(html.includes("0 / 48"));
  assert.ok(html.includes("últimas 24h"), "o KPI de falhas precisa deixar claro que é janela móvel, não 'hoje'/UTC");
  assert.ok(!/DISABLED|CONNECTED|offline_batch|marker|auth-state/i.test(html), "vocabulário de engenharia nunca pode vazar pra UI");
});

test("H.3-A.1 item 1/2: card do worker nunca afirma saúde em tempo real (nunca 'Ativo', 'online', 'saudável', 'rodando')", () => {
  const habilitado = htmlComunicacaoCards({
    gateway: { estado: "conectado" }, worker: { estado: "habilitado" }, comunicacao: { modo: "DISABLED" },
    empresas: { total: 1, configuradas: 0, habilitadas: 0, pausadas: 0 },
    fila: { scheduled: 0, processing: 0, sending: 0 }, ultimas24h: { enviadas: 0, falhas: 0 },
  });
  const desabilitado = htmlComunicacaoCards({
    gateway: { estado: "conectado" }, worker: { estado: "desabilitado" }, comunicacao: { modo: "DISABLED" },
    empresas: { total: 1, configuradas: 0, habilitadas: 0, pausadas: 0 },
    fila: { scheduled: 0, processing: 0, sending: 0 }, ultimas24h: { enviadas: 0, falhas: 0 },
  });
  for (const html of [habilitado, desabilitado]) {
    assert.doesNotMatch(html, /\bAtivo\b|\bonline\b|saud[aá]vel|\brodando\b/i);
  }
  assert.ok(habilitado.includes("Habilitado"));
  assert.ok(desabilitado.includes("Desabilitado"));
  // Gateway/Comunicação continuam com fonte própria — não são afetados por esta regra (item 2 do checkpoint).
  assert.ok(habilitado.includes("Conectado"));
  assert.ok(habilitado.includes("Pausada"));
});

test("H.3-A.1 itens 3/6: seletor de perfil é combobox controlado — nunca input de texto livre", () => {
  const perfis = [
    { perfilOperacionalId: "p1", nome: "Fulano da Silva", email: "fulano@teste.com" },
    { perfilOperacionalId: "p2", nome: "Ciclana Souza", email: null },
  ];
  const html = htmlSeletorPerfil(perfis, "p2");
  assert.ok(html.includes("<select"));
  assert.doesNotMatch(html, /<input[^>]*perfilOperacionalId/);
  assert.ok(html.includes("Fulano da Silva (fulano@teste.com)"));
  assert.ok(html.includes("Ciclana Souza"));
  assert.match(html, /<option value="p2" selected>/, "o perfil já configurado precisa vir pré-selecionado");
});

test("H.3-A.1 item 6: organização sem perfil elegível mostra empty state claro, nunca vira input livre", () => {
  const html = htmlSeletorPerfil([], null);
  assert.ok(html.includes("Nenhum perfil disponível para associação."));
  assert.doesNotMatch(html, /<select|<input/);
});

test("H.3-A.1: o drawer usa o seletor controlado (não o input de UUID livre) e nunca mostra o UUID como informação principal", () => {
  const detalhe = {
    organizacao: { organizacaoId: "org-1", nome: "Grupo Saci" },
    configuracao: {
      status: "CONFIGURACAO_INCOMPLETA", timezone: null, tiposPermitidos: [], pausadoAte: null,
      destinatario: { telefoneMascarado: "+55 ** *****-1234", verificado: false, consentimento: false, optOut: false, perfilOperacionalId: "p1" },
    },
    unidades: [],
  };
  const perfis = [{ perfilOperacionalId: "p1", nome: "Fulano da Silva", email: "fulano@teste.com" }];
  const html = htmlDrawerComunicacao(detalhe, perfis);
  assert.doesNotMatch(html, /name="perfilOperacionalId"[^>]*type="text"/);
  assert.ok(html.includes("<select"));
  assert.ok(html.includes("Fulano da Silva"));
});

test("empty state: nenhuma organização configurada não parece um erro (item 30)", () => {
  const html = htmlComunicacaoEmpresas([], "");
  assert.ok(html.includes("Nenhuma empresa configurada"));
  assert.ok(!/erro|falha|exception/i.test(html));
});

test("lista de empresas nunca imprime telefone completo (item 14) — só o que a service já manda mascarado", () => {
  const html = htmlComunicacaoEmpresas([
    { organizacaoId: "org-1", nome: "Grupo Saci", status: "PRONTA_PARA_PILOTO", destinatarioConfigurado: true, timezoneConfigurado: true, pausada: false, pendenciasAtuais: 2, ultimoEnvioEm: null, proximoEnvioEm: null },
  ], "");
  assert.ok(html.includes("Grupo Saci"));
  assert.ok(html.includes("Pronta para piloto"));
  assert.doesNotMatch(html, /\+55\d+/, "a linha da tabela nunca deve montar um telefone E.164 completo");
});

test("busca filtra por nome (item 29) e realça o termo", () => {
  const orgs = [
    { organizacaoId: "1", nome: "Grupo Saci", status: "NAO_CONFIGURADA", destinatarioConfigurado: false, pendenciasAtuais: 0 },
    { organizacaoId: "2", nome: "Outra Empresa", status: "NAO_CONFIGURADA", destinatarioConfigurado: false, pendenciasAtuais: 0 },
  ];
  const html = htmlComunicacaoEmpresas(orgs, "saci");
  assert.ok(html.includes("<mark"));
  assert.ok(!html.includes("Outra Empresa") || html.indexOf("Grupo Saci") < html.indexOf("Nenhuma empresa encontrada"));
});

test("fila vazia mostra estado positivo, não erro (item 30)", () => {
  const html = htmlComunicacaoFila({ itens: [], total: 0, pagina: 1, porPagina: 20 }, []);
  assert.ok(html.includes("Não há mensagens na fila"));
});

test("fila com itens nunca mostra o corpo da mensagem (item 26) — só empresa/status/data/tentativas", () => {
  const html = htmlComunicacaoFila({
    itens: [{ id: "m1", organizacao_id: "org-1", status: "SCHEDULED", disponivel_em: "2026-01-01T12:00:00Z", tentativas: 0, max_tentativas: 5, tipo: "dashboard_ifood_d1" }],
    total: 1, pagina: 1, porPagina: 20,
  }, [{ organizacaoId: "org-1", nome: "Grupo Saci" }]);
  assert.ok(html.includes("Grupo Saci"));
  assert.ok(html.includes("Agendada"));
  assert.ok(!html.includes("conteudo"));
});

test("histórico vazio explica que aparece só depois de um piloto (item 30)", () => {
  const html = htmlComunicacaoHistorico({ itens: [], total: 0, pagina: 1, porPagina: 20 }, []);
  assert.ok(html.includes("Nenhum envio registrado"));
});

test("paginação aparece só quando há mais de uma página", () => {
  const semPaginacao = htmlComunicacaoFila({ itens: [{ id: "m1", organizacao_id: "o", status: "SCHEDULED", disponivel_em: "2026-01-01T00:00:00Z", tentativas: 0, max_tentativas: 5 }], total: 1, pagina: 1, porPagina: 20 }, []);
  assert.ok(!semPaginacao.includes("padm-paginacao"));
  const comPaginacao = htmlComunicacaoFila({ itens: [{ id: "m1", organizacao_id: "o", status: "SCHEDULED", disponivel_em: "2026-01-01T00:00:00Z", tentativas: 0, max_tentativas: 5 }], total: 50, pagina: 2, porPagina: 20 }, []);
  assert.ok(comPaginacao.includes("padm-paginacao"));
  assert.ok(comPaginacao.includes("Página 2 de 3"));
});
