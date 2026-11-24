// MOVA CORE — F1: LAÇO NATIVO DE FERRAMENTAS (tool use da API). O modelo escolhe e COMBINA ferramentas (várias por passo,
// executadas em paralelo), até 6 passos. Antes de CADA chamada ao modelo: reserva de orçamento no pior caso (sem contar com
// cache). Depois: custo real pelo uso informado. A resposta final passa pelo verificador de fidelidade; se reprovar, o modelo
// tem UMA chance de corrigir com o motivo; reprovando de novo, sai uma resposta segura (sem os números não conferidos).
import { aproveitarFatosValidos, verificarFidelidade } from "./verificador.js";
import { estimarTokensDoPedido } from "./custo.js";

export const PADROES_DO_LACO = Object.freeze({ modelo: "claude-haiku-5-5", maxPassos: 6, maxTokens: 2048, esforco: "low" });

export const INSTRUCOES = `Você é o MOVA, assistente financeiro de uma rede de lojas de delivery, falando pelo WhatsApp com uma pessoa autorizada.

Regras de dados (inegociáveis):
- Todo número, nome, data ou situação que você afirmar vem de uma ferramenta chamada AGORA nesta conversa. Nunca estime, nunca complete com suposição, nunca use conhecimento geral sobre a loja.
- Valores das ferramentas estão em CENTAVOS: 23000 = R$ 230,00. Escreva sempre "R$ 1.234,56".
- Qualquer conta derivada (diferença, média, custo por entrega, variação) é feita pela ferramenta calcular, nunca de cabeça.
- Se nenhuma ferramenta cobre o que foi perguntado (ex.: salário, previsão, estoque), diga PRIMEIRO, com clareza, que essa informação não existe no sistema. Só depois, se ajudar, ofereça o dado mais próximo deixando claro que é outra coisa (ex.: "o que existe é o fechamento semanal de entregas, que não é salário"). Se a ferramenta falhou ou voltou vazia, diga isso.
- Os identificadores ref_N são internos: use-os só nas chamadas de ferramenta, nunca na resposta.

Como trabalhar:
- Combine ferramentas livremente para responder perguntas novas; chame várias de uma vez quando forem independentes (ex.: mês atual e mês anterior).
- "Esse mês", "mês passado", "ontem", "semana passada" são relativos à data de hoje informada abaixo.
- Quando a pessoa usar "ele", "isso", "essa conta", resolva pelo que foi dito antes na conversa. Se a pergunta mudar de assunto, trate como assunto novo.
- As suas respostas anteriores nesta conversa foram conferidas com as ferramentas na hora: não diga que não foram. Ao mudar de assunto, responda só o assunto novo (não retome nem reconsulte o anterior sem a pessoa pedir).
- Se faltar algo essencial e não der para deduzir com segurança (qual unidade, qual pessoa, qual período), faça UMA pergunta curta de esclarecimento em vez de chutar.
- Explicar "por que" algo aconteceu: mostre o que os dados indicam (quais contas, quais itens mudaram) e diga que é o que os registros mostram, não uma certeza de causa.
- Comparar unidades: use listar_unidades e consulte TODAS as unidades no MESMO passo (chamadas em paralelo); só unidades da lista.
- Não repita uma consulta que já voltou nesta conversa; use o resultado que você já tem. Você tem poucos passos: planeje as consultas antes.

Situação de cada resultado (campo "situacao" + "comoComunicar"): siga a orientação. SEM_REGISTROS = diga que não encontrou registros no período (NUNCA "R$ 0,00 gasto"); VALOR_ZERO = o zero é real e pode ser dito; PARCIAL = diga o que veio e o que faltou; NAO_CALCULAVEL = o indicador não pode ser calculado (não é zero); BLOQUEADO = sem permissão (sem mostrar o dado); FALHA_TECNICA = a consulta falhou agora (sugira tentar de novo); INDISPONIVEL = o sistema não tem esse dado.

Escritas: você NUNCA grava, paga, baixa nem altera nada. Compra nova já paga ou prestação de contas de uma sangria (o que foi gasto com a retirada e o troco): use preparar_operacao — o servidor confere tudo e devolve a proposta, o que falta e "comoResponder". Peça SÓ o que falta, ou mostre o resumo e peça confirmação ("sim" confirma, "cancela" desiste): quem executa é o servidor, depois da confirmação da pessoa. Para corrigir, chame preparar_operacao de novo com o dado certo. Retirada para guardar no cofre ou levar ao banco NÃO é despesa (é transferência registrada no Caixa): explique, sem preparar despesa. Pagar contas, transferir ou estornar: o MOVA não faz. Sem preparar_operacao, use preparar_registro. Para o que ainda não foi executado, nunca use "registrei", "lancei", "registrado", "lançado", "gravado": diga "preparei" ou "ainda não entrou no Financeiro".

Estilo: português do Brasil, direto e natural, como uma pessoa do financeiro no WhatsApp. Frases curtas, sem tabelas nem markdown pesado; listas curtas com "•" quando ajudar. Datas como dd/mm/aaaa.`;

const textoDe = (content) => (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

/**
 * @param {object} p
 * @param {object} p.cliente     cliente da API (messages.create)
 * @param {object} p.executor    criarExecutor(...)
 * @param {object} p.sessao      novaSessao(...)
 * @param {object} p.orcamento   reservar/concluir/falhar
 * @param {Array}  p.ferramentas definições (definicoesParaApi)
 * @param {Array}  p.historico   turnos anteriores (mensagens)
 * @param {string} p.pergunta
 * @param {object} p.ambiente    { hoje, unidade, perfil }
 */
export async function executarLaco({ cliente, executor, sessao, orcamento, ferramentas, historico = [], pergunta, ambiente, opcoes = {}, relogio = () => Date.now(), registrar = () => {} }) {
  const o = { ...PADROES_DO_LACO, ...opcoes };
  const inicio = relogio();
  const tools = ferramentas.map((t, i) => (i === ferramentas.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));
  const system = [
    { type: "text", text: INSTRUCOES, cache_control: { type: "ephemeral" } },
    { type: "text", text: `Hoje: ${ambiente.hoje}. Unidade desta conversa: ${ambiente.unidade} (para ela, OMITA o campo "unidade" das ferramentas; outra unidade só pela referência exata devolvida por listar_unidades). Perfil: ${ambiente.perfil}.${ambiente.podeValores ? "" : " Nesta conversa NÃO mostre valores em reais (só contagens e situações)."}` },
    ...(ambiente.contexto ? [{ type: "text", text: String(ambiente.contexto).slice(0, 1500) }] : []),
  ];
  const messages = [...historico, { role: "user", content: pergunta }];
  const uso = { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0, custoMicrousd: 0, chamadas: 0 };
  const usadas = [];
  const reprovados = [];
  let correcaoFeita = false;
  let final = null;
  let motivo = null;

  for (let passo = 1; passo <= o.maxPassos; passo++) {
    const req = { model: o.modelo, max_tokens: o.maxTokens, system, tools, messages, output_config: { effort: o.esforco } };
    let reserva;
    try { reserva = await orcamento.reservar({ modelo: o.modelo, requisicaoId: sessao.requisicaoId, tokensDePrompt: estimarTokensDoPedido(req), maxTokens: o.maxTokens }); }
    catch (e) { motivo = e.codigo ?? "ORCAMENTO_INDISPONIVEL"; break; }
    let r;
    try { r = await cliente.messages.create(req); }
    catch (e) {
      await orcamento.falhar(reserva, { possivelmenteFaturada: Boolean(e?.status && e.status >= 500) });
      motivo = "IA_INDISPONIVEL"; registrar({ tipo: "MOVA_CORE_IA_FALHOU", status: e?.status ?? null });
      break;
    }
    const u = r.usage ?? {};
    uso.custoMicrousd += await orcamento.concluir(reserva, { modelo: r.model ?? o.modelo, uso: u }) ?? 0;
    uso.entrada += u.input_tokens ?? 0; uso.saida += u.output_tokens ?? 0; uso.cacheLeitura += u.cache_read_input_tokens ?? 0; uso.cacheEscrita += u.cache_creation_input_tokens ?? 0; uso.chamadas++;

    if (r.stop_reason === "tool_use") {
      const pedidos = r.content.filter((b) => b.type === "tool_use");
      const resultados = await Promise.all(pedidos.map((b) => executor.executar(sessao, b)));
      pedidos.forEach((b, i) => usadas.push({ nome: b.name, ok: resultados[i].ok, codigo: resultados[i].codigo ?? null, passo, argumentos: b.input }));
      messages.push({ role: "assistant", content: r.content }); // blocos (inclusive raciocínio) devolvidos SEM alteração
      messages.push({ role: "user", content: pedidos.map((b, i) => ({ type: "tool_result", tool_use_id: b.id, content: resultados[i].conteudo, ...(resultados[i].ok ? {} : { is_error: true }) })) });
      continue;
    }
    if (r.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: r.content }); continue; }
    if (r.stop_reason === "refusal") { motivo = "RECUSA_DO_MODELO"; break; }
    if (r.stop_reason === "max_tokens") { motivo = "LIMITE_DE_SAIDA"; break; }

    const texto = textoDe(r.content);
    const v = verificarFidelidade(texto, { fatos: sessao.fatos, unidades: sessao.unidadesPermitidas.map((x) => x.nome) });
    if (v.ok) { final = { texto, verificacao: v }; break; }
    registrar({ tipo: "MOVA_CORE_VERIFICADOR_REPROVOU", requisicaoId: sessao.requisicaoId, violacoes: v.violacoes.map((x) => x.tipo) });
    reprovados.push({ texto, violacoes: v.violacoes }); // diagnóstico interno (avaliação/sombra) — NUNCA enviado
    if (correcaoFeita || passo === o.maxPassos) { final = { texto: null, verificacao: v }; motivo = "VERIFICADOR_REPROVOU"; break; }
    correcaoFeita = true;
    messages.push({ role: "assistant", content: r.content });
    messages.push({ role: "user", content: `[conferência automática] A resposta não bate com as consultas: ${v.violacoes.map((x) => `${x.tipo}${x.valor ? ` (${x.valor})` : ""}${x.detalhe ? `: ${x.detalhe}` : ""}`).join("; ")}. Refaça usando SOMENTE valores devolvidos pelas ferramentas, com a entidade, o período, a unidade e o significado corretos; se não tiver o dado, diga que não tem.` });
  }
  if (!final && !motivo) motivo = "PASSOS_ESGOTADOS";
  // F2: reprovado duas vezes ⇒ aproveita as frases que PASSAM na conferência (em vez de descartar tudo)
  if (!final?.texto && motivo === "VERIFICADOR_REPROVOU" && reprovados.length) {
    const ultimo = reprovados.at(-1);
    const parcial = aproveitarFatosValidos(ultimo.texto, ultimo.violacoes, { fatos: sessao.fatos, unidades: sessao.unidadesPermitidas.map((x) => x.nome) });
    if (parcial) { final = { texto: parcial, verificacao: { ok: true, violacoes: [], parcial: true } }; motivo = "RESPOSTA_PARCIAL_CONFERIDA"; }
  }
  const texto = final?.texto ?? RESPOSTA_SEGURA[motivo] ?? RESPOSTA_SEGURA.PADRAO;
  return {
    texto, motivo: final?.texto ? (motivo === "RESPOSTA_PARCIAL_CONFERIDA" ? motivo : "RESPONDIDO") : motivo, verificacao: final?.verificacao ?? null, reprovados, ferramentas: usadas,
    preparouRegistro: usadas.some((x) => x.nome === "preparar_registro" && x.ok), uso, latenciaMs: relogio() - inicio,
  };
}

export const RESPOSTA_SEGURA = Object.freeze({
  VERIFICADOR_REPROVOU: "Não consegui conferir os números dessa resposta com segurança, então prefiro não afirmar. Pode perguntar de novo de forma mais específica (qual conta, qual período)?",
  IA_INDISPONIVEL: "Não consegui consultar agora. Tente de novo em alguns minutos.",
  PASSOS_ESGOTADOS: "Essa pergunta precisou de consultas demais. Pode dividir em partes menores?",
  ORCAMENTO_DIARIO_ESGOTADO: "O limite diário de consultas inteligentes foi atingido. Amanhã volto a responder perguntas abertas.",
  ORCAMENTO_MENSAL_ESGOTADO: "O limite mensal de consultas inteligentes foi atingido.",
  ORCAMENTO_REQUISICAO_ESGOTADO: "Essa pergunta ficou cara demais para responder de uma vez. Pode dividir em partes menores?",
  PASSOS_ESGOTADOS_ORC: "Essa pergunta precisou de consultas demais.",
  LIMITE_DE_SAIDA: "A resposta ficou longa demais. Pode perguntar algo mais específico?",
  RECUSA_DO_MODELO: "Não posso ajudar com esse pedido.",
  PADRAO: "Não consegui responder agora.",
});
