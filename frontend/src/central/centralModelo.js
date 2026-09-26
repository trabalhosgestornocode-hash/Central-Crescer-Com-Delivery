// CENTRAL DE COMUNICAÇÃO — modelo PURO (sem DOM, sem rede): vocabulário de negócio, trilha de entrega, datas, agrupamento de mensagens por "voz" e mesclagem.
// Tudo o que a tela decide sobre COMO MOSTRAR mora aqui, para ser testado sem navegador. QUEM aparece nunca é decidido aqui: isso é do backend.
//
// REGRA CENTRAL: "Enviada ao WhatsApp" (SENT) NUNCA é "Entregue". A trilha tem 3 marcas — enviada, entregue, lida — e cada uma só acende com o seu próprio fato.

export const TEXTO_MAX = 4096;

/** Estados de uma mensagem enviada, em linguagem de negócio (o enum do banco não é renomeado). */
export const ROTULO_STATUS = Object.freeze({
  SCHEDULED: "Agendada", PROCESSING: "Enviando", SENDING: "Enviando", SENT: "Enviada ao WhatsApp", DELIVERED: "Entregue", READ: "Lida",
  FAILED: "Falhou", DELIVERY_UNKNOWN: "Entrega não confirmada", CANCELLED: "Cancelada", BLOCKED: "Bloqueada",
});

/** O que cada estado significa de verdade — vai no tooltip da trilha. */
export const DICA_STATUS = Object.freeze({
  SCHEDULED: "Programada para um horário permitido. Ainda não saiu.",
  PROCESSING: "Sendo preparada para envio.",
  SENDING: "Saindo agora para o WhatsApp.",
  SENT: "O WhatsApp recebeu o pedido de envio, mas a entrega ao aparelho do responsável ainda não foi confirmada.",
  DELIVERED: "O WhatsApp confirmou que a mensagem chegou ao aparelho do responsável.",
  READ: "O responsável abriu e leu a mensagem.",
  FAILED: "A mensagem não foi enviada. Nenhuma nova tentativa é feita sozinha.",
  DELIVERY_UNKNOWN: "Não foi possível confirmar se a mensagem saiu. Nenhum reenvio é feito sozinho.",
  CANCELLED: "A mensagem foi cancelada antes de sair.",
  BLOCKED: "A mensagem foi barrada por uma regra de segurança e não saiu.",
});

/** Origem/voz de uma mensagem. `recebida` = o responsável; as demais são a equipe ou a automação. */
export const ROTULO_CATEGORIA = Object.freeze({ recebida: "Responsável", manual: "Equipe", automatica: "Automática", teste: "Teste" });

export const ROTULO_ORIGEM = Object.freeze({
  contato: "Responsável", manual_painel: "Equipe", automacao: "Automática", reforco: "Reforço automático", aviso_tardio: "Aviso tardio automático", teste_controlado: "Teste controlado",
});

export const FILTROS_CONVERSA = Object.freeze([
  ["todas", "Todas"], ["nao_lidas", "Não lidas"], ["pendencias", "Pendências"], ["automacao", "Automação"], ["humano", "Atendimento humano"],
]);

export const ABAS = Object.freeze([
  ["visao-geral", "Visão geral"], ["conversas", "Conversas"], ["empresas", "Empresas"], ["automacoes", "Automações"], ["historico", "Histórico"], ["destinatarios", "Destinatários"], ["conexao", "Conexão"], ["configuracoes", "Configurações"],
]);

// ---------------------------------------------------------------------------
// Conexão (identidade do WhatsApp)
// ---------------------------------------------------------------------------

/** Os 6 estados da sessão, em linguagem de negócio (o backend já manda o rótulo; isto cobre estados vindos de fora e o vocabulário fechado). */
export const ROTULO_ESTADO_CONEXAO = Object.freeze({
  CONNECTED: "Conectado", DISCONNECTED: "Desconectado", CONNECTING: "Conectando", WAITING_QR: "Aguardando leitura do QR Code", RECONNECTING: "Reconectando", AUTH_ERROR: "Sessão inválida",
});
/** Tom visual de cada estado (a cor nunca é a única pista: sempre há o texto). */
export const TOM_ESTADO_CONEXAO = Object.freeze({ CONNECTED: "ok", DISCONNECTED: "neutro", CONNECTING: "atencao", WAITING_QR: "atencao", RECONNECTING: "atencao", AUTH_ERROR: "critico" });

/** As 5 etapas VISÍVEIS do assistente (as fases internas — preparando, gerando, validando, perfil — ficam dentro da etapa a que pertencem). */
export const PASSOS_ASSISTENTE = Object.freeze([
  ["iniciar", "Iniciar conexão"], ["escanear", "Escanear QR Code"], ["identificada", "Conta identificada"], ["confirmar", "Confirmar identidade"], ["concluida", "Conexão concluída"],
]);
/** Fase interna → índice (0..4) da etapa visível em andamento. `identificado` = aguardando a confirmação do operador (4ª etapa). `concluida` marca todas como feitas. */
const INDICE_FASE = Object.freeze({ iniciando: 0, gerando: 0, aguardando: 1, expirado: 1, validando: 2, perfil: 2, identificado: 3, concluida: 5, erro: -1 });
export const FASES_EM_ANDAMENTO = Object.freeze(["iniciando", "gerando", "aguardando", "expirado", "validando", "perfil"]);

/** Etapa visível (0..4) em que uma fase interna falha/está — usado para marcar o erro na etapa certa. */
export const etapaDaFase = (fase) => ({ iniciando: 0, gerando: 0, aguardando: 1, expirado: 1, validando: 2, perfil: 2, identificado: 3, concluida: 4 })[fase] ?? 0;

/** @returns {Array<{id: string, rotulo: string, estado: 'feito'|'ativo'|'pendente'|'erro'}>} */
export function passosDoAssistente(fase, { falhouEm = null } = {}) {
  const i = INDICE_FASE[fase] ?? 0;
  return PASSOS_ASSISTENTE.map(([id, rotulo], n) => {
    if (fase === "erro") return { id, rotulo, estado: n < (falhouEm ?? 0) ? "feito" : n === (falhouEm ?? 0) ? "erro" : "pendente" };
    if (fase === "concluida") return { id, rotulo, estado: "feito" };
    return { id, rotulo, estado: n < i ? "feito" : n === i ? "ativo" : "pendente" };
  });
}

/** "há poucos segundos", "há 3 min", "há 2 h", "ontem"… — para indicadores de última comunicação. Vazio/inválido ⇒ "". */
export function haQuanto(iso, agora = new Date()) {
  const d = dt(iso); if (!d) return "";
  const seg = Math.max(0, Math.round(((agora instanceof Date ? agora.getTime() : Number(agora)) - d.getTime()) / 1000));
  if (seg < 45) return "há poucos segundos";
  if (seg < 90) return "há 1 min";
  if (seg < 3600) return `há ${Math.round(seg / 60)} min`;
  if (seg < 86_400) return `há ${Math.round(seg / 3600)} h`;
  return dataHoraCurta(iso, agora);
}

/** Saúde da conexão em linguagem humana, a partir de `c.saude` (só o que o backend informa). */
export function saudeDaConexao(c, agora = new Date()) {
  const s = c?.saude ?? {};
  if (c?.estado !== "CONNECTED") return { id: "sem_sinal", tom: "neutro", texto: "Sem conexão ativa", detalhe: s.ultimoSinalEm ? `Último sinal ${haQuanto(s.ultimoSinalEm, agora)}` : "" };
  if (s.id === "saudavel") return { id: "estavel", tom: "ok", texto: "Conexão estável", detalhe: s.ultimoSinalEm ? `Última comunicação ${haQuanto(s.ultimoSinalEm, agora)}` : "" };
  if (s.id === "atencao") return { id: "atrasada", tom: "atencao", texto: "Sinal atrasado", detalhe: s.ultimoSinalEm ? `Última comunicação ${haQuanto(s.ultimoSinalEm, agora)}` : "O Gateway demorou a responder." };
  return { id: "sem_sinal", tom: "neutro", texto: "Sem sinal recente", detalhe: "" };
}
const ESPERA_GERANDO_MS = 12_000;   // sem QR e sem conexão por mais que isto: o pareamento não abriu — tratamos como expirado/falha

/**
 * Próxima fase do assistente a partir da resposta do backend (`GET .../conexao/qr`). Pura.
 *  - conta conectada (`identificada`) ⇒ validando (depois perfil e identificado, com um respiro para a tela contar a história)
 *  - QR disponível ⇒ aguardando
 *  - sem QR e sem conexão: enquanto for cedo ⇒ continua gerando; passou do prazo (ou o Gateway ficou DISCONNECTED/AUTH_ERROR depois de ter tido QR) ⇒ expirado
 * Nunca volta de `identificado`/`concluida`/`erro`.
 */
export function proximaFase(atual, resp, { agora = Date.now(), desde = agora } = {}) {
  if (["identificado", "concluida", "erro"].includes(atual)) return atual;
  if (resp?.identificada === true || resp?.estado === "CONNECTED") return atual === "perfil" ? "perfil" : "validando";
  if (resp?.disponivel === true) return "aguardando";
  const parado = resp?.estado === "DISCONNECTED" || resp?.estado === "AUTH_ERROR";
  if (atual === "aguardando" || atual === "expirado") return "expirado";
  if (parado && agora - desde > ESPERA_GERANDO_MS) return "expirado";
  if (atual === "iniciando") return "gerando";
  if (agora - desde > ESPERA_GERANDO_MS * 2) return "expirado";
  return "gerando";
}

/** Contagem regressiva do QR: segundos que faltam e fração (1 → 0) para o anel. O 1º QR do socket vive ~60 s; os seguintes ~20 s. */
export function progressoQr(expiraEm, ordem = 1, agora = Date.now()) {
  const fim = Date.parse(expiraEm); if (!Number.isFinite(fim)) return { restante: 0, fracao: 0 };
  const vida = (ordem ?? 1) <= 1 ? 60 : 20;
  const restante = Math.max(0, Math.ceil((fim - agora) / 1000));
  return { restante, fracao: Math.max(0, Math.min(1, restante / vida)) };
}

/** Situação da identidade em palavras (Conexão e Visão geral). */
export const ROTULO_IDENTIDADE = Object.freeze({ SEM_CONTA: "Sem conta", PENDENTE_CONFIRMACAO: "Aguardando confirmação", CONFIRMADA: "Confirmada" });

// ---------------------------------------------------------------------------
// Trilha de entrega (3 marcas)
// ---------------------------------------------------------------------------

/**
 * @typedef {'feito'|'andamento'|'pendente'|'falha'|'atencao'|'cancelado'} EstadoMarca
 * @returns {Array<{id: 'enviada'|'entregue'|'lida', estado: EstadoMarca, rotulo: string, dica: string}>}
 */
export function trilhaDe(status) {
  const marca = (id, estado, rotulo, dica) => ({ id, estado, rotulo, dica });
  const E = "Enviada ao WhatsApp"; const D = "Entregue"; const L = "Lida";
  const dE = "O WhatsApp recebeu o pedido de envio."; const dD = "O WhatsApp confirmou a entrega no aparelho do responsável."; const dL = "O responsável abriu a mensagem.";
  const pendenteD = "A entrega ainda não foi confirmada."; const pendenteL = "Ainda não foi lida.";
  switch (status) {
    case "READ": return [marca("enviada", "feito", E, dE), marca("entregue", "feito", D, dD), marca("lida", "feito", L, dL)];
    case "DELIVERED": return [marca("enviada", "feito", E, dE), marca("entregue", "feito", D, dD), marca("lida", "pendente", L, pendenteL)];
    case "SENT": return [marca("enviada", "feito", E, dE), marca("entregue", "pendente", D, pendenteD), marca("lida", "pendente", L, pendenteL)];
    case "PROCESSING": case "SENDING":
      return [marca("enviada", "andamento", "Enviando", "Saindo agora para o WhatsApp."), marca("entregue", "pendente", D, pendenteD), marca("lida", "pendente", L, pendenteL)];
    case "DELIVERY_UNKNOWN":
      return [marca("enviada", "atencao", "Entrega não confirmada", DICA_STATUS.DELIVERY_UNKNOWN), marca("entregue", "pendente", D, pendenteD), marca("lida", "pendente", L, pendenteL)];
    case "FAILED": return [marca("enviada", "falha", "Falhou", DICA_STATUS.FAILED), marca("entregue", "pendente", D, "Não se aplica."), marca("lida", "pendente", L, "Não se aplica.")];
    case "CANCELLED": case "BLOCKED":
      return [marca("enviada", "cancelado", ROTULO_STATUS[status], DICA_STATUS[status]), marca("entregue", "pendente", D, "Não se aplica."), marca("lida", "pendente", L, "Não se aplica.")];
    case "SCHEDULED":
    default: return [marca("enviada", "pendente", "Agendada", DICA_STATUS.SCHEDULED), marca("entregue", "pendente", D, pendenteD), marca("lida", "pendente", L, pendenteL)];
  }
}

export const rotuloStatus = (status) => ROTULO_STATUS[status] ?? String(status ?? "");

/**
 * Rótulo VISÍVEL (texto, não só cor/tooltip) do último estado COMPROVADO de uma mensagem enviada: "Enviada", "Entregue 10:32", "Lida 10:35".
 * Regras: o estado vem só do `status` (que o banco só avança com receipt real do provider); a hora vem só do carimbo do PRÓPRIO estado
 * (entregueEm / lidoEm) e é omitida quando não existe — nunca se inventa hora nem se infere "Lida". Outros estados não têm rótulo aqui ("").
 * @param {{status?: string, entregueEm?: string|null, lidoEm?: string|null}} m
 */
export function rotuloEntrega(m) {
  const com = (base, iso) => { const h = horaLocal(iso); return h ? `${base} ${h}` : base; };
  switch (m?.status) {
    case "READ": return com("Lida", m.lidoEm);
    case "DELIVERED": return com("Entregue", m.entregueEm);
    case "SENT": return "Enviada";
    default: return "";
  }
}
export const dicaStatus = (status) => DICA_STATUS[status] ?? "";
/** Estados em que a mensagem ainda pode mudar (a tela mantém o acompanhamento). */
export const statusEmAndamento = (status) => ["SCHEDULED", "PROCESSING", "SENDING", "SENT", "DELIVERED"].includes(status);

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
/** Só texto ISO ou Date: `null`/`undefined`/número NÃO viram data (new Date(null) seria 1970). */
const dt = (iso) => { if (typeof iso !== "string" && !(iso instanceof Date)) return null; const d = new Date(iso); return Number.isFinite(d.getTime()) ? d : null; };
const chaveDia = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const doisDigitos = (n) => String(n).padStart(2, "0");

/** "14:05" no fuso do navegador do operador. */
export function horaLocal(iso) {
  const d = dt(iso);
  return d ? `${doisDigitos(d.getHours())}:${doisDigitos(d.getMinutes())}` : "";
}

/** Separador de dia da conversa: "Hoje", "Ontem" ou "12 de setembro". */
export function rotuloDia(iso, agora = new Date()) {
  const d = dt(iso); if (!d) return "";
  const hoje = new Date(agora); const ontem = new Date(agora); ontem.setDate(ontem.getDate() - 1);
  if (chaveDia(d) === chaveDia(hoje)) return "Hoje";
  if (chaveDia(d) === chaveDia(ontem)) return "Ontem";
  return `${d.getDate()} de ${MESES[d.getMonth()]}${d.getFullYear() !== hoje.getFullYear() ? ` de ${d.getFullYear()}` : ""}`;
}

/** Horário curto para a lista: hora se for hoje, "Ontem" ou dd/mm. */
export function horarioCurto(iso, agora = new Date()) {
  const d = dt(iso); if (!d) return "";
  const r = rotuloDia(iso, agora);
  if (r === "Hoje") return horaLocal(iso);
  if (r === "Ontem") return "Ontem";
  return `${doisDigitos(d.getDate())}/${doisDigitos(d.getMonth() + 1)}`;
}

/** "Hoje, 14:05" / "Ontem, 09:10" / "12/09, 08:00" — para painéis e tabelas. */
export function dataHoraCurta(iso, agora = new Date()) {
  const d = dt(iso); if (!d) return "";
  const h = horaLocal(iso);
  const r = rotuloDia(iso, agora);
  if (r === "Hoje" || r === "Ontem") return `${r}, ${h}`;
  return `${doisDigitos(d.getDate())}/${doisDigitos(d.getMonth() + 1)}, ${h}`;
}

// ---------------------------------------------------------------------------
// Conversa: agrupamento por voz, mesclagem, envio otimista
// ---------------------------------------------------------------------------

const JANELA_GRUPO_MS = 5 * 60_000;
const voz = (m) => `${m.direcao}|${m.categoria}|${m.operador ?? ""}`;

/**
 * Blocos de renderização: separadores de dia e grupos de mensagens consecutivas da MESMA voz (mesma direção, categoria e operador) em até 5 minutos.
 * A meta (quem falou) aparece uma vez por grupo — a bolha em si fica limpa.
 * @returns {Array<{tipo: 'dia', rotulo: string, chave: string} | {tipo: 'grupo', direcao: string, categoria: string, operador: string|null, itens: object[]}>}
 */
export function blocosDaConversa(mensagens, agora = new Date()) {
  const blocos = [];
  let diaAtual = null; let grupo = null; let ultimoEm = 0;
  for (const m of mensagens ?? []) {
    const d = dt(m.em);
    const dia = d ? chaveDia(d) : "?";
    if (dia !== diaAtual) {
      diaAtual = dia; grupo = null;
      blocos.push({ tipo: "dia", rotulo: rotuloDia(m.em, agora), chave: dia });
    }
    const t = d ? d.getTime() : 0;
    if (grupo && voz(grupo.itens[0]) === voz(m) && t - ultimoEm <= JANELA_GRUPO_MS) grupo.itens.push(m);
    else { grupo = { tipo: "grupo", direcao: m.direcao, categoria: m.categoria, operador: m.operador ?? null, itens: [m] }; blocos.push(grupo); }
    ultimoEm = t;
  }
  return blocos;
}

const tempo = (m) => {
  const d = dt(m.em);
  const fracao = /\.(\d+)(?:Z|[+-])/.exec(String(m.em))?.[1] ?? "";
  return d ? d.getTime() * 1000 + Number(fracao.slice(3, 6).padEnd(3, "0")) : 0;
};
const compararTexto = (a, b) => a === b ? 0 : a < b ? -1 : 1;

/**
 * Mescla mensagens novas na lista atual por `id` (a nova substitui a antiga — é assim que SENT vira DELIVERED sem duplicar) e reordena por horário.
 * Uma mensagem otimista (`id` começando com "local:") some quando chega a definitiva com o mesmo `envioId`.
 */
export function mesclarMensagens(atuais, novas) {
  const porId = new Map();
  for (const m of atuais ?? []) porId.set(m.id, m);
  for (const m of novas ?? []) {
    if (m.envioId) for (const [id, x] of porId) if (x.envioId === m.envioId && id !== m.id) porId.delete(id);
    porId.set(m.id, m);
  }
  return [...porId.values()].sort((a, b) => tempo(a) - tempo(b) || compararTexto(a.direcao ?? "", b.direcao ?? "") || compararTexto(a.id, b.id));
}

/** Bolha "enviando…" mostrada no instante do clique, antes de o servidor responder. */
export function mensagemOtimista({ envioId, texto, operador = null, agora = new Date() }) {
  const iso = agora.toISOString();
  return {
    id: `local:${envioId}`, envioId, direcao: "saida", categoria: "manual", origem: "manual_painel", tipo: "texto", texto, status: "SENDING",
    em: iso, criadoEm: iso, enviadoEm: null, entregueEm: null, lidoEm: null, falhouEm: null, erro: null, operador, local: true,
  };
}

/** Marca uma mensagem local como falha de rede (o servidor pode ou não ter recebido: o reenvio usa o MESMO envioId, então nunca duplica). */
export const comoFalhaLocal = (m, erro) => ({ ...m, status: "FAILED", erro, falhaLocal: true });

export function novoEnvioId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback determinístico o bastante para idempotência de UMA tela (nunca é usado como segredo).
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

/** O texto pode ser enviado? (não vazio depois de aparado, dentro do limite) */
export function textoEnviavel(texto) {
  if (typeof texto !== "string") return false;
  const t = texto.trim();
  return t.length > 0 && Array.from(t).length <= TEXTO_MAX;
}

export const caracteres = (texto) => Array.from(String(texto ?? "")).length;

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

/** Matiz estável (0-359) derivado do id: o mesmo responsável tem sempre a mesma cor de avatar. */
export function matizDe(id) {
  let h = 0;
  for (const ch of String(id ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

/** Texto curto de "faltam N unidades" para os chips: mostra até `max` e resume o resto. */
export function resumirLista(itens, max = 3) {
  const lista = itens ?? [];
  return { visiveis: lista.slice(0, max), resto: Math.max(0, lista.length - max) };
}

const pluralAssoc = (n, s, p) => `${n} ${n === 1 ? s : p}`;

/**
 * Resumo das empresas/unidades do responsável para o CABEÇALHO da conversa. O cabeçalho tem altura controlada: NUNCA lista tudo.
 * Devolve o rótulo com a QUANTIDADE, até `max` unidades para chips e `resto` (o "+N"); a lista completa vive no painel de detalhes.
 * `resto` = unidades que NÃO viraram chip (o "+N"); sem unidades não há chips, logo não há "+N" (o rótulo já traz a contagem de empresas). `total` = maior das duas contagens.
 * @returns {{rotulo: string, nEmpresas: number, nUnidades: number, total: number, unidades: Array<{nome: string}>, resto: number}}
 */
export function resumoAssociacoes(contato, { max = 3 } = {}) {
  const empresas = contato?.empresas ?? [];
  const unidades = contato?.unidades ?? [];
  const nEmpresas = empresas.length; const nUnidades = unidades.length;
  const { visiveis } = resumirLista(unidades, max);
  let rotulo;
  if (!nEmpresas && !nUnidades) rotulo = "Sem empresa vinculada";
  else if (nEmpresas <= 1) rotulo = `${empresas[0]?.nome ?? "Empresa"}${nUnidades > max ? ` · ${pluralAssoc(nUnidades, "unidade", "unidades")}` : ""}`;
  else if (!nUnidades) rotulo = pluralAssoc(nEmpresas, "empresa associada", "empresas associadas");
  else if (nEmpresas === nUnidades) rotulo = pluralAssoc(nUnidades, "unidade associada", "unidades associadas");
  else rotulo = `${pluralAssoc(nEmpresas, "empresa", "empresas")} · ${pluralAssoc(nUnidades, "unidade associada", "unidades associadas")}`;
  return { rotulo, nEmpresas, nUnidades, total: Math.max(nEmpresas, nUnidades), unidades: visiveis, resto: nUnidades ? Math.max(0, nUnidades - visiveis.length) : 0 };
}

/** O fluxo de mensagens está encostado no fim (a menos de `limite` px)? Aceita qualquer objeto com scrollHeight/scrollTop/clientHeight. */
export function estaNoFim(el, limite = 90) {
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < limite;
}

/** Situação do contato para a coluna de contexto: cada item é um FATO do cadastro, nunca inventado. */
export function situacaoDoContato(c) {
  return [
    { id: "consentimento", rotulo: "Consentimento", ok: c?.consentimento === true, texto: c?.consentimento === true ? "Confirmado" : "Pendente" },
    { id: "verificado", rotulo: "Número verificado", ok: c?.verificado === true, texto: c?.verificado === true ? "Verificado" : "Não verificado" },
    { id: "optout", rotulo: "Pediu para parar", ok: c?.optOut !== true, texto: c?.optOut === true ? "Sim, não enviar" : "Não" },
  ];
}

/**
 * Cursor de atualização ("inbox|saida", ISO ou vazio). MONOTÔNICO: o cursor do cliente nunca anda para trás — uma resposta atrasada/fora de ordem (duas requisições
 * em voo, rede lenta, purga que baixou o máximo) não pode fazer a tela reprocessar o que já viu. Cada metade avança independente; entrada inválida mantém o atual.
 * @param {string|null|undefined} atual @param {string|null|undefined} novo @returns {string|null}
 */
export function avancarCursor(atual, novo) {
  const RE = /^([^|]*)\|([^|]*)$/;
  const a = RE.exec(String(atual ?? "")); const n = RE.exec(String(novo ?? ""));
  if (!n) return atual ?? null;
  if (!a) return novo;
  const ms = (t) => { const v = Date.parse(t); return Number.isFinite(v) ? v : -Infinity; };
  const maior = (x, y) => (ms(y) > ms(x) ? y : x);
  return `${maior(a[1], n[1])}|${maior(a[2], n[2])}`;
}
