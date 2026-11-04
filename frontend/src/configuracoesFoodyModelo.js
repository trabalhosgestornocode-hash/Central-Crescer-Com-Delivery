// Foody Delivery (Configurações → Integrações) — regras PURAS da tela, sem DOM (testáveis em node).
// O servidor decide tudo (permissão, flag, banco); aqui só traduzimos o estado em rótulos e escondemos o que ele recusaria.

export const OPERACOES = { subway: "Subway", acai_no_grau: "Açaí no Grau" };

export const STATUS_CONEXAO = {
  ATIVA: ["ok", "Ativa"],
  PAUSADA: ["warn", "Pausada"],
  ERRO: ["bad", "Com erro"],
  REVOGADA: ["bad", "Revogada"],
};
export const ESTADO_VINCULO = {
  PENDENTE: ["warn", "Aguardando aprovação"],
  ATIVO: ["ok", "Ativo"],
  REVOGADO: ["muted", "Revogado"],
};
const EVENTO_CONEXAO = {
  CADASTRADA: "Conexão cadastrada", RECONECTADA: "Conexão refeita com novo token", TOKEN_SUBSTITUIDO: "Token substituído",
  ATIVADA: "Conexão ativada", PAUSADA: "Conexão pausada", REVOGADA: "Conexão revogada",
  PONTO_COLETA_ALTERADO: "Ponto de coleta alterado", PAUSADA_POR_TRANSFERENCIA: "Pausada: a unidade mudou de empresa",
};
const EVENTO_VINCULO = {
  PROPOSTO: "Compartilhamento proposto", APROVADO_TITULAR: "Aprovado pela empresa titular", APROVADO_DESTINO: "Aprovado pela empresa destino",
  ATIVADO: "Compartilhamento ativado", REVOGADO: "Compartilhamento revogado",
};
const MOTIVO_TRIAGEM = {
  SEM_EVIDENCIA: "Nenhum item reconhecido",
  ITEM_DESCONHECIDO: "Item fora do catálogo",
  CONFLITO: "Itens das duas operações",
};

export const rotuloOperacao = (op) => OPERACOES[op] ?? String(op ?? "—");
export const rotuloEvento = (e) => (e?.tipo === "compartilhamento" ? EVENTO_VINCULO : EVENTO_CONEXAO)[e?.evento] ?? String(e?.evento ?? "Evento");
export const rotuloMotivoTriagem = (m) => MOTIVO_TRIAGEM[m] ?? "Precisa de conferência";
export const rotuloAtor = (a, emNomeDe = null) => {
  const base = a === "voce" ? "Você" : a === "automatico" ? "Automático (sistema)" : "Outro administrador";
  return emNomeDe && a !== "automatico" ? `${base} · ${emNomeDe}` : base;
};

// Mensagens por código do servidor: o que aconteceu + o que fazer. Sem código conhecido, a mensagem do próprio servidor.
const MENSAGENS = {
  SEM_PERMISSAO: "Só um Administrador ativo da empresa pode fazer isso.",
  TOKEN_INVALIDO: "Token inválido: confira e cole de novo (sem espaços).",
  MOTIVO_INVALIDO: "Escreva o motivo (de 3 a 300 caracteres).",
  CONEXAO_EXISTENTE: "Esta unidade já tem conexão. Use “Substituir token”.",
  CONTA_JA_CONECTADA: "Esta conta Foody já está conectada a outra unidade. Para usá-la em outra empresa, use o compartilhamento.",
  DESTINO_VIVO: "Esta unidade já recebe pedidos Foody por compartilhamento. Revogue o compartilhamento antes de conectar uma conta própria.",
  COMPARTILHAMENTO_VIVO: "Há compartilhamento vivo nesta conexão. Revogue o compartilhamento antes de trocar o token.",
  CONEXAO_REVOGADA: "A conexão foi revogada. Cadastre um token novo para reconectar.",
  CONEXAO_INATIVA: "A conexão precisa estar ativa para propor um compartilhamento.",
  DESTINO_NAO_PERMITIDO: "Você só pode propor para empresas em que também tem acesso.",
  SEGREDO_AUSENTE: "A chave de proteção da integração não está configurada no servidor. Fale com o suporte da Crescer.",
  ATO_SEPARADO: "A aprovação precisa ser feita no contexto da outra empresa.",
  VINCULO_EXISTENTE: "Já existe um compartilhamento para esta operação.",
  DESTINO_JA_VINCULADO: "Esta unidade já recebe esta operação de outra conexão.",
  DESTINO_COM_CONEXAO_PROPRIA: "A unidade de destino tem conexão Foody própria; revogue-a antes de compartilhar.",
  SEM_UNIDADE: "Escolha uma unidade no seletor do topo.",
  LIMITE: "Muitas tentativas. Aguarde alguns minutos e tente de novo.",
};
export function mensagemDeErro(e) {
  if (e?.status === 429) return MENSAGENS.LIMITE;
  return MENSAGENS[e?.codigo] ?? String(e?.message || "Não foi possível concluir. Tente de novo.");
}

export function validarToken(token) {
  const t = String(token ?? "").trim();
  if (!t) return "Cole o token da conta Foody.";
  if (t.length < 8 || t.length > 512 || /[\s\u0000-\u001f\u007f]/.test(t)) return MENSAGENS.TOKEN_INVALIDO;
  return null;
}
export function validarMotivo(m, { obrigatorio = true } = {}) {
  const s = String(m ?? "").trim();
  if (!s && !obrigatorio) return null;
  if (s.length < 3 || s.length > 300) return MENSAGENS.MOTIVO_INVALIDO;
  return null;
}

/** Ações da conexão que a tela oferece (o servidor confere de novo). */
export function acoesDaConexao(estado) {
  const pode = estado?.podeAdministrar === true && estado?.impersonando !== true && Boolean(estado?.unidade);
  const c = estado?.conexao;
  const vivo = (estado?.compartilhamentos ?? []).some((v) => v.papel === "titular" && v.estado !== "REVOGADO");
  const souDestino = (estado?.compartilhamentos ?? []).some((v) => v.papel === "destino" && v.estado !== "REVOGADO");
  if (!pode) return { cadastrar: false, substituir: false, ativar: false, pausar: false, revogar: false, pontoColeta: false, bloqueioCadastro: null };
  if (!c || c.status === "REVOGADA") {
    return { cadastrar: !souDestino, substituir: false, ativar: false, pausar: false, revogar: false, pontoColeta: false,
      bloqueioCadastro: souDestino ? MENSAGENS.DESTINO_VIVO : null };
  }
  return {
    cadastrar: false, substituir: !vivo, ativar: c.status === "PAUSADA" || c.status === "ERRO", pausar: c.status === "ATIVA" || c.status === "ERRO",
    revogar: true, pontoColeta: true, bloqueioCadastro: null, substituirBloqueado: vivo ? MENSAGENS.COMPARTILHAMENTO_VIVO : null,
  };
}

/** Conexões cuja triagem este contexto vê: a própria (titular) e as que compartilham com ele (destino ATIVO). */
export function conexoesDaTriagem(estado) {
  const lista = [];
  if (estado?.conexao && estado.conexao.status !== "REVOGADA") lista.push({ conexaoId: estado.conexao.id, rotulo: `Conta desta unidade (${estado.unidade?.nome ?? "unidade"})` });
  for (const v of estado?.compartilhamentos ?? []) {
    if (v.papel === "destino" && v.estado === "ATIVO" && !lista.some((x) => x.conexaoId === v.conexaoId)) {
      lista.push({ conexaoId: v.conexaoId, rotulo: `Compartilhada por ${v.titular.organizacao} — ${v.titular.unidade}` });
    }
  }
  return lista;
}

/** Destinos possíveis em lista plana para o <select> (uma opção por unidade). */
export const opcoesDeDestino = (possiveis) =>
  (possiveis ?? []).flatMap((o) => (o.unidades ?? []).map((u) => ({ valor: `${o.organizacaoId}|${u.id}`, rotulo: `${o.nome} — ${u.nome}`, organizacaoId: o.organizacaoId, unidadeId: u.id })));

export const dataHora = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
export const dataCurta = (ymd) => { const [a, m, d] = String(ymd ?? "").split("-"); return a && m && d ? `${d}/${m}/${a}` : String(ymd ?? "—"); };
