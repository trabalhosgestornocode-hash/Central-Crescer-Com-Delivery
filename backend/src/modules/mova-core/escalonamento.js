// MOVA CORE — §4: ESCALONAMENTO para um modelo de raciocínio maior, SÓ EM HOMOLOGAÇÃO e decidido pelo SERVIDOR (nunca pelo modelo).
// Haiku continua o modelo principal. O escalonamento acontece DEPOIS da tentativa do Haiku, só quando há sinal objetivo de que
// faltou raciocínio — e nunca para "resolver" falta de dado, falta de permissão, operação proibida ou escrita.
// O modelo maior recebe a MESMA conversa, com as consultas que o Haiku já fez (não repete leituras), e roda dentro do teto
// por requisição do orçamento. Opus nunca é aceito aqui.
export const MOTIVOS_QUE_ESCALAM = Object.freeze(new Set(["VERIFICADOR_REPROVOU", "RESPOSTA_PARCIAL_CONFERIDA", "PASSOS_ESGOTADOS", "LIMITE_DE_SAIDA"]));
const NUNCA_ESCALA_MOTIVO = new Set(["ORCAMENTO_ESGOTADO", "ORCAMENTO_INDISPONIVEL", "LIMITE_DA_REQUISICAO", "IA_INDISPONIVEL", "RECUSA_DO_MODELO"]);
const AUSENCIA = new Set(["SEM_REGISTROS", "INDISPONIVEL", "BLOQUEADO", "NAO_CALCULAVEL", "FALHA_TECNICA"]);
const CODIGOS_DE_REGRA = new Set(["FORA_DO_ESCOPO", "SEM_PERMISSAO", "SEM_PERMISSAO_DE_VALORES", "OPERACAO_PROIBIDA", "MODULO_INDISPONIVEL", "FINANCEIRO_INDISPONIVEL", "NAO_ENCONTRADO_OU_INVALIDO"]);
const CODIGOS_DE_RACIOCINIO = new Set(["ARGUMENTO_INVALIDO", "REFERENCIA_INVALIDA", "FERRAMENTA_DESCONHECIDA"]);
const DE_ESCRITA = new Set(["preparar_operacao", "sugerir_conhecimento", "preparar_registro"]);

/** Configuração de homologação: MOVA_CORE_ESCALONAMENTO=1 e modelo permitido (só Sonnet). Produção: sempre desligado. */
export function configuracaoDeEscalonamento(env = {}) {
  const modelo = env.MOVA_CORE_ESCALONAMENTO_MODELO ?? "claude-sonnet-5-5";
  const habilitado = env.MOVA_CORE_ESCALONAMENTO === "1" && /^claude-sonnet-/.test(modelo) && env.MOVA_AMBIENTE !== "PRODUCAO";
  return Object.freeze({ habilitado, modelo, esforco: "medium", maxPassos: 4 });
}

/**
 * @param {object} r resultado do laço do Haiku (motivo, ferramentas[{nome, ok, codigo}])
 * @param {object} sessao sessao.situacoes = [{ferramenta, situacao, codigo}]
 * @returns {{escalar:boolean, motivo:string}}
 */
export function decidirEscalonamento({ r, sessao, config }) {
  if (!config?.habilitado) return { escalar: false, motivo: "DESLIGADO" };
  if (/opus/i.test(config.modelo ?? "")) return { escalar: false, motivo: "MODELO_NAO_PERMITIDO" };
  const ferramentas = r?.ferramentas ?? [];
  if (NUNCA_ESCALA_MOTIVO.has(r?.motivo)) return { escalar: false, motivo: `NAO_ESCALA_${r.motivo}` };
  if (ferramentas.some((f) => DE_ESCRITA.has(f.nome))) return { escalar: false, motivo: "ESCRITA_OU_PROPOSTA" };
  if (ferramentas.some((f) => CODIGOS_DE_REGRA.has(f.codigo))) return { escalar: false, motivo: "PERMISSAO_OU_REGRA" };
  const situacoes = (sessao?.situacoes ?? []).map((s) => s.situacao).filter(Boolean);
  // tudo o que foi consultado voltou como AUSÊNCIA (sem registros, indisponível, bloqueado…): um modelo maior não cria o dado
  if (situacoes.length && situacoes.every((s) => AUSENCIA.has(s))) return { escalar: false, motivo: "FALTA_DE_DADOS" };
  if (MOTIVOS_QUE_ESCALAM.has(r?.motivo)) return { escalar: true, motivo: r.motivo };
  if (ferramentas.filter((f) => CODIGOS_DE_RACIOCINIO.has(f.codigo)).length >= 2) return { escalar: true, motivo: "ERROS_DE_ARGUMENTO" };
  return { escalar: false, motivo: "RESPOSTA_SUFICIENTE" };
}

/** Continua a conversa do Haiku: só blocos de texto e de ferramenta (nada específico de um modelo atravessa). */
export function mensagensParaEscalonar(mensagens, motivo) {
  const limpar = (c) => (Array.isArray(c) ? c.filter((b) => ["text", "tool_use", "tool_result"].includes(b.type)) : c);
  const m = mensagens.map((x) => ({ role: x.role, content: limpar(x.content) })).filter((x) => (Array.isArray(x.content) ? x.content.length : String(x.content ?? "").length));
  // a última tentativa (texto reprovado) sai: o modelo maior responde a partir da pergunta e das consultas
  // (e o pedido de correção do verificador que veio depois dela)
  const ehCorrecao = (x) => x.role === "user" && typeof x.content === "string" && /^\[conferência automática\]/.test(x.content);
  const ehTextoFinal = (x) => x.role === "assistant" && !(Array.isArray(x.content) && x.content.some((b) => b.type === "tool_use"));
  while (m.length && (ehCorrecao(m.at(-1)) || ehTextoFinal(m.at(-1)))) m.pop();
  const aviso = { type: "text", text: `[servidor] Esta pergunta precisa de mais cuidado (${motivo}). Use as consultas já feitas acima (consulte de novo só o que faltar) e responda com números exatamente iguais aos das consultas.` };
  const ult = m.at(-1);
  if (ult?.role === "user") ult.content = [...(Array.isArray(ult.content) ? ult.content : [{ type: "text", text: String(ult.content) }]), aviso];
  else m.push({ role: "user", content: [aviso] });
  return m;
}
