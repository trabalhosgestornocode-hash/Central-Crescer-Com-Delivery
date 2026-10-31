// Repositório FALSO da Central de Notificações (em memória) — mesma forma de notificacoes.repository.js.
// As regras do BANCO (CHECKs, gatilhos, RPCs atômicas) são provadas no harness PG (testes-seguros/pg/notificacoes_config2.sh);
// aqui o falso reproduz o necessário para testar a lógica do backend (D-3, validação, estados, auditoria).
import { randomUUID } from "node:crypto";

export const ORG_A = "00000000-0000-4000-8000-00000000a001";
export const ORG_B = "00000000-0000-4000-8000-00000000b001";
export const UN = { A1: "00000000-0000-4000-8000-0000000000a1", A2: "00000000-0000-4000-8000-0000000000a2", B1: "00000000-0000-4000-8000-0000000000b1" };
export const CE = { ana: "00000000-0000-4000-8000-0000000c0e01", joao: "00000000-0000-4000-8000-0000000c0e02", bia: "00000000-0000-4000-8000-0000000c0e03", outra: "00000000-0000-4000-8000-0000000c0e09" };

export function cenario({ selecaoLigada = false } = {}) {
  const db = {
    selecaoLigada,
    unidades: [
      { id: UN.A1, organizacao_id: ORG_A, nome: "Centro", ativo: true, eh_teste: false, timezone: null },
      { id: UN.A2, organizacao_id: ORG_A, nome: "Norte", ativo: true, eh_teste: false, timezone: null },
      { id: UN.B1, organizacao_id: ORG_B, nome: "B-única", ativo: true, eh_teste: false, timezone: null },
    ],
    destinatarios: [
      { id: CE.ana, organizacao_id: ORG_A, nome: "Ana", tipo: "principal", telefone_e164: "+5511900000001", whatsapp_status: "VALIDADO", ativo: true, created_at: "2026-09-01T00:00:00Z", autorizacao_registrada_em: "2026-09-01T00:00:00Z", contato_whatsapp_id: "cw-1" },
      { id: CE.joao, organizacao_id: ORG_A, nome: "João", tipo: "secundario", telefone_e164: "+5511900000002", whatsapp_status: "VALIDADO", ativo: true, created_at: "2026-09-02T00:00:00Z", autorizacao_registrada_em: "2026-09-02T00:00:00Z", contato_whatsapp_id: "cw-2" },
      { id: CE.bia, organizacao_id: ORG_A, nome: "Bia", tipo: "operacional", telefone_e164: "+5511900000003", whatsapp_status: "NAO_VALIDADO", ativo: true, created_at: "2026-10-30T00:00:00Z", contato_whatsapp_id: null },
      { id: CE.outra, organizacao_id: ORG_B, nome: "Outra", tipo: "principal", telefone_e164: "+5511900000001", whatsapp_status: "VALIDADO", ativo: true, created_at: "2026-09-01T00:00:00Z", contato_whatsapp_id: "cw-1" },
    ],
    categoriasLegadas: [
      { contato_empresa_id: CE.ana, categoria: "pendencia_d1", habilitado: true },
      { contato_empresa_id: CE.joao, categoria: "pendencia_d1", habilitado: true },
      { contato_empresa_id: CE.outra, categoria: "pendencia_d1", habilitado: true },
    ],
    escopos: [
      { id: "e1", contato_empresa_id: CE.bia, unidade_escopo_id: UN.A1, categoria: "fechamento_operacional_diario", habilitado: true, origem_autorizacao: "CONVITE_OTP", origem_vinculo: "CONVITE", suspenso_em: null, notificar_correcao: true, verificacao_simulada: true },
    ],
    contatos: [{ id: "cw-1", opt_out: false }, { id: "cw-2", opt_out: false }],
    ledger: [{ id: "l1", contato_empresa_id: CE.bia, organizacao_id: ORG_A, categoria: "fechamento_operacional_diario", acao: "CONCEDIDO", termo_versao: 1, origem: "link_convite_otp", simulado: true, ocorreu_em: "2026-10-30T10:00:00Z" }],
    convites: [],
    categorias: [
      { codigo: "pendencia_d1", rotulo: "Pendência D-1", estado: "ATIVA", ativo: true, ordem: 10, cota: null, grupo: "dashboard_ifood", exige_consentimento: true },
      { codigo: "fechamento_operacional_diario", rotulo: "Fechamento operacional diário", estado: "SIMULACAO", ativo: false, ordem: 20, cota: { por_destinatario_dia: 2, por_unidade_dia: 20, por_empresa_dia: 100 }, grupo: "operacao", exige_consentimento: true },
      { codigo: "disputas", rotulo: "Disputas", estado: "EM_BREVE", ativo: false, ordem: 60, cota: null, grupo: "operacao", exige_consentimento: true },
    ],
    auditoria: [], chamadas: [],
  };
  const elegiveisD1 = (org, un) => db.destinatarios.filter((d) => d.organizacao_id === org && d.ativo && d.whatsapp_status === "VALIDADO"
    && db.categoriasLegadas.some((c) => c.contato_empresa_id === d.id && c.habilitado)
    && (!db.selecaoLigada || db.escopos.some((e) => e.contato_empresa_id === d.id && e.unidade_escopo_id === un && e.categoria === "pendencia_d1" && e.habilitado && !e.suspenso_em)));
  const repo = {
    listarCategorias: async () => db.categorias,
    listarUnidades: async ({ organizacaoId }) => db.unidades.filter((u) => u.organizacao_id === organizacaoId),
    listarDestinatarios: async ({ organizacaoId }) => {
      const ces = db.destinatarios.filter((d) => d.organizacao_id === organizacaoId);
      const ids = new Set(ces.map((d) => d.id));
      return { destinatarios: ces, categoriasLegadas: db.categoriasLegadas.filter((c) => ids.has(c.contato_empresa_id)), escopos: db.escopos.filter((e) => ids.has(e.contato_empresa_id)), contatos: db.contatos };
    },
    listarConsentimentos: async ({ organizacaoId, contatoEmpresaIds }) => db.ledger.filter((l) => l.organizacao_id === organizacaoId && contatoEmpresaIds.includes(l.contato_empresa_id))
      .sort((a, b) => String(b.ocorreu_em).localeCompare(String(a.ocorreu_em))),
    listarConvites: async ({ organizacaoId }) => db.convites.filter((c) => c.organizacao_id === organizacaoId),
    contarConvitesRecentes: async () => ({ porUsuario: db.contagemUsuario ?? 0, porUnidade: db.contagemUnidade ?? 0 }),
    unidadesDoPiloto: async () => (db.piloto === undefined ? null : db.piloto.map((x) => String(x).toLowerCase())),
    inserirConvite: async (linha) => { const c = { id: randomUUID(), status: "PENDENTE", criado_em: new Date().toISOString(), ...linha }; db.convites.push(c); return { id: c.id, expira_em: c.expira_em }; },
    cancelarConvite: async ({ organizacaoId, id }) => { const c = db.convites.find((x) => x.id === id && x.organizacao_id === organizacaoId && ["PENDENTE", "VERIFICADO"].includes(x.status)); if (!c) return null; c.status = "CANCELADO"; return c; },
    obterDestinatario: async ({ organizacaoId, id }) => db.destinatarios.find((d) => d.id === id && d.organizacao_id === organizacaoId) ?? null,
    selecaoPorEscopoLigada: async () => db.selecaoLigada,
    resolverD1PorUnidade: async ({ organizacaoId, unidadeId }) => db.destinatarios.filter((d) => d.organizacao_id === organizacaoId)
      .map((d) => ({ contato_empresa_id: d.id, elegivel: elegiveisD1(organizacaoId, unidadeId).includes(d) })),
    suspenderEscopo: async (p) => { db.chamadas.push(["suspender", p]); if (p.unidadePermitida && p.unidadePermitida !== p.unidadeId) { const e = new Error("ESCOPO_FORA"); e.status = 403; throw e; } return { resultado: "SUSPENSO", mensagens_canceladas: 2 }; },
    preferenciasEscopo: async (p) => { db.chamadas.push(["preferencias", p]); return { resultado: "ATUALIZADO" }; },
    vincularLegado: async (p) => { db.chamadas.push(["vincular", p]); return { resultado: db.selecaoLigada ? "VINCULADO" : "SELECAO_POR_ESCOPO_DESLIGADA" }; },
    revogar: async (p) => { db.chamadas.push(["revogar", p]); return { resultado: "REVOGADO", mensagens_canceladas: 1 }; },
    historico: async () => ({ reais: [], simuladas: [] }),
    auditoria: async ({ unidadeId }) => [{ id: "a1", acao: "notificacao.escopo_suspenso", created_at: "2026-10-30T10:00:00Z", entidade_id: CE.ana,
      detalhes: { unidade_id: unidadeId ?? UN.A1, motivo: "teste", ip: "10.0.0.1", user_agent: "x", telefone: "+5511900000001", telefone_mascarado: "+551********01" } }],
  };
  return { db, repo };
}

export const escopoAdmin = (org = ORG_A) => ({ organizacaoId: org, unidadePermitida: null, unidadeContexto: null, podeVer: true, podeGerenciar: true, papel: "organization_admin" });
export const escopoGerente = (un = UN.A1, org = ORG_A) => ({ organizacaoId: org, unidadePermitida: un, unidadeContexto: un, podeVer: true, podeGerenciar: true, papel: "unit_manager" });
export const reqFalso = { user: { id: "00000000-0000-4000-8000-00000000u5e1", email: "gestor@x.com" }, perfil: { id: "00000000-0000-4000-8000-0000000pe501", nome: "Gestor" }, acesso: {} };
