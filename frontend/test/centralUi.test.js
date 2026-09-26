// Central de Comunicação — construtores de HTML (puros). Garantias: escape de todo texto, telefone SEMPRE mascarado, foto só https com fallback nas iniciais, voz de cada
// mensagem legível pela classe, SENT ≠ DELIVERED na trilha, composer com o texto pedido e bloqueios explicados, nenhum handler inline (a CSP bloqueia).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  avatar, trilha, htmlPillsEstado, htmlTopo, htmlItemConversa, htmlListaConversas, htmlFiltros, htmlChatCabecalho, htmlMensagem, htmlFluxo, htmlComposer, htmlChatVazio,
  htmlContexto, htmlMenu, htmlAutomacoes, htmlHistorico, htmlDestinatarios, htmlConfiguracoes, htmlDiagnostico, htmlEspacoConversas, htmlCasca, vazio, erroCentral,
  skeletonLista, skeletonChat, skeletonPainel, chipsUnidades,
} from "../src/central/centralUi.js";

import { htmlVisaoGeral } from "../src/central/centralVisao.js";

const AGORA = new Date(2026, 8, 24, 15, 0, 0);
const iso = (min) => new Date(AGORA.getTime() - min * 60_000).toISOString();
const XSS = `<img src=x onerror=alert(1)>"'&`;

const contato = (o = {}) => ({
  contatoId: "c1", nome: "Maria Souza", iniciais: "MS", fotoUrl: null, cargo: "Administrador da empresa", telefoneMascarado: "********01",
  empresas: [{ organizacaoId: "o1", nome: "Rede Sabor", pendenciasAtuais: 2 }], unidades: [{ unidadeId: "u1", nome: "Centro", organizacaoId: "o1" }, { unidadeId: "u2", nome: "Praia", organizacaoId: "o1" }],
  consentimento: true, verificado: true, optOut: false, pendenciasAtuais: 2, naoLidas: 0, ultimaMensagem: null, ...o,
});
const msg = (o = {}) => ({ id: "m1", direcao: "saida", categoria: "manual", tipo: "texto", texto: "Bom dia", status: "SENT", em: iso(5), operador: "Camila", ...o });

describe("segurança de saída", () => {
  test("todo texto de dados é ESCAPADO (nome, empresa, unidade, mensagem, operador, erro)", () => {
    const html = [
      htmlItemConversa(contato({ nome: XSS, empresas: [{ organizacaoId: "o", nome: XSS, pendenciasAtuais: 0 }], unidades: [{ unidadeId: "u", nome: XSS, organizacaoId: "o" }], ultimaMensagem: { direcao: "entrada", previa: XSS, em: iso(1), status: null } }), { agora: AGORA }),
      htmlMensagem(msg({ texto: XSS, operador: XSS, erro: XSS, status: "FAILED", falhaLocal: true, envioId: "E" })), htmlFluxo({ mensagens: [msg({ texto: XSS, operador: XSS })], agora: AGORA }),
      htmlContexto(contato({ nome: XSS, cargo: XSS, ultimaHumana: { em: iso(2), direcao: "entrada", previa: XSS, operador: XSS } })), htmlChatCabecalho(contato({ nome: XSS }), { podeEnviar: true }),
      htmlComposer({ texto: XSS }),
    ].join("\n");
    assert.ok(!/<img src=x|<script/i.test(html), "nenhuma tag injetada (o texto 'onerror=' escapado é inofensivo)");
    assert.ok(html.includes("&lt;img src=x"), "aparece como texto escapado");
  });

  test("NENHUM handler inline nem javascript: em nenhum construtor (a CSP bloquearia e seria um vetor)", () => {
    const pacote = { itens: [{ id: "h1", contatoId: "c1", direcao: "saida", categoria: "manual", origem: "manual_painel", em: iso(3), responsavel: "M", empresas: ["E"], unidades: ["U"], previa: "p", status: "SENT", entregueEm: null, lidoEm: null, operador: "C" }], total: 1, pagina: 1, porPagina: 25 };
    const html = [
      htmlTopo({ aba: "conversas", estado: { gateway: "conectado", modo: "NORMAL" }, naoLidas: 3 }), htmlListaConversas({ itens: [contato()], totais: {}, filtro: "todas", busca: "", agora: AGORA }),
      htmlChatCabecalho(contato(), { podeEnviar: false, bloqueios: [{ codigo: "GATEWAY_INDISPONIVEL", mensagem: "x" }] }), htmlFluxo({ mensagens: [msg(), msg({ id: "m2", direcao: "entrada", categoria: "recebida" })], agora: AGORA }),
      htmlComposer({ podeEnviar: false, bloqueios: [{ codigo: "GATEWAY_INDISPONIVEL", mensagem: "fora" }] }), htmlContexto(contato()), htmlMenu([{ id: "a", rotulo: "A", icone: "copy" }]), htmlHistorico(pacote, {}, {}, { agora: AGORA }),
      htmlEspacoConversas({}), erroCentral("x"), vazio({ titulo: "t" }), skeletonLista(), skeletonChat(), skeletonPainel(),
    ].join("\n");
    assert.ok(!/\son[a-z]+\s*=|javascript:|<script/i.test(html));
  });

  test("telefone completo NUNCA aparece: só o mascarado, em todas as telas com contato", () => {
    const c = contato();
    const html = [
      htmlItemConversa(c, { agora: AGORA }), htmlChatCabecalho(c, { podeEnviar: true }), htmlContexto(c),
      htmlDestinatarios({ total: 1, itens: [{ contatoId: "c1", nome: "M", iniciais: "M", fotoUrl: null, cargo: null, telefoneMascarado: "********01", empresas: [{ organizacaoId: "o", nome: "E", habilitada: true }], unidades: [], consentimento: true, verificado: true, optOut: false, whatsappConfirmado: true, comunicacaoHabilitada: true, ultimaInteracaoEm: iso(1), naoLidas: 0 }] }, { agora: AGORA }),
    ].join("\n");
    assert.ok(!/\d{8,}/.test(html.replace(/\*{8}\d{2}/g, "")), "nenhuma sequência longa de dígitos");
    assert.match(html, /\*{8}01/);
  });
});

describe("avatar e foto", () => {
  test("sem foto: só as iniciais; com https: <img> com no-referrer e marcador para o fallback; http/javascript/data ⇒ ignorado", () => {
    assert.ok(!avatar({ contatoId: "c", nome: "M", iniciais: "M", fotoUrl: null }).includes("<img"));
    const com = avatar({ contatoId: "c", nome: "M", iniciais: "M", fotoUrl: "https://pps.whatsapp.net/x.jpg?a=1&b=2" });
    assert.match(com, /<img class="cc-avatar-img" src="https:\/\/pps\.whatsapp\.net\/x\.jpg\?a=1&amp;b=2"/);
    assert.match(com, /referrerpolicy="no-referrer"/); assert.match(com, /data-cc-foto/); assert.match(com, />M<\/span>/, "as iniciais ficam por baixo");
    for (const u of ["http://x/y.jpg", "javascript:alert(1)", "data:image/png;base64,AAA", "//x/y", "", 5]) assert.ok(!avatar({ contatoId: "c", nome: "M", iniciais: "M", fotoUrl: u }).includes("<img"), String(u));
  });
});

describe("trilha e bolhas", () => {
  test("a trilha tem 3 marcas com tooltip e rótulo acessível; SENT não acende a 2ª", () => {
    const t = trilha("SENT");
    assert.equal((t.match(/cc-marca /g) ?? []).length, 3);
    assert.equal((t.match(/cc-marca--feito/g) ?? []).length, 1);
    assert.match(t, /aria-label="Enviada ao WhatsApp\./); assert.match(t, /data-dica=/);
    assert.equal((trilha("DELIVERED").match(/cc-marca--feito/g) ?? []).length, 2);
    assert.equal((trilha("READ").match(/cc-marca--feito/g) ?? []).length, 3);
  });
  test("estados de atenção mostram o rótulo por extenso ao lado; os felizes não", () => {
    assert.match(trilha("FAILED", { texto: true }), /Falhou/); assert.match(trilha("DELIVERY_UNKNOWN", { texto: true }), /Entrega não confirmada/);
    assert.ok(!/cc-status-txt/.test(trilha("DELIVERED")));
  });
  test("cada voz tem a sua classe; recebida à esquerda e enviada à direita; operador só nas manuais", () => {
    const f = htmlFluxo({ mensagens: [msg({ id: "1", direcao: "entrada", categoria: "recebida", operador: null }), msg({ id: "2" }), msg({ id: "3", categoria: "automatica", operador: null }), msg({ id: "4", categoria: "teste", operador: null })], agora: AGORA });
    for (const c of ["cc-msg--recebida", "cc-msg--manual", "cc-msg--automatica", "cc-msg--teste", "cc-grupo--entrada", "cc-grupo--saida"]) assert.ok(f.includes(c), c);
    assert.match(f, /cc-operador">Camila/); assert.equal((f.match(/cc-operador/g) ?? []).length, 1);
    assert.match(f, />Equipe</); assert.match(f, />Automática</); assert.match(f, />Teste</);
  });
  test("separador de dia; mídia vira marcador (sem texto); janela e 'ver mais antigas'", () => {
    const f = htmlFluxo({ mensagens: [msg({ direcao: "entrada", categoria: "recebida", tipo: "midia", texto: null })], janelaHoras: 24, temMaisAntigas: true, agora: AGORA });
    assert.match(f, /cc-dia/); assert.match(f, /Mídia recebida/); assert.match(f, /data-cc-acao="mais-antigas"/);
    assert.match(htmlFluxo({ mensagens: [msg()], janelaHoras: 24, agora: AGORA }), /Mostrando as últimas 24 horas/);
  });
  test("'Tentar de novo' só aparece para falha LOCAL (com o envioId); falha do servidor mostra o erro sem reenvio", () => {
    assert.match(htmlMensagem(msg({ status: "FAILED", falhaLocal: true, envioId: "E9" })), /data-cc-reenviar="E9"/);
    const servidor = htmlMensagem(msg({ status: "FAILED", erro: "sem WhatsApp" }));
    assert.ok(!/cc-reenviar/.test(servidor)); assert.match(servidor, /sem WhatsApp/);
  });
  test("conversa vazia: convida a escrever e diz que só a atividade registrada aparece", () => {
    const f = htmlFluxo({ mensagens: [], janelaHoras: 24, agora: AGORA });
    assert.match(f, /Nenhuma mensagem nas últimas 24 horas/); assert.match(f, /Só a atividade registrada pelo sistema/);
  });
});

describe("lista de conversas", () => {
  test("item: não lida em destaque com contador; prévia; horário; unidades resumidas; pendência sinalizada", () => {
    const h = htmlItemConversa(contato({ naoLidas: 3, ultimaMensagem: { direcao: "entrada", categoria: "recebida", previa: "Já lancei!", em: iso(2), status: null } }), { agora: AGORA });
    assert.match(h, /is-nao-lida/); assert.match(h, /cc-contador[^>]*>3</); assert.match(h, /Já lancei!/); assert.match(h, /2 unidades/); assert.match(h, /cc-item-pend/);
    assert.match(h, /role="option"/); assert.match(htmlItemConversa(contato(), { compacto: true, agora: AGORA }), /role="listitem"/);
  });
  test("item com saída mostra a trilha do último envio; sem mensagens mostra o texto neutro", () => {
    assert.match(htmlItemConversa(contato({ ultimaMensagem: { direcao: "saida", categoria: "manual", previa: "oi", em: iso(3), status: "DELIVERED" } }), { agora: AGORA }), /cc-trilha/);
    assert.match(htmlItemConversa(contato(), { agora: AGORA }), /Sem mensagens recentes/);
  });
  test("filtros com contagem e o filtro ativo marcado", () => {
    const f = htmlFiltros({ filtro: "nao_lidas", totais: { todas: 5, naoLidas: 2, pendencias: 0, automacao: 1, humano: 3 } });
    assert.match(f, /data-cc-filtro="nao_lidas"[^>]*>|aria-selected="true" data-cc-filtro="nao_lidas"/);
    for (const r of ["Todas", "Não lidas", "Pendências", "Automação", "Atendimento humano"]) assert.ok(f.includes(r), r);
  });
  test("estados vazios: busca (diz que o telefone não é pesquisável), filtro e caixa vazia; carregando ⇒ skeleton", () => {
    assert.match(htmlListaConversas({ itens: [], totais: {}, filtro: "todas", busca: "xyz" }), /O telefone não é pesquisável/);
    assert.match(htmlListaConversas({ itens: [], totais: {}, filtro: "nao_lidas", busca: "" }), /Nada neste filtro/);
    assert.match(htmlListaConversas({ itens: [], totais: {}, filtro: "todas", busca: "" }), /Nenhuma conversa ainda/);
    assert.match(htmlListaConversas({ itens: [], totais: {}, filtro: "todas", busca: "", carregando: true }), /cc-skel-lista/);
  });
  test("a busca preserva o texto digitado (escapado) e diz o que pesquisa", () => {
    const h = htmlListaConversas({ itens: [], totais: {}, filtro: "todas", busca: `"><b>` });
    assert.ok(!h.includes('"><b>')); assert.match(h, /Buscar por nome, empresa ou unidade/);
  });
});

describe("composer", () => {
  test("placeholder EXATO, botão desabilitado sem texto, dica de teclado", () => {
    const c = htmlComposer({});
    assert.match(c, /placeholder="Digite uma mensagem\.\.\."/); assert.match(c, /data-cc-enviar disabled/); assert.match(c, /Enter envia\. Shift \+ Enter quebra a linha\./);
    assert.ok(!/data-cc-enviar disabled/.test(htmlComposer({ texto: "oi" })), "com texto o botão habilita");
  });
  test("bloqueado: campo desabilitado, motivos do servidor e link para Conexão SÓ quando o motivo é de conexão", () => {
    const porConexao = htmlComposer({ podeEnviar: false, bloqueios: [{ codigo: "GATEWAY_INDISPONIVEL", mensagem: "O WhatsApp não está conectado." }] });
    assert.match(porConexao, /data-cc-texto disabled/); assert.match(porConexao, /O WhatsApp não está conectado\./); assert.match(porConexao, /data-cc-ir="conexao"/);
    assert.match(htmlComposer({ podeEnviar: false, bloqueios: [{ codigo: "CONEXAO_NAO_CONFIRMADA", mensagem: "m" }] }), /data-cc-ir="conexao"/);
    assert.ok(!/data-cc-ir="conexao"/.test(htmlComposer({ podeEnviar: false, bloqueios: [{ codigo: "SEM_CONSENTIMENTO", mensagem: "sem" }] })));
  });
  test("enviando desabilita o botão; contador aparece perto do limite; erro do envio é exibido", () => {
    assert.match(htmlComposer({ texto: "oi", enviando: true }), /data-cc-enviar disabled/);
    assert.match(htmlComposer({ texto: "x".repeat(3500) }), /3500\/4096/); assert.ok(!/cc-contador-txt/.test(htmlComposer({ texto: "curto" })));
    assert.match(htmlComposer({ texto: "x".repeat(4100) }), /is-excedeu/);
    assert.match(htmlComposer({ erro: "Recusado" }), /role="alert">Recusado/);
  });
  test("sem conversa selecionada: estado vazio explicando que só os responsáveis cadastrados aparecem", () => {
    assert.match(htmlChatVazio(), /Só os responsáveis cadastrados nas empresas aparecem aqui/);
  });
});

describe("contexto do responsável", () => {
  test("mostra o que existe: cargo, empresas/unidades, consentimento, verificação, opt-out, pendências, últimas mensagens e ações", () => {
    const h = htmlContexto(contato({ ultimaAutomatica: { em: iso(60), previa: "Aviso D-1", status: "DELIVERED" }, ultimaHumana: { em: iso(5), direcao: "entrada", previa: "Ok", operador: null } }));
    for (const t of ["Administrador da empresa", "Rede Sabor", "Centro", "Consentimento", "Confirmado", "Número verificado", "Pediu para parar", "2 unidades com pendência", "Aviso D-1", "Ver empresa", "Ver pendências", "Ver histórico"]) assert.ok(h.includes(t), t);
    assert.match(h, /data-cc-org="o1"/);
  });
  test("NÃO inventa dados: sem cargo, sem mensagens e sem pendências ⇒ frases neutras e nenhum cargo", () => {
    const h = htmlContexto(contato({ cargo: null, pendenciasAtuais: 0, empresas: [{ organizacaoId: "o1", nome: "E", pendenciasAtuais: 0 }], ultimaAutomatica: null, ultimaHumana: null }));
    assert.match(h, /Nenhuma pendência agora\./); assert.match(h, /Nenhuma mensagem automática ainda\./); assert.match(h, /Nenhuma mensagem humana ainda\./); assert.ok(!/cc-ctx-cargo/.test(h));
    assert.match(htmlContexto(contato({ consentimento: false, verificado: false, optOut: true })), /Pendente[\s\S]*Não verificado[\s\S]*Sim, não enviar/);
  });
  test("chips de unidades resumem o excesso", () => {
    assert.match(chipsUnidades([1, 2, 3, 4, 5, 6].map((n) => ({ nome: `U${n}` })), 4), /\+2/);
  });
});

describe("topo, pílulas e menu", () => {
  test("pílulas: WhatsApp e automação; identidade da conta (nome operacional / ambiente / a confirmar) só com o WhatsApp conectado", () => {
    assert.match(htmlPillsEstado(null), /Verificando/);
    assert.match(htmlPillsEstado({ gateway: "desconectado", modo: "DISABLED" }), /WhatsApp desconectado[\s\S]*Automação desativada/);
    assert.match(htmlPillsEstado({ gateway: "conectado", modo: "NORMAL", identidade: { status: "CONFIRMADA", ambiente: "PRODUCAO", nomeOperacional: "Agente Crescer" } }), /Agente Crescer/);
    assert.match(htmlPillsEstado({ gateway: "conectado", modo: "NORMAL", identidade: { status: "CONFIRMADA", ambiente: "TESTE", nomeOperacional: null } }), /Ambiente de teste/);
    assert.match(htmlPillsEstado({ gateway: "conectado", modo: "NORMAL", identidade: { status: "PENDENTE_CONFIRMACAO", ambiente: "TESTE" } }), /Conta a confirmar/);
    assert.ok(!/Agente Crescer|Ambiente de teste/.test(htmlPillsEstado({ gateway: "desconectado", modo: "NORMAL", identidade: { status: "CONFIRMADA", ambiente: "TESTE", nomeOperacional: "Agente Crescer" } })));
  });
  test("as 7 abas com a ativa marcada e o badge de não lidas só na aba Conversas", () => {
    const t = htmlTopo({ aba: "conexao", estado: null, naoLidas: 120 });
    for (const r of ["Visão geral", "Conversas", "Automações", "Histórico", "Destinatários", "Conexão", "Configurações"]) assert.ok(t.includes(r), r);
    assert.match(t, /id="cc-aba-conexao" aria-selected="true"/); assert.match(t, /99\+/); assert.equal((t.match(/cc-badge/g) ?? []).length, 1);
  });
  test("menu contextual: itens com ícone e desabilitado", () => {
    const m = htmlMenu([{ id: "copiar", rotulo: "Copiar texto", icone: "copy" }, { id: "detalhes", rotulo: "Detalhes", icone: "info", desabilitado: true }]);
    assert.match(m, /role="menu"/); assert.match(m, /data-cc-menu-acao="copiar"/); assert.match(m, /data-cc-menu-acao="detalhes"\s+disabled/);
  });
});

describe("visão geral, automações, histórico, destinatários e configurações", () => {
  const visao = (o = {}) => ({
    cards: { whatsapp: { estado: "conectado", rotulo: "Conectado", conta: { status: "CONFIRMADA", confirmada: true, ambiente: "TESTE", nomeOperacional: null } }, automacao: { modo: "NORMAL", rotulo: "Ativa", ativa: true }, conversasNaoLidas: 2, mensagensHoje: { total: 10, enviadas: 6, recebidas: 4 }, entreguesHojePct: 80, falhasHoje: 0 },
    conversasRecentes: [], alertas: [], proximosEnvios: [], ...o,
  });
  test("indicadores com números do servidor; sem percentual usa recebidas; WhatsApp leva à Conexão", () => {
    const h = htmlVisaoGeral(visao({ cards: { ...visao().cards, entreguesHojePct: null } }), { agora: AGORA });
    assert.equal((h.match(/class="cc-kpi /g) ?? []).length, 5);
    for (const r of ["WhatsApp", "Automação", "Conversas não lidas", "Enviadas hoje", "Próximos envios", "Falhas"]) assert.ok(h.includes(r), r);
    assert.match(h, /4 recebidas/); assert.doesNotMatch(h, /% entregues/); assert.match(h, /Ambiente de teste/); assert.match(h, /data-cc-ir="conexao"/); assert.match(h, /Nenhuma/);
  });
  test("vazios: sem conversas, sem alertas ('Tudo em ordem') e sem envios agendados; alertas com destino", () => {
    const v = htmlVisaoGeral(visao(), { agora: AGORA });
    assert.match(v, /Nenhuma conversa ainda/); assert.match(v, /Tudo em ordem/); assert.match(v, /Nenhum envio programado/);
    const a = htmlVisaoGeral(visao({ alertas: [{ id: "g", severidade: "critico", titulo: "WhatsApp fora do ar", texto: "t", destino: { aba: "conexao" } }, { id: "f", severidade: "atencao", titulo: "1 falha", texto: "t", destino: { aba: "historico", status: "FAILED" } }] }), { agora: AGORA });
    assert.match(a, /cc-alerta-v2--critico/); assert.match(a, /data-cc-ir="conexao"/); assert.match(a, /data-cc-ir="historico:FAILED"/);
  });
  const auto = (o = {}) => ({ modo: "NORMAL", rotuloModo: "Ativa", ativa: true, whatsapp: { conectado: true }, dashboardIfoodD1: { titulo: "Dashboard iFood D-1", resumo: "r", quandoDetecta: "d", quandoEnvia: "e", quandoReforca: "f", horarioLimite: "22:30", linhaDoTempo: [{ id: "janela", titulo: "Janela", horario: "08:00", texto: "t" }, { id: "reforco", titulo: "Reforço", horario: "20:00", texto: "t" }, { id: "limite", titulo: "Limite", horario: "22:30", texto: "t" }] }, empresasHabilitadas: { total: 0, itens: [] }, proximosEnvios: [], ...o });
  test("automações: linha do tempo com os horários reais, regras e vazios explicativos", () => {
    const h = htmlAutomacoes(auto(), { agora: AGORA });
    for (const t of ["08:00", "20:00", "22:30", "Dashboard iFood D-1", "Nenhuma empresa habilitada", "Nenhum envio agendado"]) assert.ok(h.includes(t), t);
    assert.ok(!/WhatsApp desconectado/.test(h));
  });
  test("automações com o WhatsApp DESCONECTADO mostram o aviso e o caminho para a Conexão", () => {
    const h = htmlAutomacoes(auto({ whatsapp: { conectado: false } }), { agora: AGORA });
    assert.match(h, /WhatsApp desconectado/); assert.match(h, /data-cc-ir="conexao"/); assert.match(h, /histórico continuam preservados/);
  });
  test("histórico: colunas pedidas, origem, trilha, operador e ação; filtros; vazio e skeleton", () => {
    const pacote = { itens: [{ id: "h1", contatoId: "c1", direcao: "saida", categoria: "manual", origem: "manual_painel", em: iso(3), responsavel: "Maria", empresas: ["Rede"], unidades: ["Centro"], previa: "Bom dia", status: "DELIVERED", entregueEm: iso(2), lidoEm: null, operador: "Camila" }, { id: "h2", contatoId: "c1", direcao: "entrada", categoria: "recebida", origem: "contato", em: iso(1), responsavel: "Maria", empresas: ["Rede"], unidades: [], previa: "Ok", status: null, entregueEm: null, lidoEm: null, operador: null }], total: 2, pagina: 1, porPagina: 25 };
    const h = htmlHistorico(pacote, {}, { empresas: [], unidades: [] }, { agora: AGORA });
    for (const c of ["Data e hora", "Responsável", "Empresa", "Unidade", "Origem", "Mensagem", "Situação", "Entrega", "Leitura", "Operador", "Camila", "Abrir conversa", "Recebida"]) assert.ok(h.includes(c), c);
    assert.match(h, /data-cc-acao="detalhe-mensagem" data-cc-id="h1"/); assert.ok(!/data-cc-id="h2"[^>]*detalhe/.test(h.replace(/abrir-conversa/g, "")), "recebida não tem 'detalhes de envio'");
    assert.match(htmlHistorico(null, {}, {}), /cc-skel-tabela/); assert.match(htmlHistorico({ itens: [], total: 0, pagina: 1, porPagina: 25 }, {}, {}), /Nenhuma mensagem encontrada/);
  });
  test("destinatários: colunas, marcas de consentimento/verificação, interação registrada (entrada ou entrega), opt-out e abrir conversa", () => {
    const d = { total: 2, itens: [
      { contatoId: "c1", nome: "Maria", iniciais: "M", fotoUrl: null, cargo: "Gestor de unidade", telefoneMascarado: "********01", empresas: [{ organizacaoId: "o", nome: "Rede", habilitada: true }], unidades: [{ unidadeId: "u", nome: "Centro" }], consentimento: true, verificado: true, optOut: false, whatsappConfirmado: true, comunicacaoHabilitada: true, ultimaInteracaoEm: iso(5), naoLidas: 0 },
      { contatoId: "c2", nome: "João", iniciais: "J", fotoUrl: null, cargo: null, telefoneMascarado: "********02", empresas: [{ organizacaoId: "o", nome: "Rede", habilitada: false }], unidades: [], consentimento: false, verificado: false, optOut: true, whatsappConfirmado: false, comunicacaoHabilitada: false, ultimaInteracaoEm: null, naoLidas: 0 }] };
    const h = htmlDestinatarios(d, { agora: AGORA });
    for (const t of ["Consentimento", "Verificado", "<th>Interação</th>", "Registrada", "Comunicação", "Última interação", "Confirmado", "Pendente", "Não verificado", "Pediu para parar", "Sem interação", "Habilitada", "Desabilitada"]) assert.ok(h.includes(t), t);
    assert.match(htmlDestinatarios({ total: 1, itens: [{ ...d.itens[1], optOut: false }] }, { agora: AGORA }), /Ainda não registrada/);
    assert.equal((h.match(/data-cc-acao="abrir-conversa"/g) ?? []).length, 2);
    assert.match(htmlDestinatarios({ total: 0, itens: [] }, { busca: "zzz" }), /O telefone não é pesquisável/); assert.match(htmlDestinatarios(null), /cc-skel-tabela/);
  });
  test("configurações: funcional visível; diagnóstico técnico RECOLHIDO por padrão (sem 'open'); sem segredo", () => {
    const h = htmlConfiguracoes({ config: { janelaComercial: { seg_sex: { inicio: "08:00", fim: "18:00" }, sab: null }, reforcoD1: { janela: "20:00–22:00", cutoff: "22:30", diasUteis: "segunda a sábado", espacamentoMinimoHoras: 2 }, tiposDeAlerta: ["dashboard_ifood_d1"], cooldownsHoras: { x: 8 }, limites: { y: 3 }, validadeDaMensagemHoras: 24, espalhamentoMaximoMinutos: 30 }, diagnostico: undefined, erros: [], empresasHabilitadas: [] });
    assert.match(h, /Configuração funcional/); assert.match(h, /<details class="cc-bloco cc-tecnico"(?![^>]*\sopen)/); assert.match(h, /Segunda a sexta: 08:00 às 18:00/);
    const d = htmlDiagnostico({ gateway: { estado: "conectado", ultimoContatoEm: iso(1), leaseValida: true }, worker: { estado: "habilitado", rodandoNestaInstancia: true, ultimoCicloEm: iso(1), resultadoUltimoCiclo: "completed" }, entrega: { estado: "operacional" }, backend: { versao: "abc" }, inbox: { ignorados: { nao_autorizado: 3 }, aceitos: 5, retencaoDias: 30 } }, [{ status: "FAILED", em: iso(4), erro: "x" }]);
    assert.match(d, /Mensagens ignoradas/); assert.match(d, /Saudável/); assert.match(d, /30 dias/);
    assert.ok(!/secret|hmac|token|auth-state|authstate|senha/i.test(d));
  });
  test("casca da Central: seção com a aba ativa e painel de aba acessível", () => {
    assert.match(htmlCasca({ aba: "historico", estado: null, naoLidas: 0, corpo: "X" }), /data-cc-aba-ativa="historico"[\s\S]*role="tabpanel" aria-labelledby="cc-aba-historico"/);
  });
});
