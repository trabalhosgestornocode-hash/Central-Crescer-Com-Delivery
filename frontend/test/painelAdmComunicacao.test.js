// Checkpoint H.3-A — construtores puros da área Comunicação/WhatsApp do
// Painel Administrativo. Mesmo estilo de desenvolvimento.test.js: só
// funções HTML->string, sem DOM (não há jsdom neste projeto).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  htmlComunicacaoCards, htmlComunicacaoEmpresas, htmlComunicacaoFila, htmlComunicacaoHistorico,
  htmlDrawerComunicacao, htmlChecklistPiloto, htmlComunicacaoConfiguracoes, htmlResumoEmpresas, TELAS_PADM,
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

test("migration 100: o drawer NÃO tem seletor de perfil/usuário — o responsável é cadastrado por nome + telefone da empresa", () => {
  const detalhe = {
    organizacao: { organizacaoId: "org-1", nome: "Grupo Jailton e Vanessa" },
    configuracao: {
      status: "CONFIGURACAO_INCOMPLETA", timezone: null, tiposPermitidos: [], pausadoAte: null,
      destinatario: { contatoEmpresaId: "ce1", nome: "Jailton Matos", ativo: true, telefoneMascarado: "+55 ** *****-1234", whatsappStatus: "AGUARDANDO_VALIDACAO", verificado: false, consentimento: false, optOut: false },
    },
    unidades: [],
  };
  const html = htmlDrawerComunicacao(detalhe);
  assert.doesNotMatch(html, /<select|perfilOperacionalId|Destinatário \(perfil/);
  assert.ok(html.includes("Responsável pelas comunicações"));
  for (const campo of ['name="nome"', 'name="ddi"', 'name="telefone"', 'name="ativo"', 'name="observacoes"']) assert.ok(html.includes(campo), campo);
  assert.ok(html.includes("Jailton Matos"));
  assert.ok(html.includes("Aguardando validação"));
  assert.ok(html.includes("Ativo para receber avisos"));
  assert.doesNotMatch(html, /name="telefoneE164"/, "o formulário de configuração não pede mais telefone/perfil");
});

test("drawer sem responsável: empty state + campos de cadastro (telefone obrigatório), sem nenhum nome herdado de acesso", () => {
  const html = htmlDrawerComunicacao({
    organizacao: { organizacaoId: "org-1", nome: "Subway Centro - Mogi Mirim - SP" },
    configuracao: { status: "NAO_CONFIGURADA", timezone: null, tiposPermitidos: [], pausadoAte: null, destinatario: null },
    unidades: [],
  });
  assert.ok(html.includes("Nenhum responsável cadastrado."));
  assert.match(html, /name="telefone"[^>]*required/);
  assert.doesNotMatch(html, /Jailton/);
});

test("empty state: nenhuma organização não parece um erro (item 30)", () => {
  const html = htmlComunicacaoEmpresas([], "");
  assert.ok(html.includes("Nenhuma empresa encontrada"));
  assert.ok(!/erro|falha|exception/i.test(html));
});

test("lista de empresas nunca imprime telefone completo (item 14) — só o que a service já manda mascarado", () => {
  const html = htmlComunicacaoEmpresas([
    { organizacaoId: "org-1", nome: "Grupo Saci", status: "PRONTA_PARA_PILOTO", habilitada: false, whatsappStatus: "NAO_CADASTRADO", responsavel: null, unidadesMonitoradas: 6, unidades: [{ unidadeId: "u1", nome: "Subway Saci — Matriz" }],
      contato: { telefoneMascarado: "********88", consentimento: true, verificado: true, optOut: false }, pendenciasAtuais: 2,
      ultimaMensagem: { status: "SENT", em: "2026-09-23T19:22:46Z" }, proximaAcao: "Habilitar a comunicação desta empresa" },
  ], "");
  assert.ok(html.includes("Grupo Saci"));
  assert.ok(html.includes("Desabilitada"));
  assert.ok(html.includes("********88"));
  for (const rotulo of ["Confirmado", "Verificado", "Enviado ao provedor", "Habilitar a comunicação desta empresa", "Gerenciar", "6 unidades monitoradas", "Sem responsável", "Não cadastrado"]) assert.ok(html.includes(rotulo), rotulo);
  assert.doesNotMatch(html, /\+55\d+/, "a linha da tabela nunca deve montar um telefone E.164 completo");
  assert.doesNotMatch(html, />Entregue</, "SENT nunca aparece como Entregue");
});

test("aba Empresas: UMA linha por empresa, com unidades, responsável, status do número, filtros, resumo e as ações; a busca/filtro são do SERVIDOR", () => {
  const orgs = [
    { organizacaoId: "g", nome: "Grupo Jailton e Vanessa", habilitada: true, unidadesMonitoradas: 6, unidades: [], status: "HABILITADA", whatsappStatus: "AGUARDANDO_VALIDACAO", pendenciasAtuais: 0,
      responsavel: { id: "ce1", nome: "Jailton Matos", tipo: "principal", ativo: true, telefoneMascarado: "+55 ** *****-6788" }, proximaAcao: "Validar" },
    { organizacaoId: "m", nome: "Subway Centro - Mogi Mirim - SP", habilitada: false, unidadesMonitoradas: 1, unidades: [], status: "NAO_CONFIGURADA", whatsappStatus: "NAO_CADASTRADO", pendenciasAtuais: 0, responsavel: null, proximaAcao: "Cadastrar o responsável pelas comunicações" },
  ];
  const html = htmlComunicacaoEmpresas(orgs, "", "todos", { empresas: { total: 2, configuradas: 1, validados: 0, semResponsavel: 1 } });
  assert.equal((html.match(/data-padm-com-linha=/g) ?? []).length, 2);
  const linhaMogi = html.split("data-padm-com-linha=").find((l) => l.includes("Mogi Mirim"));
  assert.ok(linhaMogi.includes("Sem responsável"));
  assert.ok(linhaMogi.includes("Não cadastrado"));
  assert.doesNotMatch(linhaMogi, /Jailton/, "Jailton nunca aparece na linha de Mogi Mirim");
  assert.ok(linhaMogi.includes("Cadastrar responsável"));
  assert.doesNotMatch(linhaMogi, /Validar número|Desativar avisos/);
  const linhaGrupo = html.split("data-padm-com-linha=").find((l) => l.includes("Grupo Jailton e Vanessa"));
  assert.ok(linhaGrupo.includes("Jailton Matos"));
  assert.ok(linhaGrupo.includes("Aguardando validação"));
  assert.ok(linhaGrupo.includes("Habilitada"));
  for (const acao of ["Gerenciar", "Editar responsável", "Validar número", "Desativar avisos", "Ver histórico"]) assert.ok(linhaGrupo.includes(acao), acao);
  for (const rotulo of ["Empresas cadastradas", "Responsáveis configurados", "WhatsApps validados", "Empresas sem responsável"]) assert.ok(html.includes(rotulo), rotulo);
  for (const rotulo of ["Todos", "Configurados", "Sem responsável", "Aguardando validação", "Validados", "Comunicação desativada"]) assert.ok(html.includes(rotulo), rotulo);
  assert.ok(html.includes("Buscar por empresa, responsável ou telefone"));
  assert.doesNotMatch(html, /\+55\d{8,}/, "nunca telefone completo");
  // lista vazia POR FILTRO não parece erro nem some com os filtros
  const vazio = htmlComunicacaoEmpresas([], "xyz", "sem_responsavel");
  assert.ok(vazio.includes("Nenhuma empresa encontrada para este filtro/busca."));
  assert.ok(vazio.includes("Sem responsável"));
});

test("Configurações: horários de disponibilidade do iFood editáveis (nada fixo), com a explicação da regra", () => {
  const html = htmlComunicacaoConfiguracoes({ tiposDeAlerta: [], cooldownsHoras: {}, limites: {} }, { dadosDisponiveisApos: "10:00", enviosPermitidosApos: "10:30" });
  assert.match(html, /name="dadosDisponiveisApos"[^>]*value="10:00"/);
  assert.match(html, /name="enviosPermitidosApos"[^>]*value="10:30"/);
  assert.ok(html.includes("Antes deste horário, empresas não serão cobradas pelo preenchimento dos dados referentes ao dia anterior."));
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
    responsavelDefinido: false, telefoneValido: false, consentimento: false, telefoneVerificado: false,
    timezone: false, tipoAlerta: false, allowlistPiloto: false, organizacaoHabilitada: false, comunicacaoGlobalAtiva: false,
  });
  for (const rotulo of ["Responsável definido", "Telefone válido", "Consentimento", "WhatsApp validado", "Timezone", "Tipo de alerta", "Allowlist do piloto", "Organização habilitada", "Comunicação global ativa"]) {
    assert.ok(tudoPendente.includes(rotulo), `esperava "${rotulo}" no checklist`);
  }
  assert.equal((tudoPendente.match(/\(pendente\)/g) ?? []).length, 9);
  assert.ok(!tudoPendente.includes("(pronto)"));

  const parcial = htmlChecklistPiloto({
    responsavelDefinido: true, telefoneValido: true, consentimento: false, telefoneVerificado: false,
    timezone: true, tipoAlerta: true, allowlistPiloto: true, organizacaoHabilitada: false, comunicacaoGlobalAtiva: false,
  });
  assert.equal((parcial.match(/\(pronto\)/g) ?? []).length, 5);
  assert.equal((parcial.match(/\(pendente\)/g) ?? []).length, 4);
});

test("H.4-A itens 34-36: organização/comunicação global SEMPRE aparecem pendentes nesta fase", () => {
  const c = htmlChecklistPiloto({
    responsavelDefinido: true, telefoneValido: true, consentimento: true, telefoneVerificado: true,
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
      responsavelDefinido: false, telefoneValido: false, consentimento: false, telefoneVerificado: false,
      timezone: false, tipoAlerta: false, allowlistPiloto: true, organizacaoHabilitada: false, comunicacaoGlobalAtiva: false,
    },
    unidades: [],
  };
  const html = htmlDrawerComunicacao(detalhe);
  assert.ok(html.includes('data-padm-acao="preview-comunicacao"'));
  assert.ok(html.includes("Pré-visualizar mensagem"));
  assert.doesNotMatch(html, /Enviar agora|Testar mensagem|Disparar|Reenviar|Enviar mensagem/i);
});

function detalheComDestinatario(destinatario) {
  return {
    organizacao: { organizacaoId: "org-1", nome: "Grupo Jailton e Vanessa" },
    configuracao: { status: "CONFIGURACAO_INCOMPLETA", timezone: "America/Sao_Paulo", tiposPermitidos: ["dashboard_ifood_d1"], pausadoAte: null, destinatario },
    checklistPiloto: {
      responsavelDefinido: true, telefoneValido: true, consentimento: destinatario?.consentimento ?? false, telefoneVerificado: destinatario?.verificado ?? false,
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
    telefoneMascarado: "+558********88", verificado: true, consentimento: false, optOut: false, contatoEmpresaId: "ce1", ativo: true, nome: "Jailton Matos", whatsappStatus: "AGUARDANDO_VALIDACAO",
  }));
  assert.ok(html.includes('data-padm-acao="pedir-confirmacao-consentimento"'));
  assert.ok(html.includes("Confirmar consentimento e verificação"));
});

test("B. verificado=false -> botão de confirmação aparece", () => {
  const html = htmlDrawerComunicacao(detalheComDestinatario({
    telefoneMascarado: "+558********88", verificado: false, consentimento: true, optOut: false, contatoEmpresaId: "ce1", ativo: true, nome: "Jailton Matos", whatsappStatus: "AGUARDANDO_VALIDACAO",
  }));
  assert.ok(html.includes('data-padm-acao="pedir-confirmacao-consentimento"'));
});

test("C. consentimento=true e verificado=true -> mostra 'Consentimento confirmado', sem botão", () => {
  const html = htmlDrawerComunicacao(detalheComDestinatario({
    telefoneMascarado: "+558********88", verificado: true, consentimento: true, optOut: false, contatoEmpresaId: "ce1", ativo: true, nome: "Jailton Matos", whatsappStatus: "VALIDADO",
  }));
  assert.ok(html.includes("Consentimento confirmado"));
  assert.doesNotMatch(html, /pedir-confirmacao-consentimento/);
});

test("sem perfil associado -> nenhum botão/estado de consentimento aparece (contato incompleto)", () => {
  const html = htmlDrawerComunicacao(detalheComDestinatario({
    telefoneMascarado: "+558********88", verificado: false, consentimento: false, optOut: false, contatoEmpresaId: null, ativo: true, nome: "Jailton Matos",
  }));
  assert.doesNotMatch(html, /pedir-confirmacao-consentimento|Consentimento confirmado/);
});

test("F. o painel de confirmação traz o texto exato, nenhum checkbox, e nunca é exibido pré-aberto", () => {
  const html = htmlDrawerComunicacao(detalheComDestinatario({
    telefoneMascarado: "+558********88", verificado: false, consentimento: false, optOut: false, contatoEmpresaId: "ce1", ativo: true, nome: "Jailton Matos", whatsappStatus: "AGUARDANDO_VALIDACAO",
  }));
  assert.match(html, /class="padm-consentimento-confirmar" hidden/);
  assert.ok(html.includes("Confirme somente se o destinatário autorizou o recebimento de alertas operacionais do Crescer com Delivery por WhatsApp e se este número foi validado administrativamente."));
  assert.ok(html.includes('data-padm-acao="cancelar-confirmacao-consentimento"'));
  assert.ok(html.includes("Cancelar"));
  const blocoConfirmar = html.slice(html.indexOf("padm-consentimento-confirmar"));
  assert.doesNotMatch(blocoConfirmar.slice(0, blocoConfirmar.indexOf("</div>")), /type="checkbox"/);
});

test("a ação de consentimento nunca é confundida com envio/habilitação (vocabulário)", () => {
  const html = htmlDrawerComunicacao(detalheComDestinatario({
    telefoneMascarado: "+558********88", verificado: false, consentimento: false, optOut: false, contatoEmpresaId: "ce1", ativo: true, nome: "Jailton Matos", whatsappStatus: "AGUARDANDO_VALIDACAO",
  }));
  assert.doesNotMatch(html, /Enviar|Habilitar organização|Ativar comunicação|Agente Crescer/i);
});
