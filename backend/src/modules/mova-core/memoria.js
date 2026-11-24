// MOVA CORE — F2: MEMÓRIA CONVERSACIONAL EM CAMADAS (substitui progressivamente a continuidade mínima da F1: 6 turnos / 10 min).
//
// Camadas, por conversa × participante (organização na chave; grupo e privado são conversas DIFERENTES — nunca se misturam):
//   1. mensagens recentes (texto)            — só as do ASSUNTO atual vão ao modelo como histórico
//   2. resumo do fio                         — assuntos do fio, sem valores (nunca é fonte de saldo/pagamento)
//   3. entidades e referências               — quem/que foi citado, de que tipo, em que unidade; referências opacas do fio
//   4. assuntos recentes                     — mudança de assunto detectada pelas ferramentas e entidades; retomada por nome
//   5. pendências operacionais e financeiras — injetadas (porta) — o que está aguardando resposta desta pessoa
//   6. decisões anteriores                   — esclarecimentos dados ("o Matheus Rocha", "a unidade Norte")
//   7. conhecimento corporativo aprovado     — porta; hoje INEXISTENTE no sistema (nada é inventado aqui)
//
// O FIO dura até 24 h de inatividade (configurável). Fio vencido vira ARQUIVO: só os resumos (sem valores) ficam, e um assunto
// antigo só volta com referência EXPLÍCITA ("da outra vez", "aquele…", nome) — e só para a mesma pessoa na mesma conversa.
// Nada de histórico inteiro ao modelo: `recuperar` devolve só o relevante para a pergunta atual.
// VALORES: fatos financeiros de turnos anteriores só valem como fonte por `fatoValidoMs` (padrão 10 min, como o cache de
// leitura). Depois disso o modelo tem de CONSULTAR DE NOVO — a memória nunca responde saldo, pagamento ou obrigação.
import { criarReferencias } from "./referencias.js";
import { valoresDoTexto } from "./verificador.js";

export const PADROES_DA_MEMORIA = Object.freeze({ fioMs: 24 * 60 * 60 * 1000, fatoValidoMs: 10 * 60 * 1000, maxTurnosNoAssunto: 6, maxTurnosNoFio: 60, maxAssuntos: 12, maxArquivo: 30, maxEntidades: 40 });

const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const palavras = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

/** Tema de cada ferramenta (para detectar mudança de assunto sem chamar o modelo). */
export const TEMA_DA_FERRAMENTA = Object.freeze({
  contas_a_pagar: "contas a pagar", detalhe_conta_a_pagar: "contas a pagar", contas_a_receber: "contas a receber", resultado_do_mes: "resultado",
  resumo_financeiro: "resultado", fluxo_de_caixa: "caixa", caixa_e_bancos: "caixa", movimentos_do_caixa_fisico: "caixa", vendas: "vendas",
  cobertura_de_faturamento: "vendas", pendencias_de_conferencia: "conferência", documentos: "documentos", categorias: "categorias",
  entregadores_da_semana: "entregadores", historico_do_entregador: "entregadores", como_funciona: "explicação", preparar_registro: "registro",
});
const TIPO_DA_FERRAMENTA = Object.freeze({ entregadores_da_semana: "entregador", historico_do_entregador: "entregador", contas_a_pagar: "fornecedor", detalhe_conta_a_pagar: "fornecedor", contas_a_receber: "recebível", caixa_e_bancos: "conta", movimentos_do_caixa_fisico: "conta" });
const RETOMADA = /\b(voltando|retomando|sobre (o|a|aquele|aquela)|aquele|aquela|da outra vez|ontem voce|como (eu )?disse|lembra)\b/;
const PRONOME = /\b(ele|ela|dele|dela|nele|nela|isso|esse|essa|desse|dessa|aquilo|o outro|a outra)\b/;
const GENERICAS = new Set(["todas as contas", "bancos", "caixa fisico", "sangrias", "reforcos", "transferencias", "nao identificados"]);

/** Tira valores em reais de um texto (o resumo nunca guarda número financeiro). */
export function semValores(texto) {
  let t = String(texto ?? "");
  for (const v of valoresDoTexto(t).sort((a, b) => b.inicio - a.inicio)) t = `${t.slice(0, v.inicio)}[valor]${t.slice(v.fim)}`;
  return t;
}
const primeiraFrase = (t) => semValores(String(t ?? "").split(/(?<=[.!?])\s|\n/)[0]).slice(0, 160);

/** Repositório em memória (ambiente isolado). Persistente: tabela mova_core.memoria_conversa (migração NÃO aplicada). */
export function criarRepositorioDeMemoriaEmMemoria() {
  const m = new Map();
  return Object.freeze({ async ler(chave) { return m.get(chave) ?? null; }, async gravar(chave, estado) { m.set(chave, estado); }, async apagar(chave) { m.delete(chave); }, tamanho: () => m.size });
}

/**
 * @param {object} [deps]
 * @param {object} [deps.repositorio]  ler/gravar por chave (o estado é serializável, exceto as referências, recriadas a partir do mapa)
 * @param {object} [deps.pendencias]   { listar({organizacaoId, conversaId, participanteId}) → [{tipo, descricao, criadaEm}] }
 * @param {object} [deps.conhecimento] { buscar(pergunta) → [{titulo, texto, aprovadoEm}] } — base aprovada (hoje não existe)
 */
export function criarMemoriaEmCamadas({ repositorio = criarRepositorioDeMemoriaEmMemoria(), pendencias = null, conhecimento = null, relogio = () => Date.now(), opcoes = {} } = {}) {
  const o = { ...PADROES_DA_MEMORIA, ...opcoes };
  const vivas = new Map(); // estado + referências em uso (as referências não são serializadas: o mapa sim)

  const novoFio = (agora) => ({ inicio: agora, ultimaEm: agora, turnos: [], assuntos: [], entidades: [], decisoes: [], fatos: [] });

  async function obter({ organizacaoId, conversaId, participanteId }) {
    if (!organizacaoId || !conversaId || !participanteId) throw new TypeError("memória exige organização, conversa e participante");
    const chave = `${organizacaoId}|${conversaId}|${participanteId}`;
    const agora = relogio();
    let c = vivas.get(chave);
    if (!c) {
      const salvo = await repositorio.ler(chave);
      c = { chave, organizacaoId, conversaId, participanteId, fio: salvo?.fio ?? novoFio(agora), arquivo: salvo?.arquivo ?? [], referencias: criarReferencias(salvo?.mapaDeReferencias), cache: new Map() };
      vivas.set(chave, c);
    }
    if (agora - c.fio.ultimaEm > o.fioMs) { // fio vencido: arquiva só os resumos dos assuntos (sem valores) e começa outro
      c.arquivo = [...c.fio.assuntos.map((a) => ({ ...a, arquivadoEm: agora, turnos: undefined })), ...c.arquivo].slice(0, o.maxArquivo);
      c.fio = novoFio(agora); c.referencias = criarReferencias(); c.cache = new Map();
    }
    return c;
  }

  const assuntoAtual = (c) => c.fio.assuntos.at(-1) ?? null;

  /** Decide se o turno continua o assunto atual, retoma um anterior do fio, ou abre um novo. */
  function situarAssunto(c, { pergunta, ferramentas, entidades }) {
    const temas = [...new Set(ferramentas.map((f) => TEMA_DA_FERRAMENTA[f]).filter(Boolean))];
    const p = norm(pergunta);
    const citadas = c.fio.entidades.filter((e) => palavras(e.nome).some((w) => new RegExp(`\\b${w}\\b`).test(p)));
    const atual = assuntoAtual(c);
    // retomada: a pergunta cita uma entidade de um assunto ANTERIOR (não o atual)
    const anterior = citadas.map((e) => c.fio.assuntos.find((a) => a.id === e.assuntoId)).find((a) => a && a !== atual);
    if (anterior) return { assunto: anterior, retomado: true };
    if (atual) {
      const mesmasEntidades = entidades.some((e) => atual.entidades.includes(e)) || citadas.some((e) => e.assuntoId === atual.id);
      const mesmoTema = !temas.length || temas.some((t) => atual.temas.includes(t));
      const pronome = PRONOME.test(p);
      if (mesmasEntidades || pronome || (mesmoTema && !entidades.length)) return { assunto: atual, retomado: false };
    }
    const novo = { id: `a${c.fio.assuntos.length + 1}`, temas, entidades: [], perguntas: [], resumo: "", inicio: relogio(), ultimaEm: relogio() };
    c.fio.assuntos.push(novo);
    if (c.fio.assuntos.length > o.maxAssuntos) c.fio.assuntos.shift();
    return { assunto: novo, retomado: false, novo: true };
  }

  async function registrarTurno(c, { pergunta, resposta, ferramentas = [], fatos = [], esclarecimentoPedido = false }) {
    const agora = relogio();
    c.fio.ultimaEm = agora;
    const nomesFerramentas = ferramentas.map((f) => (typeof f === "string" ? f : f.nome));
    // entidades do turno: as dos fatos novos (nomes próprios; genéricas como "bancos" não contam)
    const novos = fatos.filter((f) => !f.anterior);
    const brutas = [...new Set(novos.map((f) => f.entidade).filter((e) => typeof e === "string" && e.length >= 3 && !GENERICAS.has(norm(e))))];
    // "Matheus" (termo da busca) e "Matheus Rocha" (nome cadastrado) são a MESMA menção: fica o nome completo
    const entidadesTurno = brutas.filter((e) => !brutas.some((o) => o !== e && norm(o).startsWith(`${norm(e)} `))).slice(0, 10);
    const { assunto } = situarAssunto(c, { pergunta, ferramentas: nomesFerramentas, entidades: entidadesTurno });
    assunto.ultimaEm = agora;
    assunto.temas = [...new Set([...assunto.temas, ...nomesFerramentas.map((f) => TEMA_DA_FERRAMENTA[f]).filter(Boolean)])];
    assunto.entidades = [...new Set([...entidadesTurno, ...assunto.entidades])].slice(0, 10);
    assunto.perguntas = [...assunto.perguntas, semValores(pergunta).slice(0, 160)].slice(-4);
    assunto.resumo = primeiraFrase(resposta);
    for (const nome of entidadesTurno) {
      const f = novos.find((x) => x.entidade === nome);
      const tipo = TIPO_DA_FERRAMENTA[f?.ferramenta] ?? "outro";
      const ja = c.fio.entidades.find((e) => norm(e.nome) === norm(nome) && e.unidadeId === (f?.unidadeId ?? null));
      if (ja) Object.assign(ja, { ultimaEm: agora, assuntoId: assunto.id, tipo: ja.tipo === "outro" ? tipo : ja.tipo });
      else c.fio.entidades.push({ nome, tipo, unidadeId: f?.unidadeId ?? null, unidade: f?.unidade ?? null, assuntoId: assunto.id, ultimaEm: agora });
    }
    c.fio.entidades = c.fio.entidades.sort((a, b) => b.ultimaEm - a.ultimaEm).slice(0, o.maxEntidades);
    // decisão: a pessoa respondeu a um pedido de esclarecimento do turno anterior
    const anteriorTurno = c.fio.turnos.at(-1);
    if (anteriorTurno?.esclarecimentoPedido) c.fio.decisoes = [...c.fio.decisoes, { em: agora, pergunta: semValores(anteriorTurno.resposta).slice(0, 160), resposta: semValores(pergunta).slice(0, 120), assuntoId: assunto.id }].slice(-10);
    c.fio.turnos.push({ em: agora, assuntoId: assunto.id, pergunta: String(pergunta).slice(0, 600), resposta: String(resposta ?? "").slice(0, 1200), ferramentas: nomesFerramentas, esclarecimentoPedido });
    if (c.fio.turnos.length > o.maxTurnosNoFio) c.fio.turnos.shift();
    // fatos: guardados com o instante da consulta; só os "frescos" voltam como fonte (ver fatosValidos)
    c.fio.fatos = [...c.fio.fatos, ...novos.map((f) => ({ ...f, consultadoEm: f.consultadoEm ?? agora, anterior: true }))].slice(-300);
    await repositorio.gravar(c.chave, { fio: c.fio, arquivo: c.arquivo, mapaDeReferencias: c.referencias.exportar?.() ?? null });
  }

  /** Fatos que ainda podem ser citados sem nova consulta (frescos). Os demais exigem consultar de novo. */
  function fatosValidos(c) { const agora = relogio(); return c.fio.fatos.filter((f) => agora - (f.consultadoEm ?? 0) <= o.fatoValidoMs); }

  /** Histórico (mensagens da API) só do assunto em que a pergunta se encaixa — nunca o fio inteiro. */
  function historico(c, pergunta = "") {
    const p = norm(pergunta);
    const citada = c.fio.entidades.find((e) => palavras(e.nome).some((w) => new RegExp(`\\b${w}\\b`).test(p)));
    const alvo = citada?.assuntoId ?? (PRONOME.test(p) || !c.fio.turnos.length ? assuntoAtual(c)?.id : assuntoAtual(c)?.id);
    return c.fio.turnos.filter((t) => t.assuntoId === alvo).slice(-o.maxTurnosNoAssunto)
      .flatMap((t) => [{ role: "user", content: t.pergunta }, { role: "assistant", content: t.resposta || "(sem resposta)" }]);
  }

  /**
   * CONTEXTO RECUPERADO para a pergunta atual — compacto, sem valores, explicitamente "não é fonte".
   * Inclui: assunto atual; assunto RETOMADO (se a pergunta cita entidade de outro assunto); entidade de pronome; ambiguidades;
   * decisões; pendências desta pessoa; arquivo (só com referência explícita); conhecimento aprovado (se existir).
   */
  async function recuperar(c, pergunta) {
    const p = norm(pergunta);
    const linhas = [];
    const atual = assuntoAtual(c);
    const citadas = c.fio.entidades.filter((e) => palavras(e.nome).some((w) => new RegExp(`\\b${w}\\b`).test(p)));
    // ambiguidade: o mesmo primeiro nome para entidades diferentes (ex.: dois "Matheus")
    for (const w of new Set(palavras(pergunta))) {
      const mesmas = c.fio.entidades.filter((e) => palavras(e.nome)[0] === w);
      const nomes = [...new Set(mesmas.map((e) => `${e.nome}${e.unidade ? ` (${e.unidade})` : ""}`))];
      if (nomes.length > 1) linhas.push(`Atenção: há mais de um "${w}" nesta conversa: ${nomes.join("; ")}. Se a pergunta não deixar claro qual, pergunte.`);
    }
    const retomado = citadas.map((e) => c.fio.assuntos.find((a) => a.id === e.assuntoId)).find((a) => a && a !== atual);
    if (retomado) linhas.push(`A pessoa está VOLTANDO a um assunto anterior desta conversa: ${retomado.temas.join(", ") || "—"} sobre ${retomado.entidades.join(", ") || "—"} (perguntas: ${retomado.perguntas.join(" / ")}). Consulte de novo os dados.`);
    else if (atual) linhas.push(`Assunto atual: ${atual.temas.join(", ") || "—"}${atual.entidades.length ? ` sobre ${atual.entidades.join(", ")}` : ""}.`);
    if (PRONOME.test(p) && !citadas.length) {
      const alvo = c.fio.entidades.find((e) => e.assuntoId === atual?.id && e.tipo !== "outro") ?? c.fio.entidades.find((e) => e.assuntoId === atual?.id);
      if (alvo) linhas.push(`"Ele/ela/isso" provavelmente se refere a: ${alvo.nome} (${alvo.tipo}${alvo.unidade ? `, ${alvo.unidade}` : ""}).`);
    }
    const outros = c.fio.assuntos.filter((a) => a !== atual && a !== retomado).slice(-3);
    if (outros.length) linhas.push(`Assuntos anteriores do fio (só se a pessoa voltar a eles): ${outros.map((a) => `${a.temas.join("/") || "—"}${a.entidades.length ? ` (${a.entidades.slice(0, 3).join(", ")})` : ""}`).join("; ")}.`);
    if (c.fio.decisoes.length) linhas.push(`Esclarecimentos já dados: ${c.fio.decisoes.slice(-3).map((d) => `"${d.resposta}"`).join("; ")}.`);
    if (pendencias) {
      try {
        const ps = await pendencias.listar({ organizacaoId: c.organizacaoId, conversaId: c.conversaId, participanteId: c.participanteId });
        if (ps?.length) linhas.push(`Pendências desta pessoa aguardando resposta: ${ps.slice(0, 3).map((x) => `${x.tipo}: ${semValores(x.descricao).slice(0, 100)}`).join("; ")}.`);
      } catch { /* pendências indisponíveis: segue sem elas */ }
    }
    if (RETOMADA.test(p) && c.arquivo.length) {
      const arq = c.arquivo.find((a) => a.entidades.some((e) => palavras(e).some((w) => p.includes(w)))) ?? null;
      if (arq) linhas.push(`Em conversa mais antiga (encerrada) houve: ${arq.temas.join("/")} sobre ${arq.entidades.join(", ")}. Os dados de então podem ter mudado: consulte de novo.`);
    }
    if (conhecimento) {
      try { const k = await conhecimento.buscar(pergunta); if (k?.length) linhas.push(`Conhecimento aprovado: ${k.slice(0, 2).map((x) => `${x.titulo}: ${x.texto}`.slice(0, 300)).join(" | ")}`); } catch { /* sem base */ }
    }
    if (!linhas.length) return null;
    return `Contexto recuperado da conversa (NÃO é fonte de valores: qualquer número precisa de consulta agora):\n- ${linhas.join("\n- ")}`;
  }

  return Object.freeze({ obter, registrarTurno, historico, recuperar, fatosValidos, assuntoAtual, opcoes: o, tamanho: () => vivas.size });
}
