// Aba CONEXÃO — construtores de HTML: os 6 estados em linguagem amigável, cartão da conta conectada (nada inventado), QR SÓ como imagem (nunca a string crua), assistente com
// 5 etapas, confirmação obrigatória da conta, modais de alto impacto (desconectar/trocar), permissão específica e sigilo (nenhuma credencial em lugar nenhum).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { htmlConexao, htmlCartaoConexao, htmlContaConectada, htmlIdentidade, htmlDetalhesTecnicos, htmlAssistente, htmlQuadroQr, htmlModalDesconectar, htmlModalTrocar, assistenteEmAndamento } from "../src/central/centralConexaoUi.js";
import { resumoParaTopo } from "../src/central/centralConexao.js";

const AGORA = new Date(2026, 8, 24, 15, 0, 0);
const iso = (min) => new Date(AGORA.getTime() - min * 60_000).toISOString();
const QR_CRU = "2@STRING-CRUA-DO-QR-NAO-PODE-APARECER,abc,def";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

const conta = (o = {}) => ({ nome: "Crescer Teste", iniciais: "CT", fotoUrl: null, telefoneMascarado: "********21", tipoConta: "DESCONHECIDO", tipoContaRotulo: "Tipo não identificado", descricao: "Automação de delivery", ...o });
const est = (o = {}) => ({
  estado: "DISCONNECTED", rotulo: "Desconectado", conectado: false, reconectando: false, semSinal: false,
  identidade: { status: "SEM_CONTA", ambiente: "TESTE", ambienteRotulo: "Ambiente de teste", nomeOperacional: null, agenteCrescer: false, confirmadoEm: null },
  conta: null, saude: { id: "sem_sinal", rotulo: "Sem sinal", ultimoSinalEm: iso(1), conectadoEm: null },
  tecnico: { gateway: "Respondendo", heartbeatEm: iso(1), sessaoValida: true, socket: "Fechado", ultimaConexaoEm: iso(600), ultimaDesconexaoEm: iso(300), motivoUltimaDesconexao: "A conexão com o WhatsApp caiu", versao: "1.9.0", tentativasReconexao: 0 },
  permissoes: { gerenciar: true }, operacao: null, ...o,
});
const conectado = (o = {}) => est({ estado: "CONNECTED", rotulo: "Conectado", conectado: true, conta: conta(), identidade: { status: "CONFIRMADA", ambiente: "TESTE", ambienteRotulo: "Ambiente de teste", nomeOperacional: null, agenteCrescer: false, confirmadoEm: iso(30) }, saude: { id: "saudavel", rotulo: "Saudável", ultimoSinalEm: iso(0.5), conectadoEm: iso(30) }, ...o });

describe("cartão principal por estado", () => {
  test("DISCONNECTED: empty state com ilustração, texto que preserva o histórico e 'Conectar WhatsApp'", () => {
    const h = htmlCartaoConexao(est());
    assert.match(h, /Nenhum WhatsApp conectado/); assert.match(h, /cc-ilus/); assert.match(h, /histórico existente continua preservado/); assert.match(h, /data-cc-conexao="conectar"[\s\S]*Conectar WhatsApp/);
    assert.match(h, /Desconectado/);
  });
  test("cada estado com o rótulo amigável e a ação certa", () => {
    const c = (o) => htmlCartaoConexao(est(o));
    assert.match(c({ estado: "CONNECTING" }), /Conectando ao WhatsApp/); assert.match(c({ estado: "CONNECTING" }), />Conectando</);
    assert.match(c({ estado: "WAITING_QR" }), /Aguardando a leitura do QR Code/);
    const espera = c({ estado: "WAITING_QR", operacao: { id: "op1", tipo: "CONECTAR" } });
    assert.match(espera, /data-cc-conexao="retomar"/); assert.match(espera, /data-cc-conexao="cancelar-operacao"/);
    const rec = c({ estado: "RECONNECTING", tecnico: { ...est().tecnico, tentativasReconexao: 3 } });
    assert.match(rec, /Reconectando ao WhatsApp/); assert.match(rec, /Nenhuma ação é necessária \(tentativa 3\)/); assert.ok(!/data-cc-conexao="conectar"/.test(rec));
    const auth = c({ estado: "AUTH_ERROR" });
    assert.match(auth, /Sessão inválida/); assert.match(auth, /Conecte novamente/); assert.match(auth, /data-cc-conexao="conectar"/); assert.match(auth, /cc-id-card--critico/);
  });
  test("CONNECTED: foto/iniciais, nome, número mascarado, tipo, ambiente, 'Agente Crescer' só quando marcado; Trocar e Desconectar", () => {
    const h = htmlCartaoConexao(conectado());
    for (const t of ["Crescer Teste", "********21", "Tipo não identificado", "Ambiente de teste", "Trocar número conectado", "Desconectar WhatsApp"]) assert.ok(h.includes(t), t);
    assert.ok(!/Agente Crescer/.test(h));
    assert.match(htmlCartaoConexao(conectado({ identidade: { ...conectado().identidade, agenteCrescer: true, nomeOperacional: "Agente Crescer" } })), /cc-tag--agente[\s\S]*Agente Crescer/);
    assert.match(htmlCartaoConexao(conectado({ conta: conta({ fotoUrl: "https://pps.whatsapp.net/x.jpg" }) })), /<img class="cc-avatar-img"/);
    assert.ok(!/<img/.test(h), "sem foto ⇒ só as iniciais");
  });
  test("SEM a permissão: nenhum botão de ação e a explicação; o estado continua visível", () => {
    for (const e of [est({ permissoes: { gerenciar: false } }), conectado({ permissoes: { gerenciar: false } })]) {
      const h = htmlConexao(e);
      assert.ok(!/data-cc-conexao=/.test(h)); assert.match(h, /Apenas administradores autorizados/);
    }
    assert.match(htmlCartaoConexao(conectado({ permissoes: { gerenciar: false } })), /Crescer Teste/);
  });
  test("conta conectada mas NÃO confirmada: destaca 'Revisar e confirmar conta' e avisa que o envio está bloqueado", () => {
    const e = conectado({ identidade: { ...conectado().identidade, status: "PENDENTE_CONFIRMACAO" } });
    assert.match(htmlCartaoConexao(e), /data-cc-conexao="revisar"/); assert.match(htmlConexao(e, { agora: AGORA }), /Falta só a confirmação do operador[\s\S]*Envios protegidos até a confirmação/);
    assert.ok(!/ainda não foi confirmada/.test(htmlConexao(conectado(), { agora: AGORA })));
  });
  test("Gateway sem resposta: avisa que mostra o último estado conhecido", () => {
    assert.match(htmlCartaoConexao(est({ semSinal: true })), /Sem resposta do Gateway\. Mostrando o último estado conhecido/);
  });
});

describe("conta conectada, identidade e detalhes técnicos", () => {
  test("mostra o que o WhatsApp informa; recado só se existir; saúde; gateway; último sinal; conectado desde", () => {
    const h = htmlConexao(conectado(), { agora: AGORA });
    for (const t of ["Nome do perfil", "Número", "Tipo da conta", "Recado", "Automação de delivery", "Conectada desde", "Última comunicação", "Conexão estável", "Gateway", "Respondendo"]) assert.ok(h.includes(t), t);
    const sem = htmlContaConectada(conectado({ conta: conta({ descricao: null, nome: null }) }), { agora: AGORA });
    assert.ok(!/Recado/.test(sem), "sem descrição ⇒ a linha não existe (nada inventado)"); assert.match(sem, /O WhatsApp não informou/);
    assert.equal(htmlContaConectada(est(), { agora: AGORA }), "");
  });
  test("identidade interna: nome operacional separado do número; alternador e ambiente só para quem gerencia e só com conta confirmada", () => {
    const ok = htmlIdentidade(conectado());
    assert.match(ok, /Sem nome operacional/); assert.match(ok, /role="switch"[^>]*aria-checked="false"[^>]*data-cc-conexao="agente"|data-cc-conexao="agente"/); assert.match(ok, /data-cc-conexao="ambiente"[^>]*data-cc-valor="PRODUCAO"|data-cc-valor="PRODUCAO"/);
    assert.match(ok, /Se o número mudar, ele precisa ser definido de novo/);
    const pend = htmlIdentidade(conectado({ identidade: { ...conectado().identidade, status: "PENDENTE_CONFIRMACAO" } }));
    assert.ok(!/data-cc-conexao="agente"/.test(pend)); assert.match(pend, /Disponível depois que a conta for confirmada/);
    const semPerm = htmlIdentidade(conectado({ permissoes: { gerenciar: false } }));
    assert.ok(!/data-cc-conexao=/.test(semPerm)); assert.match(semPerm, /Ambiente de teste/);
    assert.match(htmlIdentidade(conectado({ identidade: { ...conectado().identidade, nomeOperacional: "Agente Crescer", agenteCrescer: true } })), /<strong>Agente Crescer<\/strong>[\s\S]*aria-checked="true"/);
  });
  test("detalhes técnicos: RECOLHIDOS por padrão (sem 'open') e com tudo o que foi pedido", () => {
    const h = htmlDetalhesTecnicos(est(), { agora: AGORA });
    assert.match(h, /<details class="cc-bloco cc-tecnico"(?![^>]*\sopen)/);
    for (const t of ["Gateway", "Heartbeat", "Sessão do Gateway", "Socket", "Última conexão", "Última desconexão", "Motivo da última desconexão", "A conexão com o WhatsApp caiu", "Versão do Gateway", "1.9.0", "Tentativas de reconexão"]) assert.ok(h.includes(t), t);
    assert.match(htmlDetalhesTecnicos(est({ tecnico: { ...est().tecnico, motivoUltimaDesconexao: null, versao: null } }), { agora: AGORA }), /Sem registro[\s\S]*Não informada/);
  });
  test("skeleton do perfil enquanto carrega", () => assert.match(htmlConexao(null), /cc-skel/));
});

describe("QR: só como imagem, com contagem e expiração", () => {
  const w = (o = {}) => ({ modo: "conectar", fase: "aguardando", resp: { disponivel: true, svg: SVG, expiraEm: new Date(AGORA.getTime() + 42_000).toISOString(), ordem: 1, geradoEm: iso(0.3) }, ...o });
  test("o QR vira <img> com data URL do SVG; a string crua NUNCA aparece no HTML", () => {
    const h = htmlQuadroQr(w({ resp: { ...w().resp, qr: QR_CRU, valor: QR_CRU } }), AGORA.getTime());
    assert.match(h, /<img class="cc-qr-img" src="data:image\/svg\+xml;utf8,%3Csvg/); assert.match(h, /alt="QR Code de conexão do WhatsApp"/);
    assert.ok(!h.includes("STRING-CRUA") && !h.includes(QR_CRU));
    assert.ok(!/<svg[^>]*xmlns/.test(h.replace(/<svg class="cc-qr-anel"[\s\S]*?<\/svg>/, "")), "o SVG do QR não é injetado como marcação (fica no data URL da <img>)");
  });
  test("contagem: 'Expira em N s' e anel; ao expirar, sobreposição com 'Gerar novo QR Code' e sem imagem", () => {
    const h = htmlQuadroQr(w(), AGORA.getTime());
    assert.match(h, /Expira em <b>42 s<\/b>/); assert.match(h, /cc-anel-prog/);
    const exp = htmlQuadroQr(w({ fase: "expirado" }), AGORA.getTime());
    assert.match(exp, /QR Code expirado/); assert.match(exp, /data-cc-conexao="novo-qr"/); assert.ok(!/<img class="cc-qr-img"/.test(exp)); assert.match(exp, /Expirou/);
  });
  test("sem imagem (Gateway antigo) ⇒ placeholder, nunca um QR falso", () => {
    assert.ok(!/<img class="cc-qr-img"/.test(htmlQuadroQr(w({ resp: { ...w().resp, svg: null } }), AGORA.getTime())));
  });
});

describe("assistente de conexão", () => {
  const base = { modo: "conectar", resp: null, conta: null, agente: false, ambiente: "TESTE", erro: null, enviando: false, falhouEm: null };
  test("cabeçalho por modo e stepper com as 5 etapas; a etapa atual marcada", () => {
    const h = htmlAssistente({ ...base, fase: "aguardando", resp: { disponivel: true, svg: SVG, expiraEm: iso(-1), ordem: 1 } }, AGORA.getTime());
    assert.match(h, /Conectar WhatsApp/); assert.match(h, /role="dialog" aria-modal="true"/); assert.equal((h.match(/class="cc-step /g) ?? []).length, 5);
    for (const r of ["Iniciar conexão", "Escanear QR Code", "Conta identificada", "Confirmar identidade", "Conexão concluída"]) assert.ok(h.includes(r), r);
    assert.match(h, /aria-current="step"/);
    assert.match(htmlAssistente({ ...base, modo: "trocar", fase: "gerando" }, AGORA.getTime()), /Trocar número conectado/);
    assert.match(htmlAssistente({ ...base, modo: "revisar", fase: "identificado", conta: conta() }, AGORA.getTime()), /Confirmar conta do WhatsApp/);
  });
  test("QR: instruções de leitura e rodapé com 'Cancelar'", () => {
    const h = htmlAssistente({ ...base, fase: "aguardando", resp: { disponivel: true, svg: SVG, expiraEm: iso(-1), ordem: 1 } }, AGORA.getTime());
    assert.match(h, /Abra o WhatsApp no celular\./); assert.match(h, /Aparelhos conectados/); assert.match(h, /data-cc-conexao="assistente-cancelar"/);
  });
  test("identificado: NÃO conclui em silêncio — mostra foto/nome/número/tipo, faz a pergunta e exige 'Confirmar conexão'", () => {
    const h = htmlAssistente({ ...base, fase: "identificado", conta: conta() }, AGORA.getTime());
    assert.match(h, /WhatsApp identificado/); assert.match(h, /Crescer Teste/); assert.match(h, /\*{8}21/); assert.match(h, /Tipo não identificado/);
    assert.match(h, /Esta é a conta que o Crescer com Delivery deve usar\?/); assert.match(h, /data-cc-conexao="assistente-cancelar"[\s\S]*Cancelar/); assert.match(h, /data-cc-conexao="assistente-confirmar"[^>]*>Confirmar conexão/);
    assert.match(h, /Vincular ao Agente Crescer/); assert.match(h, /data-cc-agente/); assert.ok(!/data-cc-agente checked/.test(h));
    assert.match(htmlAssistente({ ...base, fase: "identificado", conta: conta(), agente: true, ambiente: "PRODUCAO" }, 0), /data-cc-agente checked[\s\S]*aria-checked="true"[^>]*data-cc-valor="PRODUCAO"|data-cc-agente checked/);
    assert.match(htmlAssistente({ ...base, fase: "identificado", conta: conta(), enviando: true }, 0), /Confirmando…[\s\S]*disabled|disabled[\s\S]*Confirmando/);
    assert.match(htmlAssistente({ ...base, fase: "identificado", conta: conta(), erro: "Não foi possível confirmar" }, 0), /role="alert">Não foi possível confirmar/);
  });
  test("validando, perfil, concluída e erro têm corpo e rodapé próprios; concluída mostra Agente Crescer quando marcado", () => {
    assert.match(htmlAssistente({ ...base, fase: "validando" }, 0), /Validando a sessão/); assert.match(htmlAssistente({ ...base, fase: "perfil" }, 0), /Identificando a conta/);
    const ok = htmlAssistente({ ...base, fase: "concluida", conta: conta(), agente: true }, 0);
    assert.match(ok, /Conexão concluída/); assert.match(ok, /vinculada ao Agente Crescer/); assert.match(ok, /data-cc-conexao="assistente-fechar"[^>]*>Concluir/);
    const erro = htmlAssistente({ ...base, fase: "erro", erro: "Sem resposta", falhouEm: 1 }, 0);
    assert.match(erro, /Não foi possível concluir/); assert.match(erro, /Sem resposta/); assert.match(erro, /assistente-tentar/); assert.match(erro, /cc-step--erro/);
  });
  test("nenhuma fase do assistente expõe a string crua do QR nem credenciais", () => {
    for (const fase of ["iniciando", "gerando", "aguardando", "expirado", "validando", "perfil", "identificado", "concluida", "erro"]) {
      const h = htmlAssistente({ ...base, fase, conta: conta(), resp: { disponivel: true, svg: SVG, qr: QR_CRU, expiraEm: iso(-1), ordem: 1 } }, AGORA.getTime());
      assert.ok(!h.includes("STRING-CRUA"), fase); assert.ok(!/auth|signal|token|hmac|secret|senha/i.test(h.replace(/data:image\/svg\+xml[^"]*/g, "")), fase);
    }
  });
  test("assistenteEmAndamento distingue o que ainda pode ser cancelado", () => {
    assert.equal(assistenteEmAndamento({ fase: "aguardando" }), true); assert.equal(assistenteEmAndamento({ fase: "identificado" }), false); assert.equal(assistenteEmAndamento(null), false);
  });
});

describe("modais de alto impacto", () => {
  test("DESCONECTAR: explica as 3 consequências, garante que o histórico é preservado e exige o checkbox (botão travado até marcar)", () => {
    const h = htmlModalDesconectar({ conta: conta() });
    assert.match(h, /role="alertdialog"/); assert.match(h, /Desconectar o WhatsApp\?/);
    for (const t of ["As mensagens deixarão de ser enviadas.", "As mensagens deixarão de ser recebidas.", "As automações de WhatsApp ficarão indisponíveis."]) assert.ok(h.includes(t), t);
    assert.match(h, /histórico de conversas e mensagens do Crescer com Delivery <strong>será preservado<\/strong>/); assert.match(h, /Só a sessão do WhatsApp neste sistema é removida/);
    assert.match(h, /data-cc-confirma/); assert.match(h, /data-cc-conexao="desconectar-confirmar" disabled/);
    const marcado = htmlModalDesconectar({ conta: conta(), marcado: true });
    assert.ok(!/desconectar-confirmar" disabled/.test(marcado)); assert.match(marcado, /data-cc-confirma checked/);
    assert.match(htmlModalDesconectar({ conta: conta(), marcado: true, enviando: true }), /desconectar-confirmar" disabled>Desconectando…/);
    assert.match(htmlModalDesconectar({ conta: conta(), erro: "Falhou" }), /role="alert">Falhou/);
  });
  test("TROCAR: mostra a sequência segura (6 passos), avisa que nada é enviado/recebido e exige confirmação", () => {
    const h = htmlModalTrocar({ conta: conta() });
    for (const t of ["Confirmar a troca", "Desconectar a conta atual", "Gerar um QR Code", "Escanear a nova conta", "Identificar a nova conta", "Confirmar a identidade"]) assert.ok(h.includes(t), t);
    assert.match(h, /sem duas sessões ao mesmo tempo/); assert.match(h, /nenhuma mensagem é enviada ou recebida/); assert.match(h, /trocar-confirmar" disabled/); assert.ok(!/trocar-confirmar" disabled/.test(htmlModalTrocar({ conta: conta(), marcado: true })));
  });
  test("os modais escapam o nome da conta", () => {
    const h = htmlModalDesconectar({ conta: conta({ nome: "<script>alert(1)</script>" }) }) + htmlModalTrocar({ conta: conta({ nome: "<b onmouseover=x>" }) });
    assert.ok(!/<script>|<b onmouseover/.test(h));
  });
});

describe("resumo para o topo da Central", () => {
  test("estado da sessão → vocabulário do topo; nulo ⇒ nulo", () => {
    assert.equal(resumoParaTopo(null), null);
    assert.equal(resumoParaTopo(conectado()).gateway, "conectado");
    for (const s of ["CONNECTING", "WAITING_QR", "RECONNECTING"]) assert.equal(resumoParaTopo(est({ estado: s })).gateway, "instavel", s);
    for (const s of ["DISCONNECTED", "AUTH_ERROR"]) assert.equal(resumoParaTopo(est({ estado: s })).gateway, "desconectado", s);
    assert.deepEqual(resumoParaTopo(conectado()).identidade, { status: "CONFIRMADA", ambiente: "TESTE", nomeOperacional: null });
  });
});
