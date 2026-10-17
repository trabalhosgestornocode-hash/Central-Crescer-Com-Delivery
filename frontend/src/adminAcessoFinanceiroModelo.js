// Modelo PURO (sem DOM/rede) da tela "Acesso Financeiro" do Painel SuperAdmin.
// Só descreve e valida o que será ENVIADO ao backend; quem concede é o endpoint /plataforma/gestao-financeira/concessoes
// (que repete todas as regras). Nada aqui simula sucesso de concessão.

export const MOTIVO_MIN = 10;

export const NIVEIS = Object.freeze([
  { valor: "leitura", rotulo: "Leitura", descricao: "Consulta os relatórios financeiros autorizados." },
  { valor: "operador", rotulo: "Operador", descricao: "Consulta e realiza lançamentos financeiros." },
  { valor: "gestor", rotulo: "Gestor financeiro", descricao: "Lança, edita, concilia, fecha períodos e configura (reabrir e excluir dependem da matriz final)." },
]);
export const NIVEL_ROTULO = Object.freeze(Object.fromEntries(NIVEIS.map((n) => [n.valor, n.rotulo])));

export const SITUACAO_ROTULO = Object.freeze({ ativa: "Ativa", expirada: "Expirada", revogada: "Revogada" });
export const SITUACAO_PILL = Object.freeze({ ativa: "ok", expirada: "warn", revogada: "muted" });
export const EVENTO_ROTULO = Object.freeze({ concedida: "Concedida", alterada: "Alterada", revogada: "Revogada" });

/**
 * Situação exibida. Usa a do servidor quando existe; senão calcula (revogada > expirada > ativa).
 * @param {{situacao?:string, revogada_em?:string|null, expira_em?:string|null}} c
 */
export function situacaoDe(c, agora = Date.now()) {
  if (c?.situacao in SITUACAO_ROTULO) return c.situacao;
  if (c?.revogada_em) return "revogada";
  if (c?.expira_em && Date.parse(c.expira_em) <= agora) return "expirada";
  return "ativa";
}

/**
 * Estado das escritas informado pelo servidor (GET /concessoes/estado). Qualquer resposta que não seja
 * explicitamente `escritaLiberada === true` conta como BLOQUEADA (falha fechada).
 * @param {unknown} estado
 */
export function estadoDaEscrita(estado) {
  const liberada = estado?.escritaLiberada === true;
  return {
    liberada,
    codigo: liberada ? null : (estado?.codigo ?? "CONCESSOES_BLOQUEADAS"),
    mensagem: liberada ? "" : (estado?.mensagem ?? "A administração de concessões financeiras está bloqueada neste ambiente."),
  };
}

/**
 * Valida o formulário no cliente (conveniência — o servidor valida de novo).
 * @param {{perfilId?:string, nivel?:string, motivo?:string, expiraEm?:string}} f
 * @param {{ perfis: Array<{id:string, propria?:boolean}>, agora?: number }} ctx
 * @returns {{ ok: boolean, erros: string[] }}
 */
export function validarFormularioConcessao(f, { perfis, agora = Date.now() }) {
  const erros = [];
  const perfil = perfis.find((p) => p.id === f?.perfilId);
  if (!perfil) erros.push("Selecione um perfil.");
  else if (perfil.propria) erros.push("Autoconcessão é proibida: você não pode conceder acesso a si mesmo.");
  if (!NIVEIS.some((n) => n.valor === f?.nivel)) erros.push("Selecione o nível de acesso.");
  if (String(f?.motivo ?? "").trim().length < MOTIVO_MIN) erros.push(`Informe o motivo (mínimo ${MOTIVO_MIN} caracteres).`);
  if (f?.expiraEm) {
    const t = Date.parse(`${f.expiraEm}T23:59:59`);
    if (!Number.isFinite(t) || t <= agora) erros.push("A expiração precisa ser uma data futura.");
  }
  return { ok: erros.length === 0, erros };
}

/** Corpo enviado ao backend. O concedente NUNCA é enviado: o servidor usa o SuperAdmin autenticado. */
export function montarCorpoConcessao({ organizacaoId, unidadeId, perfilId, nivel, motivo, expiraEm, somenteFinanceiro }) {
  return {
    organizacaoId, unidadeId, perfilId, nivel, motivo: String(motivo).trim(),
    somenteFinanceiro: somenteFinanceiro === true,
    ...(expiraEm ? { expiraEm: new Date(`${expiraEm}T23:59:59`).toISOString() } : {}),
  };
}

/** Só concessões ativas podem ser revogadas. */
export const podeRevogar = (c) => situacaoDe(c) !== "revogada";

export function validarMotivoRevogacao(motivo) {
  return String(motivo ?? "").trim().length >= MOTIVO_MIN
    ? { ok: true, erros: [] }
    : { ok: false, erros: [`Informe o motivo (mínimo ${MOTIVO_MIN} caracteres).`] };
}
