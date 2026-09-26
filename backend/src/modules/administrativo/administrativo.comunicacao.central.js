// CENTRAL DE COMUNICAÇÃO (H.4-B.5) — projeções de LEITURA para a tela: histórico completo de mensagens (todas as origens e status), detalhe de uma
// mensagem e a configuração operacional (somente leitura). Nunca lê `conteudo`, nunca devolve telefone completo (só `********NN`), nunca decide política,
// nunca envia, nunca escreve. Mesma autorização do resto do Painel (`requirePainelAdministrativo`).

import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import * as repo from "./administrativo.comunicacao.repo.js";
import { obterConfig, obterTtlHoras, obterJitterMaxMs, obterDisponibilidadeIfood } from "../comunicacao/comunicacao.config.js";
import { STATUS_MENSAGEM, TIPOS_ALERTA } from "../comunicacao/comunicacao.constants.js";
import { ehAvisoTardio, PROPOSITO, JANELA_REFORCO, CUTOFF_REFORCO, ESPACAMENTO_MINIMO_HORAS } from "../comunicacao/comunicacao.reforco.js";
import { PROPOSITO_TESTE, TIPO_MENSAGEM_TESTE, PROPOSITO_MANUAL, TIPO_MENSAGEM_MANUAL } from "../comunicacao/comunicacao.fila.repo.js";
import * as tentativasRepo from "../comunicacao/comunicacao.tentativas.repo.js";

export const ORIGENS_MENSAGEM = Object.freeze(["automacao", "reforco", "aviso_tardio", "teste_controlado", "manual_painel"]);
const STATUS_VALIDOS = Object.values(STATUS_MENSAGEM);

/** Telefone para a UI: só os 2 últimos dígitos (`********88`). Nunca o número completo, nunca o DDI/DDD. */
export function mascararTelefoneUi(e164) {
  const dig = String(e164 ?? "").replace(/\D/g, "");
  return dig.length >= 2 ? `${"*".repeat(8)}${dig.slice(-2)}` : null;
}

/** id curto para a tela ("a1b2c3d4…"); nunca o id inteiro do provider. */
export const abreviarId = (id) => (id ? `${String(id).slice(0, 8)}…` : null);

/** Origem AMIGÁVEL de uma mensagem (derivada; nunca um campo novo no banco). */
export function origemDaMensagem(m) {
  if (m?.metadados?.proposito === PROPOSITO_MANUAL || m?.tipo === TIPO_MENSAGEM_MANUAL) return "manual_painel";
  if (m?.metadados?.proposito === PROPOSITO_TESTE || m?.tipo === TIPO_MENSAGEM_TESTE) return "teste_controlado";
  if (m?.metadados?.proposito === PROPOSITO.REFORCO) return "reforco";
  if (ehAvisoTardio(m)) return "aviso_tardio";
  return "automacao";
}

const erroCurto = (e) => (e ? String(e).slice(0, 200) : null);

const normalizar = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function dataIsoOpcional(valor, campo) {
  if (valor === undefined || valor === null || valor === "") return undefined;
  const t = Date.parse(String(valor));
  if (!Number.isFinite(t)) throw ApiError.badRequest(`${campo} inválida.`, { codigo: "PERIODO_INVALIDO" });
  return new Date(t).toISOString();
}

/** Uma linha de mensagem já projetada para a tela (sem conteúdo, telefone mascarado, ids abreviados). */
function projetarMensagem(m, { orgPorId, unidadePorId, contatoPorId }) {
  const contato = m.contato_id ? contatoPorId.get(m.contato_id) : null;
  return {
    id: m.id, idAbreviado: abreviarId(m.id),
    organizacaoId: m.organizacao_id, empresa: orgPorId.get(m.organizacao_id) ?? abreviarId(m.organizacao_id),
    unidadeId: m.unidade_id ?? null, unidade: m.unidade_id ? (unidadePorId.get(m.unidade_id) ?? abreviarId(m.unidade_id)) : null,
    tipo: m.tipo, origem: origemDaMensagem(m),
    destinatario: contato ? mascararTelefoneUi(contato.telefone_e164) : null,
    status: m.status, tentativas: m.tentativas, maxTentativas: m.max_tentativas,
    criadoEm: m.created_at, agendadoPara: m.disponivel_em ?? null, enviadoEm: m.enviado_em ?? null,
    entregueEm: m.entregue_em ?? null, lidoEm: m.lido_em ?? null, falhouEm: m.falhou_em ?? null,
    erro: erroCurto(m.erro),
    operador: m.metadados?.ator_nome ? String(m.metadados.ator_nome).slice(0, 80) : null,
  };
}

async function mapasDeNomes(deps) {
  const [orgs, unidades] = await Promise.all([repo.listarOrganizacoesComConfiguracao({}, deps), repo.listarUnidades({}, deps)]);
  return { orgs, unidades, orgPorId: new Map(orgs.map((o) => [o.id, o.nome])), unidadePorId: new Map(unidades.map((u) => [u.id, u.nome])) };
}

/**
 * GET /administrativo/comunicacao/mensagens — HISTÓRICO COMPLETO (todos os status e origens).
 * Filtros: empresa, unidade, status, origem, período (created_at) e busca por NOME de empresa/unidade (nunca por telefone).
 */
export async function mensagens({ organizacaoId, unidadeId, status, origem, desde, ate, busca, pagina, porPagina } = {}, deps = {}) {
  if (organizacaoId) v.uuid(organizacaoId, "Empresa");
  if (unidadeId) v.uuid(unidadeId, "Unidade");
  if (status && !STATUS_VALIDOS.includes(status)) throw ApiError.badRequest("Status inválido.", { codigo: "STATUS_INVALIDO" });
  if (origem && !ORIGENS_MENSAGEM.includes(origem)) throw ApiError.badRequest("Origem inválida.", { codigo: "ORIGEM_INVALIDA" });
  const desdeIso = dataIsoOpcional(desde, "Data inicial");
  const ateIso = dataIsoOpcional(ate, "Data final");

  const { orgs, unidades, orgPorId, unidadePorId } = await mapasDeNomes(deps);
  let organizacaoIdsBusca; let unidadeIdsBusca;
  const termo = normalizar(busca);
  if (termo) {
    organizacaoIdsBusca = orgs.filter((o) => normalizar(o.nome).includes(termo)).map((o) => o.id);
    unidadeIdsBusca = unidades.filter((u) => normalizar(u.nome).includes(termo)).map((u) => u.id);
  }
  const linhas = await repo.listarMensagensCentral({ organizacaoId, unidadeId, status, desde: desdeIso, ate: ateIso, organizacaoIdsBusca, unidadeIdsBusca }, deps);
  const filtradas = origem ? linhas.filter((m) => origemDaMensagem(m) === origem) : linhas;

  const p = Math.max(1, Number(pagina) || 1);
  const porPag = Math.min(100, Math.max(1, Number(porPagina) || 20));
  const pedaco = filtradas.slice((p - 1) * porPag, p * porPag);
  const contatos = await repo.listarContatosPorIds(pedaco.map((m) => m.contato_id), deps);
  const contatoPorId = new Map(contatos.map((c) => [c.id, c]));
  return { itens: pedaco.map((m) => projetarMensagem(m, { orgPorId, unidadePorId, contatoPorId })), total: filtradas.length, pagina: p, porPagina: porPag, limitadoA500: linhas.length >= 500 };
}

/** GET /administrativo/comunicacao/mensagens/:id — detalhe (sem conteúdo, sem telefone completo). */
export async function detalheMensagem({ id } = {}, deps = {}) {
  const mid = v.uuid(id, "Mensagem");
  const m = await repo.obterMensagemCentral(mid, deps);
  if (!m) throw ApiError.notFound("Mensagem não encontrada.");
  const [{ orgPorId, unidadePorId }, contatos, tentativas] = await Promise.all([
    mapasDeNomes(deps), repo.listarContatosPorIds([m.contato_id], deps), tentativasRepo.listarTentativas(m.id, deps).catch(() => []),
  ]);
  const base = projetarMensagem(m, { orgPorId, unidadePorId, contatoPorId: new Map(contatos.map((c) => [c.id, c])) });
  return {
    ...base,
    providerMessageIdAbreviado: abreviarId(m.provider_message_id),
    servidorAceitouEm: m.metadados?.provider_ack?.servidor_em ?? null,
    erroProvider: m.metadados?.provider_erro?.codigo ?? null,
    entregaIncertaEm: m.entrega_incerta_em ?? null,
    expiraEm: m.expira_em ?? null,
    motivoCancelamento: m.status === STATUS_MENSAGEM.CANCELLED ? (erroCurto(m.erro) ?? null) : null,
    erroPermanente: m.erro_permanente === true,
    tentativasDetalhe: (tentativas ?? []).map((t) => ({
      numero: t.tentativa_numero, iniciadoEm: t.iniciado_em ?? null, finalizadoEm: t.finalizado_em ?? null, resultado: t.resultado ?? null,
      classificacao: t.erro_classificacao ?? null, erro: erroCurto(t.erro_sanitizado),
    })),
  };
}

/**
 * GET /administrativo/comunicacao/configuracao-operacional — SOMENTE LEITURA (nada aqui é editável por esta tela). Mostra o que o sistema aplica de
 * verdade: valores de comunicacao_configuracoes (com os padrões do código) e as constantes do reforço D-1. Nada inventado.
 */
export async function configuracaoOperacional(deps = {}) {
  const [janelas, cooldowns, limites, ttlHoras, jitterMaxMs, disponibilidade] = await Promise.all([
    obterConfig("janelas", deps), obterConfig("cooldowns_horas", deps), obterConfig("limites", deps), obterTtlHoras(deps), obterJitterMaxMs(deps), obterDisponibilidadeIfood(deps),
  ]);
  const hhmm = (h) => `${String(h.hora).padStart(2, "0")}:${String(h.minuto).padStart(2, "0")}`;
  return {
    somenteLeitura: true,
    tiposDeAlerta: Object.values(TIPOS_ALERTA),
    janelaComercial: janelas ?? null,
    // regra do D-1 do iFood: antes de `dadosDisponiveisApos` a empresa não é cobrada; os lembretes só saem a partir de `enviosPermitidosApos`
    disponibilidadeIfood: { dadosDisponiveisApos: disponibilidade.dados_disponiveis_apos, enviosPermitidosApos: disponibilidade.envios_permitidos_apos },
    reforcoD1: { janela: `${hhmm(JANELA_REFORCO.inicio)}–${hhmm(JANELA_REFORCO.fim)}`, cutoff: hhmm(CUTOFF_REFORCO), espacamentoMinimoHoras: ESPACAMENTO_MINIMO_HORAS, diasUteis: "segunda a sábado" },
    cooldownsHoras: cooldowns ?? null,
    limites: limites ?? null,
    validadeDaMensagemHoras: ttlHoras,
    espalhamentoMaximoMinutos: Math.round(jitterMaxMs / 60_000),
    observacao: "Timezone, tipo de alerta e pausa são configurados por empresa. Os demais valores são globais e não são editáveis por esta tela.",
  };
}
