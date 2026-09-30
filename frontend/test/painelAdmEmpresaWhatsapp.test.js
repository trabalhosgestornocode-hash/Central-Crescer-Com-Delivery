import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlStatusWhatsappEmpresa, htmlAlavancasEmpresa, htmlDestinatarios, htmlLimitesEmpresa, htmlResultadoDryRun, htmlSimulacaoEDiagnostico } from "../src/painelAdmEmpresaWhatsapp.js";

const categorias = [{ codigo: "pendencia_d1", rotulo: "Pendência D-1" }];
const destinatario = (extra = {}) => ({ id: "ce1", nome: "Contato teste", ativo: true, tipo: "principal", telefoneMascarado: "*******1234", whatsappStatus: "AGUARDANDO_VALIDACAO", consentimento: false, verificado: false, categorias: ["pendencia_d1"], ...extra });
const painel = (destinatarios = []) => ({ destinatarios, categoriasDisponiveis: categorias, configuracao: { tetoDestinatariosAtivos: 2 } });

test("status distingue empresa habilitada, automático desligado e bloqueio global", () => {
  const html = htmlStatusWhatsappEmpresa({ status: { codigo: "ENVIO_GLOBAL_DESATIVADO", rotulo: "Envio bloqueado", whatsapp: "conectado", empresaHabilitada: true, envioAutomatico: false, envioRealPermitido: false, destinatariosAtivos: 2, destinatariosTotal: 3 } });
  for (const texto of ["Conectado", "Desligado", "Habilitada", "2 ativos (de 3)", "Bloqueado", "Nenhum envio ainda"]) assert.ok(html.includes(texto), texto);
  assert.equal(htmlStatusWhatsappEmpresa(null), "");
});

test("habilitar empresa não oferece ativação automática antes de habilitada", () => {
  const html = htmlAlavancasEmpresa({ status: { empresaHabilitada: false, envioAutomatico: false } });
  assert.match(html, /data-padm-acao="confirmar-habilitar-comunicacao"/);
  assert.match(html, /class="padm-habilitacao-confirmar" hidden/);
  assert.doesNotMatch(html, /data-padm-acao="confirmar-ligar-envio-automatico"/);
});

test("empresa habilitada mantém confirmação própria para ligar automático", () => {
  const html = htmlAlavancasEmpresa({ status: { empresaHabilitada: true, envioAutomatico: false } });
  assert.match(html, /data-padm-acao="desabilitar-comunicacao-org"/);
  assert.match(html, /data-padm-acao="confirmar-ligar-envio-automatico"/);
  assert.match(html, /class="padm-habilitacao-confirmar" hidden/);
});

test("automático ativo permite desligamento e não mostra confirmação de ligar", () => {
  const html = htmlAlavancasEmpresa({ status: { empresaHabilitada: true, envioAutomatico: true } });
  assert.match(html, /data-padm-acao="desligar-envio-automatico"/);
  assert.doesNotMatch(html, /data-padm-acao="confirmar-ligar-envio-automatico"/);
});

test("cada destinatário possui ações próprias e telefone mascarado", () => {
  const html = htmlDestinatarios(painel([destinatario({ telefone_e164: "+5511987654321" }), destinatario({ id: "ce2", nome: "Segundo contato", ativo: false })]));
  assert.match(html, /data-padm-dest="ce1"/);
  assert.match(html, /data-padm-dest="ce2"/);
  assert.match(html, /Reativar/);
  assert.match(html, /\*{7}1234/);
  assert.doesNotMatch(html, /5511987654321/);
  assert.match(html, /Pendência D-1/);
});

for (const campo of ["consentimento", "verificado"]) {
  test(`autorização incompleta (${campo}) mantém ação de registrar autorização`, () => {
    const html = htmlDestinatarios(painel([destinatario({ whatsappStatus: "VALIDADO", consentimento: true, verificado: true, [campo]: false })]));
    assert.match(html, /data-padm-dest-acao="autorizar"/);
  });
}

test("autorização completa não oferece autorização repetida", () => {
  const html = htmlDestinatarios(painel([destinatario({ whatsappStatus: "VALIDADO", consentimento: true, verificado: true })]));
  assert.doesNotMatch(html, /data-padm-dest-acao="autorizar"/);
});

test("opt-out é visível e não oferece registro repetido", () => {
  const html = htmlDestinatarios(painel([destinatario({ optOut: true })]));
  assert.match(html, /Opt-out/);
  assert.doesNotMatch(html, /data-padm-dest-acao="optout"/);
});

test("limite conta apenas destinatários ativos", () => {
  const cheio = htmlDestinatarios(painel([destinatario(), destinatario({ id: "ce2" })]));
  assert.match(cheio, /<button[^>]*disabled[^>]*>Adicionar destinatário/);
  const vaga = htmlDestinatarios(painel([destinatario(), destinatario({ id: "ce2", ativo: false })]));
  assert.doesNotMatch(vaga, /<button[^>]*disabled[^>]*>Adicionar destinatário/);
});

test("nomes e categorias não viram HTML executável", () => {
  const p = painel([destinatario({ nome: '<script>alert("x")</script>' })]);
  p.categoriasDisponiveis = [{ codigo: "pendencia_d1", rotulo: '<img src=x onerror="alert(1)">' }];
  const html = htmlDestinatarios(p);
  assert.doesNotMatch(html, /<script|<img src=x/);
  assert.match(html, /&lt;script&gt;/);
});

test("limites da empresa preservam padrão global e valores específicos", () => {
  const html = htmlLimitesEmpresa({ configuracao: { limites: { limiteDiarioOrg: 20, cooldownMinutos: null, padraoGlobal: { maxPorDestinatarioPorDia: 5, maxPorOrganizacaoPorDia: 30 } } } });
  assert.match(html, /name="limiteDiarioOrg" value="20"/);
  assert.match(html, /name="cooldownMinutos" value=""/);
  assert.match(html, /5 mensagens por destinatário/);
  assert.match(html, /30 por empresa/);
});

test("simulação vazia informa zero envios reais mesmo com modo bloqueado", () => {
  const html = htmlResultadoDryRun({ envioRealPermitido: false, resumo: { mensagensQueSeriamGeradas: 2 }, alertas: [] });
  assert.match(html, /mensagens realmente enviadas: <strong>0/);
  assert.match(html, /Nenhum alerta detectado/);
  assert.match(html, /Modo DISABLED/);
});

test("simulação mostra motivo de exclusão e escapa texto da mensagem", () => {
  const html = htmlResultadoDryRun({ alertas: [{ alerta_detectado: { unidade: "Loja" }, empresa_elegivel: true, destinatarios_avaliados: 2, destinatarios_elegiveis: 1, destinatarios_bloqueados: [{ nome: "Contato bloqueado", motivo: "OPT_OUT" }], destinatarios: [{ elegivel: true, nome: "Contato permitido", passos: [{ etapa: "ENVIO_BLOQUEADO_PELO_DRY_RUN", ok: true }] }], mensagens_que_seriam_geradas: [{ nome: "Contato permitido", texto: "<script>injetado</script>" }] }] });
  assert.match(html, /Pediu para não receber/);
  assert.match(html, /Envio bloqueado pelo dry-run/);
  assert.match(html, /&lt;script&gt;injetado/);
  assert.doesNotMatch(html, /<script>/);
});

test("simulação segue disponível em DISABLED e legado aparece só no diagnóstico", () => {
  const html = htmlSimulacaoEDiagnostico({ diagnostico: { pilotoLegado: { configurado: true, rotulo: "LEGACY — sem efeito" } } });
  assert.match(html, /data-padm-acao="dry-run"/);
  assert.match(html, /Funciona mesmo com o modo global em DISABLED/);
  assert.match(html, /LEGACY — sem efeito/);
  assert.doesNotMatch(htmlSimulacaoEDiagnostico({}), /Diagnóstico técnico/);
});

test("alertas recentes mostram a entrega parcial por destinatário com contagens separadas (nunca só 'enviado')", async () => {
  const { htmlAlertasRecentes } = await import("../src/painelAdmEmpresaWhatsapp.js");
  const entrega = { situacao: "PARCIAL", rotulo: "Entregue parcialmente — 1 de 2 destinatários receberam", previstos: 2, enviados: 1, pendentes: 0, entregaIncerta: 0, falhaPermanente: 1, optOut: 0, bloqueados: 0, expirados: 0 };
  const html = htmlAlertasRecentes({ alertasRecentes: [{ alertaId: "a1", tipo: "dashboard_ifood_d1", dataReferencia: "2026-09-15", status: "SENT", entrega }] });
  for (const texto of ["Entregue parcialmente — 1 de 2 destinatários receberam", "2 previstos", "1 enviados", "1 falha permanente", 'data-situacao="PARCIAL"', "padm-chip-alerta"]) assert.ok(html.includes(texto), texto);
  assert.match(htmlAlertasRecentes({ alertasRecentes: [] }), /Nenhum alerta ainda/);
  assert.equal(htmlAlertasRecentes(null), "");
});
