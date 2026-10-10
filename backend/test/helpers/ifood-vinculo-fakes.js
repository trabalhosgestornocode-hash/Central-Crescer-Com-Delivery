// Fakes em memória do vínculo manual de merchant (unidade só com o app Order) — usados pelos testes de
// serviço (backend) e pelo teste de navegador (frontend), que sobe um servidor local com os serviços REAIS.
//
// Espelham a semântica do banco: tenant em toda consulta da unidade, índices únicos (merchant vivo por
// conexão; um vínculo em aberto por conexão e por merchant) e compare-and-set. O "iFood" é sempre falso:
// `respostasPolling` é a fila de respostas da consulta de eventos; nada sai para a rede.

import { ifoodErro, IFOOD_ERROS } from "../../src/modules/ifood/ifood.errors.js";

export const SACI = "00000000-0000-0000-0000-0000000000a1";          // unidade do piloto
export const NORTH = "00000000-0000-0000-0000-0000000000b2";         // mesma organização, FORA do piloto, usa Financial
export const ORG = "00000000-0000-0000-0000-000000000001";
export const OUTRA_ORG = "00000000-0000-0000-0000-000000000099";
export const UN_OUTRA_ORG = "00000000-0000-0000-0000-0000000000c3";   // outra organização, também no piloto
export const GESTOR = "user-gestor";

// ---------------------------------------------------------------------------
// Fakes em memória (espelham a semântica do banco: tenant em toda consulta, índices únicos, CAS)
// ---------------------------------------------------------------------------
export function criarAmbiente({ piloto = [SACI, UN_OUTRA_ORG], validacao = false, agoraMs = Date.parse("2026-10-10T15:00:00Z") } = {}) {
  const conexoes = [];
  const credenciais = [];
  const linhas = [];
  const chamadas = { token: [], polling: [], ack: [], definirMerchant: 0 };
  const relogio = { ms: agoraMs };
  let seq = 0;
  const viva = (c) => c.status !== "revogada";
  const aberto = (v) => v.estado === "informado" || v.estado === "aguardando_validacao";

  const repo = {
    conexoes, credenciais,
    async obterConexaoViva({ organizacaoId, unidadeId }) {
      const c = conexoes.find((x) => x.organizacao_id === organizacaoId && x.unidade_id === unidadeId && viva(x));
      return c ? { ...c } : null;
    },
    async obterCredencial({ conexaoId, appType }) {
      const k = credenciais.find((x) => x.conexao_id === conexaoId && x.app_type === appType);
      return k ? { ...k } : null;
    },
    async listarCredenciaisDaConexao({ conexaoId }) { return credenciais.filter((x) => x.conexao_id === conexaoId).map((k) => ({ ...k })); },
    async conexaoVivaDoMerchant({ merchantId }) {
      const c = conexoes.find((x) => x.merchant_id === merchantId && viva(x));
      return c ? { id: c.id, organizacao_id: c.organizacao_id, unidade_id: c.unidade_id, status: c.status, merchant_id: c.merchant_id } : null;
    },
    async definirMerchantDaConexao({ organizacaoId, unidadeId, conexaoId, merchantId, nome, razaoSocial }) {
      chamadas.definirMerchant += 1;
      if (conexoes.some((x) => x.merchant_id === merchantId && viva(x) && x.id !== conexaoId)) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_DUPLICADO);   // índice único
      const c = conexoes.find((x) => x.id === conexaoId && x.organizacao_id === organizacaoId && x.unidade_id === unidadeId);
      if (!c) return null;
      Object.assign(c, { merchant_id: merchantId, merchant_nome: nome ?? null, merchant_razao_social: razaoSocial ?? null, status: "ativa", conectada_em: new Date(relogio.ms).toISOString() });
      return { ...c };
    },
    async cancelarSessoesPendentes() {},
    async apagarCredenciais({ conexaoId }) { for (let i = credenciais.length - 1; i >= 0; i -= 1) if (credenciais[i].conexao_id === conexaoId) credenciais.splice(i, 1); },
    async atualizarConexao({ organizacaoId, unidadeId, conexaoId, campos }) {
      const c = conexoes.find((x) => x.id === conexaoId && x.organizacao_id === organizacaoId && x.unidade_id === unidadeId);
      if (c) Object.assign(c, campos);
      return c ? { ...c } : null;
    },
  };

  const doTenant = (v, { organizacaoId, unidadeId }) => v.organizacao_id === organizacaoId && v.unidade_id === unidadeId;
  const vinculos = {
    linhas,
    async obterVinculoAberto(p) { const v = linhas.find((x) => x.conexao_id === p.conexaoId && doTenant(x, p) && aberto(x)); return v ? { ...v } : null; },
    async obterUltimoVinculo(p) { const v = linhas.filter((x) => x.conexao_id === p.conexaoId && doTenant(x, p)).at(-1); return v ? { ...v } : null; },
    async vinculoAbertoDoMerchant({ merchantId }) { const v = linhas.find((x) => x.merchant_id === merchantId && aberto(x)); return v ? { ...v } : null; },
    async contarRejeicoesRecentes(p) {
      return linhas.filter((x) => x.conexao_id === p.conexaoId && doTenant(x, p) && x.estado === "rejeitado" && x.encerrado_motivo === "SEM_AUTORIZACAO" && x.rejeitado_em >= p.desdeIso).length;
    },
    async criarVinculo({ organizacaoId, unidadeId, conexaoId, merchantId, usuarioId }) {
      if (linhas.some((x) => aberto(x) && (x.conexao_id === conexaoId || x.merchant_id === merchantId))) throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_DUPLICADO);   // índices únicos
      const v = {
        id: `vinc-${(seq += 1)}`, conexao_id: conexaoId, organizacao_id: organizacaoId, unidade_id: unidadeId, merchant_id: merchantId,
        estado: "informado", informado_por: usuarioId ?? null, informado_em: new Date(relogio.ms).toISOString(),
        confirmado_por: null, confirmado_em: null, autorizacao_tentativas: 0, autorizacao_ultima_tentativa_em: null,
        autorizacao_verificada_em: null, validado_por: null, validado_em: null, rejeitado_em: null, encerrado_motivo: null,
      };
      linhas.push(v);
      return { ...v };
    },
    async atualizarVinculo({ organizacaoId, unidadeId, id, seEstado, seTentativas, campos }) {
      const v = linhas.find((x) => x.id === id && doTenant(x, { organizacaoId, unidadeId }) && x.estado === seEstado);
      if (!v || (seTentativas !== undefined && v.autorizacao_tentativas !== seTentativas)) return null;
      Object.assign(v, campos);
      return { ...v };
    },
    async cancelarVinculosAbertos(p) {
      const alvo = linhas.filter((x) => x.conexao_id === p.conexaoId && doTenant(x, p) && aberto(x));
      for (const v of alvo) Object.assign(v, { estado: "cancelado", encerrado_motivo: p.motivo });
      return alvo.length;
    },
  };

  const cfg = { piloto: new Set(piloto), validacao };
  const token = {
    orderLiberadoParaUnidade: (u) => cfg.piloto.has(u),
    validacaoMerchantManualHabilitada: () => cfg.validacao,
    async comAccessTokenValido({ conexaoId, appType, fn }) { chamadas.token.push({ conexaoId, appType }); return fn("token-order-de-teste"); },
  };
  const respostasPolling = [];
  const client = {
    async buscarEventos({ merchantIds }) {
      chamadas.polling.push([...merchantIds]);
      const r = respostasPolling.length ? respostasPolling.shift() : [];
      if (r instanceof Error) throw r;
      return r;
    },
    async confirmarEventos(a) { chamadas.ack.push(a); return { enviados: 0 }; },
  };
  const logs = [];
  const deps = { repo, vinculos, token, client, http: {}, agora: () => new Date(relogio.ms), log: (nivel, evento, dados) => logs.push({ nivel, evento, dados }) };

  /** Conexão criada pelo OAuth: `pendente`, sem merchant. */
  const conectar = ({ unidadeId = SACI, organizacaoId = ORG, apps = ["order"], merchantId = null, status = merchantId ? "ativa" : "pendente", id } = {}) => {
    const c = { id: id ?? `con-${(seq += 1)}`, organizacao_id: organizacaoId, unidade_id: unidadeId, merchant_id: merchantId, merchant_nome: null, merchant_razao_social: null, status, conectada_em: null, ultimo_erro: null };
    conexoes.push(c);
    for (const a of apps) credenciais.push({ conexao_id: c.id, app_type: a, status: "ativa", expira_em: new Date(relogio.ms + 3 * 3_600_000).toISOString(), atualizado_em: new Date(relogio.ms).toISOString() });
    return c;
  };
  const p = (extra = {}) => ({ organizacaoId: ORG, unidadeId: SACI, usuarioId: GESTOR, deps, ...extra });
  return { repo, vinculos, token, client, deps, cfg, chamadas, logs, relogio, respostasPolling, conectar, p, linhas, conexoes, credenciais };
}
