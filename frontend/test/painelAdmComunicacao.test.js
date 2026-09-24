// Checkpoint H.3-A — construtores puros da área Comunicação/WhatsApp do
// Painel Administrativo. Mesmo estilo de desenvolvimento.test.js: só
// funções HTML->string, sem DOM (não há jsdom neste projeto).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  htmlComunicacaoCards, htmlComunicacaoEmpresas, htmlComunicacaoFila, htmlComunicacaoHistorico,
  htmlSeletorPerfil, htmlDrawerComunicacao, htmlChecklistPiloto, TELAS_PADM,
} from "../src/painelAdmViews.js";

test("a aba Comunicação existe na navegação do Painel Administrativo", () => {
  const tela = TELAS_PADM.find((t) => t.id === "comunicacao");
  assert.ok(tela, "esperava uma tela 'comunicacao' em TELAS_PADM");
  assert.equal(tela.label, "Comunicação");
});

test("Central: os 5 cards de saúde (Automação, Gateway WhatsApp, Worker, Piloto, Organizações) sem vocabulário de engenharia", () => {
  const html = htmlComunicacaoCards({
    gateway: { estado: "conectado" }, worker: { estado: "habilitado", rodandoNestaInstancia: true, ultimoCicloEm: "2026-09-23T20:00:00Z", resultadoUltimoCiclo: "skipped" }, comunicacao: { modo: "DISABLED" },
    piloto: { ativo: true, quantidadeDestinos: 1 }, empresas: { total: 48, configuradas: 0, habilitadas: 0, pausadas: 0 },
  });
  for (const rotulo of ["Automação", "Desativada", "Gateway WhatsApp", "Conectado", "Worker", "Saudável", "Piloto", "Ativo — 1 destino autorizado", "Organizações", "0 habilitadas"]) {
    assert.ok(html.includes(rotulo), rotulo);
  }
  assert.ok(!/DISABLED|CONNECTED|offline_batch|marker|auth-state|lease|HMAC|token/i.test(html), "vocabulário de engenharia nunca pode vazar pra UI");
});

test("Central: o card do Worker só diz 'Saudável' com EVIDÊNCIA do último ciclo (rodando nesta instância + ciclo registrado); sem evidência = Atenção; falha = Atenção; flag desligada = Desativado", () => {
  const base = { gateway: { estado: "conectado" }, comunicacao: { modo: "DISABLED" }, piloto: { ativo: false, quantidadeDestinos: 0 }, empresas: { total: 1, habilitadas: 0 } };
  const semEvidencia = htmlComunicacaoCards({ ...base, worker: { estado: "habilitado" } });
  const comEvidencia = htmlComunicacaoCards({ ...base, worker: { estado: "habilitado", rodandoNestaInstancia: true, ultimoCicloEm: "2026-09-23T20:00:00Z", resultadoUltimoCiclo: "completed" } });
  const falhou = htmlComunicacaoCards({ ...base, worker: { estado: "habilitado", rodandoNestaInstancia: true, ultimoCicloEm: "2026-09-23T20:00:00Z", resultadoUltimoCiclo: "failed" } });
  const desligado = htmlComunicacaoCards({ ...base, worker: { estado: "desabilitado" } });
  assert.doesNotMatch(semEvidencia, /Saudável/); assert.match(semEvidencia, /Atenção/);
  assert.match(comEvidencia, /Saudável/);
  assert.doesNotMatch(falhou, /Saudável/); assert.match(falhou, /Atenção/);
  assert.match(desligado, /Desativado/); assert.doesNotMatch(desligado, /Saudável/);
  assert.match(semEvidencia, /Piloto/); assert.match(semEvidencia, /Inativo/);
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

test("empty state: nenhuma organização não parece um erro (item 30)", () => {
  const html = htmlComunicacaoEmpresas([], "");
  assert.ok(html.includes("Nenhuma empresa encontrada"));
  assert.ok(!/erro|falha|exception/i.test(html));
});

test("lista de empresas nunca imprime telefone completo (item 14) — só o que a service já manda mascarado", () => {
  const html = htmlComunicacaoEmpresas([
    { organizacaoId: "org-1", nome: "Grupo Saci", status: "PRONTA_PARA_PILOTO", habilitada: false, unidadesMonitoradas: 6, unidades: [{ unidadeId: "u1", nome: "Subway Saci — Matriz" }],
      contato: { telefoneMascarado: "********88", consentimento: true, verificado: true, optOut: false }, pendenciasAtuais: 2,
      ultimaMensagem: { status: "SENT", em: "2026-09-23T19:22:46Z" }, proximaAcao: "Habilitar a comunicação desta empresa" },
  ], "");
  assert.ok(html.includes("Grupo Saci"));
  assert.ok(html.includes("Desabilitada"));
  assert.ok(html.includes("********88"));
  for (const rotulo of ["Confirmado", "Verificado", "Enviado ao provedor", "Habilitar a comunicação desta empresa", "Ver detalhes", "6 unidades monitoradas"]) assert.ok(html.includes(rotulo), rotulo);
  assert.doesNotMatch(html, /\+55\d+/, "a linha da tabela nunca deve montar um telefone E.164 completo");
  assert.doesNotMatch(html, />Entregue</, "SENT nunca aparece como Entregue");
});

test("busca filtra por nome de empresa OU de unidade, sem acento/caixa, e nunca por telefone (item 29)", () => {
  const orgs = [
    { organizacaoId: "1", nome: "Grupo Saci", habilitada: false, contato: { telefoneMascarado: "********88", consentimento: true, verificado: true, optOut: false }, unidades: [{ unidadeId: "u1", nome: "Subway Saci — Matriz" }], pendenciasAtuais: 0 },
    { organizacaoId: "2", nome: "Outra Empresa", habilitada: false, contato: null, unidades: [{ unidadeId: "u2", nome: "Filial Centro" }], pendenciasAtuais: 0 },
  ];
  const porNome = htmlComunicacaoEmpresas(orgs, "SACI");
  assert.ok(porNome.includes("Grupo Saci")); assert.ok(!porNome.includes("Outra Empresa"));
  const porUnidade = htmlComunicacaoEmpresas(orgs, "filial");
  assert.ok(porUnidade.includes("Outra Empresa")); assert.ok(!porUnidade.includes("Grupo Saci"));
  assert.ok(htmlComunicacaoEmpresas(orgs, "88").includes("Nenhuma empresa encontrada para"), "telefone não é chave de busca");
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

test("histórico vazio explica o que fazer, sem parecer erro (item 30)", () => {
  const html = htmlComunicacaoHistorico({ itens: [], total: 0, pagina: 1, porPagina: 20 }, []);
  assert.ok(html.includes("Nenhuma mensagem encontrada"));
  assert.ok(!/erro|falha|exception/i.test(html));
});

test("paginação aparece só quando há mais de uma página", () => {
  const semPaginacao = htmlComunicacaoFila({ itens: [{ id: "m1", organizacao_id: "o", status: "SCHEDULED", disponivel_em: "2026-01-01T00:00:00Z", tentativas: 0, max_tentativas: 5 }], total: 1, pagina: 1, porPagina: 20 }, []);
  assert.ok(!semPaginacao.includes("padm-paginacao"));
  const comPaginacao = htmlComunicacaoFila({ itens: [{ id: "m1", organizacao_id: "o", status: "SCHEDULED", disponivel_em: "2026-01-01T00:00:00Z", tentativas: 0, max_tentativas: 5 }], total: 50, pagina: 2, porPagina: 20 }, []);
  assert.ok(comPaginacao.includes("padm-paginacao"));
  assert.ok(comPaginacao.includes("Página 2 de 3"));
});

test("H.4-A itens 34-36: checklist do piloto mostra os 9 itens, com estado textual além de ícone/cor", () => {
  const tudoPendente = htmlChecklistPiloto({
    perfilAssociado: false, telefoneValido: false, consentimento: false, telefoneVerificado: false,
    timezone: false, tipoAlerta: false, allowlistPiloto: false, organizacaoHabilitada: false, comunicacaoGlobalAtiva: false,
  });
  for (const rotulo of ["Perfil associado", "Telefone válido", "Consentimento", "Telefone verificado", "Timezone", "Tipo de alerta", "Allowlist do piloto", "Organização habilitada", "Comunicação global ativa"]) {
    assert.ok(tudoPendente.includes(rotulo), `esperava "${rotulo}" no checklist`);
  }
  assert.equal((tudoPendente.match(/\(pendente\)/g) ?? []).length, 9);
  assert.ok(!tudoPendente.includes("(pronto)"));

  const parcial = htmlChecklistPiloto({
    perfilAssociado: true, telefoneValido: true, consentimento: false, telefoneVerificado: false,
    timezone: true, tipoAlerta: true, allowlistPiloto: true, organizacaoHabilitada: false, comunicacaoGlobalAtiva: false,
  });
  assert.equal((parcial.match(/\(pronto\)/g) ?? []).length, 5);
  assert.equal((parcial.match(/\(pendente\)/g) ?? []).length, 4);
});

test("H.4-A itens 34-36: organização/comunicação global SEMPRE aparecem pendentes nesta fase", () => {
  const c = htmlChecklistPiloto({
    perfilAssociado: true, telefoneValido: true, consentimento: true, telefoneVerificado: true,
    timezone: true, tipoAlerta: true, allowlistPiloto: true, organizacaoHabilitada: false, comunicacaoGlobalAtiva: false,
  });
  const linhaOrg = c.split("<li").find((l) => l.includes("Organização habilitada"));
  const linhaModo = c.split("<li").find((l) => l.includes("Comunicação global ativa"));
  assert.ok(linhaOrg.includes("padm-check-pendente"));
  assert.ok(linhaModo.includes("padm-check-pendente"));
});

test("H.4-A itens 15-18: o drawer traz o botão de pré-visualização (nunca 'Enviar agora'/'Testar mensagem')", () => {
  const detalhe = {
    organizacao: { organizacaoId: "org-1", nome: "Grupo Jailton e Vanessa" },
    configuracao: { status: "CONFIGURACAO_INCOMPLETA", timezone: null, tiposPermitidos: [], pausadoAte: null, destinatario: null },
    checklistPiloto: {
      perfilAssociado: false, telefoneValido: false, consentimento: false, telefoneVerificado: false,
      timezone: false, tipoAlerta: false, allowlistPiloto: true, organizacaoHabilitada: false, comunicacaoGlobalAtiva: false,
    },
    unidades: [],
  };
  const html = htmlDrawerComunicacao(detalhe, []);
  assert.ok(html.includes('data-padm-acao="preview-comunicacao"'));
  assert.ok(html.includes("Pré-visualizar mensagem"));
  assert.doesNotMatch(html, /Enviar agora|Testar mensagem|Disparar|Reenviar|Enviar mensagem/i);
});

function detalheComDestinatario(destinatario) {
  return {
    organizacao: { organizacaoId: "org-1", nome: "Grupo Jailton e Vanessa" },
    configuracao: { status: "CONFIGURACAO_INCOMPLETA", timezone: "America/Sao_Paulo", tiposPermitidos: ["dashboard_ifood_d1"], pausadoAte: null, destinatario },
    checklistPiloto: {
      perfilAssociado: true, telefoneValido: true, consentimento: destinatario?.consentimento ?? false, telefoneVerificado: destinatario?.verificado ?? false,
      timezone: true, tipoAlerta: true, allowlistPiloto: true, organizacaoHabilitada: false, comunicacaoGlobalAtiva: false,
    },
    unidades: [],
  };
}

// Checkpoint H.4-A.3.2, item 11 (A, B, C, F) — cobertura da ação de consentimento
// no drawer. D, E, G, H, I (comportamento de clique/chamada de API) não são
// testáveis neste arquivo: painelAdmComunicacao.test.js só testa construtores
// HTML->string (sem DOM/jsdom neste projeto, mesmo padrão dos testes acima) —
// esse comportamento foi validado por QA manual em produção (H.4-A.3.2, item 16).

test("A. consentimento=false -> botão de confirmação aparece", () => {
  const html = htmlDrawerComunicacao(detalheComDestinatario({
    telefoneMascarado: "+558********88", verificado: true, consentimento: false, optOut: false, perfilOperacionalId: "p1",
  }), []);
  assert.ok(html.includes('data-padm-acao="pedir-confirmacao-consentimento"'));
  assert.ok(html.includes("Confirmar consentimento e verificação"));
});

test("B. verificado=false -> botão de confirmação aparece", () => {
  const html = htmlDrawerComunicacao(detalheComDestinatario({
    telefoneMascarado: "+558********88", verificado: false, consentimento: true, optOut: false, perfilOperacionalId: "p1",
  }), []);
  assert.ok(html.includes('data-padm-acao="pedir-confirmacao-consentimento"'));
});

test("C. consentimento=true e verificado=true -> mostra 'Consentimento confirmado', sem botão", () => {
  const html = htmlDrawerComunicacao(detalheComDestinatario({
    telefoneMascarado: "+558********88", verificado: true, consentimento: true, optOut: false, perfilOperacionalId: "p1",
  }), []);
  assert.ok(html.includes("Consentimento confirmado"));
  assert.doesNotMatch(html, /pedir-confirmacao-consentimento/);
});

test("sem perfil associado -> nenhum botão/estado de consentimento aparece (contato incompleto)", () => {
  const html = htmlDrawerComunicacao(detalheComDestinatario({
    telefoneMascarado: "+558********88", verificado: false, consentimento: false, optOut: false, perfilOperacionalId: null,
  }), []);
  assert.doesNotMatch(html, /pedir-confirmacao-consentimento|Consentimento confirmado/);
});

test("F. o painel de confirmação traz o texto exato, nenhum checkbox, e nunca é exibido pré-aberto", () => {
  const html = htmlDrawerComunicacao(detalheComDestinatario({
    telefoneMascarado: "+558********88", verificado: false, consentimento: false, optOut: false, perfilOperacionalId: "p1",
  }), []);
  assert.match(html, /class="padm-consentimento-confirmar" hidden/);
  assert.ok(html.includes("Confirme somente se o destinatário autorizou o recebimento de alertas operacionais do Crescer com Delivery por WhatsApp e se este número foi validado administrativamente."));
  assert.ok(html.includes('data-padm-acao="cancelar-confirmacao-consentimento"'));
  assert.ok(html.includes("Cancelar"));
  const blocoConfirmar = html.slice(html.indexOf("padm-consentimento-confirmar"));
  assert.doesNotMatch(blocoConfirmar.slice(0, blocoConfirmar.indexOf("</div>")), /type="checkbox"/);
});

test("a ação de consentimento nunca é confundida com envio/habilitação (vocabulário)", () => {
  const html = htmlDrawerComunicacao(detalheComDestinatario({
    telefoneMascarado: "+558********88", verificado: false, consentimento: false, optOut: false, perfilOperacionalId: "p1",
  }), []);
  assert.doesNotMatch(html, /Enviar|Habilitar organização|Ativar comunicação|Agente Crescer/i);
});
