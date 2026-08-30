// Cliente da API do Painel SuperAdmin (/api/v1/plataforma).
//
// Reaproveita o `http` de sessao.js — mesmos cabeçalhos, mesmo tratamento de
// 401/409. A diferença é semântica e importante: nenhuma chamada daqui envia o
// Context Token por necessidade (o painel não tem empresa); ele vai no header
// apenas porque o cliente HTTP é o mesmo, e o backend ignora o contexto nas
// rotas de plataforma.

import { http } from "./sessao.js";

const BASE = "/api/v1/plataforma";

/** Monta a query string, descartando vazios. @param {Record<string, unknown>} p */
function qs(p = {}) {
  const s = Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== "todos")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return s ? `?${s}` : "";
}

const get = (rota) => http.get(BASE + rota).then((r) => r.data);
const post = (rota, body) => http.post(BASE + rota, body).then((r) => r.data);
const patch = (rota, body) => http.chamar(BASE + rota, {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
}).then((r) => r.data);
const put = (rota, body) => http.chamar(BASE + rota, {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
}).then((r) => r.data);
const del = (rota, body) => http.chamar(BASE + rota, {
  method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
}).then((r) => r.data);

export const adminApi = {
  // Dashboard Global
  dashboard: () => get("/dashboard"),
  sessoes: () => get("/sessoes"),

  // Empresas
  empresas: (f) => get(`/empresas${qs(f)}`),
  empresasModelo: () => get(`/empresas${qs({ ehModelo: true })}`),
  empresa: (id) => get(`/empresas/${id}`),
  criarEmpresa: (dados) => post("/empresas", dados),
  atualizarEmpresa: (id, dados) => patch(`/empresas/${id}`, dados),
  alterarStatusEmpresa: (id, status, motivo) => patch(`/empresas/${id}/status`, { status, motivo }),
  alterarPlanoEmpresa: (id, planoId) => patch(`/empresas/${id}/plano`, { planoId }),
  // A exclusão exige o nome exato da empresa como confirmação — o backend
  // recusa sem isso, de propósito.
  impactoExclusaoEmpresa: (id) => get(`/empresas/${id}/impacto-exclusao`),
  excluirEmpresa: (id, confirmacao) => del(`/empresas/${id}`, { confirmacao }),
  usuariosDaEmpresa: (id) => get(`/empresas/${id}/usuarios`),
  unidadesDaEmpresa: (id) => get(`/empresas/${id}/unidades`),
  logsDaEmpresa: (id, limite) => get(`/empresas/${id}/logs${qs({ limite })}`),
  entrarComoEmpresa: (id) => post(`/empresas/${id}/entrar`),
  clonarModeloEmpresa: (id) => post(`/empresas/${id}/clonar-modelo`),

  // Módulos (catálogo geral + por empresa)
  modulos: () => get("/modulos"),
  modulosDaEmpresa: (id) => get(`/empresas/${id}/modulos`),
  definirModulosEmpresa: (id, modulos) => put(`/empresas/${id}/modulos`, { modulos }),

  // Unidades
  unidades: (f) => get(`/unidades${qs(f)}`),
  unidade: (id) => get(`/unidades/${id}`),
  criarUnidade: (dados) => post("/unidades", dados),
  atualizarUnidade: (id, dados) => patch(`/unidades/${id}`, dados),
  alterarStatusUnidade: (id, ativo, motivo) => patch(`/unidades/${id}/status`, { ativo, motivo }),
  impactoExclusaoUnidade: (id) => get(`/unidades/${id}/impacto-exclusao`),
  // A exclusão exige o nome exato da unidade como confirmação — o backend
  // recusa sem isso (e recusa de vez se houver histórico operacional).
  excluirUnidade: (id, confirmacao) => del(`/unidades/${id}`, { confirmacao }),
  usuariosDaUnidade: (id) => get(`/unidades/${id}/usuarios`),
  logsDaUnidade: (id, limite) => get(`/unidades/${id}/logs${qs({ limite })}`),
  modulosDaUnidade: (id) => get(`/unidades/${id}/modulos`),
  definirModulosUnidade: (id, modulos) => put(`/unidades/${id}/modulos`, { modulos }),

  // Estrutura organizacional (promover/converter/transferir) — cada uma é
  // uma transação única no banco (migration 053).
  promoverUnidade: (id, nomeEmpresa) => post(`/unidades/${id}/promover`, { nomeEmpresa }),
  transferirUnidade: (id, novaOrganizacaoId) => post(`/unidades/${id}/transferir`, { novaOrganizacaoId }),
  converterEmpresaParaUnidade: (id, empresaMaeId) => post(`/empresas/${id}/converter-em-unidade`, { empresaMaeId }),

  // Usuários globais
  usuarios: (f) => get(`/usuarios${qs(f)}`),
  usuario: (id) => get(`/usuarios/${id}`),
  papeis: () => get("/usuarios/papeis"),
  criarUsuario: (dados) => post("/usuarios", dados),
  atualizarUsuario: (id, dados) => patch(`/usuarios/${id}`, dados),
  excluirUsuario: (id) => del(`/usuarios/${id}`),
  redefinirSenha: (id, senha) => post(`/usuarios/${id}/senha`, { senha }),
  alterarEmail: (id, email) => post(`/usuarios/${id}/email`, { email }),
  forcarLogout: (id) => post(`/usuarios/${id}/logout`),
  definirSuperadmin: (id, superadmin, observacao) => post(`/usuarios/${id}/superadmin`, { superadmin, observacao }),

  // Associações
  associarEmpresa: (id, organizacaoId, papel) => post(`/usuarios/${id}/empresas`, { organizacaoId, papel }),
  // Em massa — só NOVAS associações. `itens`: [{ organizacaoId, papel }].
  associarEmpresasLote: (id, itens) => post(`/usuarios/${id}/empresas/lote`, { itens }),
  atualizarVinculo: (id, organizacaoId, dados) => patch(`/usuarios/${id}/empresas/${organizacaoId}`, dados),
  removerVinculo: (id, organizacaoId) => del(`/usuarios/${id}/empresas/${organizacaoId}`),
  associarUnidade: (id, unidadeId, papel) => post(`/usuarios/${id}/unidades`, { unidadeId, papel }),
  atualizarVinculoUnidade: (id, unidadeId, dados) => patch(`/usuarios/${id}/unidades/${unidadeId}`, dados),
  removerVinculoUnidade: (id, unidadeId) => del(`/usuarios/${id}/unidades/${unidadeId}`),

  // Financeiro
  financeiro: () => get("/financeiro"),
  metricas: () => get("/financeiro/metricas"),
  planos: () => get("/financeiro/planos"),
  criarPlano: (dados) => post("/financeiro/planos", dados),
  atualizarPlano: (id, dados) => patch(`/financeiro/planos/${id}`, dados),
  assinaturas: (f) => get(`/financeiro/assinaturas${qs(f)}`),
  criarAssinatura: (dados) => post("/financeiro/assinaturas", dados),
  atualizarAssinatura: (id, dados) => patch(`/financeiro/assinaturas/${id}`, dados),
  cobrancas: (f) => get(`/financeiro/cobrancas${qs(f)}`),
  criarCobranca: (dados) => post("/financeiro/cobrancas", dados),
  atualizarCobranca: (id, dados) => patch(`/financeiro/cobrancas/${id}`, dados),

  // Monitoramento, logs e auditoria
  monitoramento: () => get("/monitoramento"),
  auditoria: (f) => get(`/auditoria${qs(f)}`),
  filtrosAuditoria: () => get("/auditoria/filtros"),
  impersonacoes: (limite) => get(`/auditoria/impersonacoes${qs({ limite })}`),

  // Configurações globais, atualizações e IA
  configuracoes: () => get("/configuracoes"),
  salvarConfiguracoes: (dados) => put("/configuracoes", dados),
  atualizacoes: () => get("/atualizacoes"),
  ia: () => get("/ia"),
  consumoAgente: (f) => get(`/ia/consumo${qs(f)}`),
  consumoAgentePorOrganizacao: (f) => get(`/ia/consumo/organizacoes${qs(f)}`),
  consumoAgentePorModelo: (f) => get(`/ia/consumo/modelos${qs(f)}`),
};
