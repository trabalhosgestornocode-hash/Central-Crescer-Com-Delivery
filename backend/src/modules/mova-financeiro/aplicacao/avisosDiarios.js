// MOVA — 26/11/2026: AVISO DIÁRIO de contas a pagar no grupo (padrão 10h e 15h, America/Fortaleza).
// DETERMINÍSTICO: nenhuma IA (zero tokens). Reusa a rotina periódica, a porta de LEITURA do Financeiro e a fila de saída do MOVA
// (o mesmo enviador, com os mesmos tetos e destinos permitidos).
// Regras:
//  - consulta NOVA a cada janela (nada guardado da janela anterior além das contagens): às 15h só sai o que AINDA está em aberto;
//  - "todas pagas" só quando o Financeiro confirmou (todas as unidades consultadas com sucesso e nada em aberto do que vencia hoje);
//  - Financeiro fora do ar numa unidade ⇒ a mensagem diz que aquela unidade está INDISPONÍVEL (nunca "nenhuma conta");
//  - idempotente por grupo + data + janela (tabela mova.aviso_diario, chave única; reserva e mensagem na mesma transação);
//  - valores e fornecedores no grupo só com a política GRUPO_FINANCEIRO e o retrato recente dos membros, TODOS FINANCEIRO nas
//    unidades do aviso (a mesma regra das consultas); senão sai a versão SEM valores (só contagens) e o motivo fica no resumo;
//  - contas entre empresas em seção própria (reembolso, nunca despesa nem receita); vencimento só o registrado (nunca inventado).
import { POLITICA_RESPOSTA, decidirSaidaNoGrupo } from "../dominio/participantes.js";
import { mascarar } from "../dominio/configuracao.js";

const FUSO_MS = -3 * 3600 * 1000; // America/Fortaleza (UTC−3, sem horário de verão)
export const JANELAS_PADRAO = Object.freeze(["10:00", "15:00"]);
/** Depois do horário, o aviso ainda sai por este tempo (reinício/deploy no meio); depois disso a janela é dada como perdida. */
export const TOLERANCIA_MIN = 120;
/** Com o Financeiro indisponível, espera este tempo (novas tentativas a cada passo) antes de avisar a indisponibilidade. */
export const ESPERA_INDISPONIVEL_MIN = 30;
const MAX_ITENS = 15;
/** Retrato dos membros mais velho que isto ⇒ o aviso pede um novo ao Gateway (a validade da regra de exibição é de 15 min). */
export const RETRATO_NOVO_MS = 5 * 60 * 1000;
const FORNECEDOR_NAO_INFORMADO = "Fornecedor não informado";

const reais = (c) => { const a = Math.abs(c); return `${c < 0 ? "-" : ""}R$ ${Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(a % 100).padStart(2, "0")}`; };
const dataBr = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "");
const dataBrAno = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const minutos = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const somar = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const textoCurto = (s, max = 60) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** Data local (Fortaleza) e minutos do dia. */
export function agoraLocal(agora) {
  const d = new Date(agora.getTime() + FUSO_MS);
  return { data: d.toISOString().slice(0, 10), minutos: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** Janelas "HH:MM" válidas, ordenadas e sem repetição (entrada inválida é descartada; nada válido ⇒ padrão). */
export function normalizarJanelas(lista) {
  const ok = [...new Set((lista ?? []).map((x) => String(x).trim()).filter((x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x)))].sort();
  return ok.length ? ok : [...JANELAS_PADRAO];
}

/**
 * @param {{cfg:object, porta:object, armazenamento:object, relogio?:Function, registrar?:Function,
 *          avisos?:{grupos:string[], janelas?:string[], toleranciaMin?:number, esperaIndisponivelMin?:number}}} deps
 */
export function criarAvisosDiarios({ cfg, porta, armazenamento: a, relogio = () => new Date(), registrar = () => {}, avisos = {} }) {
  const servico = cfg.identidadeServico.usuarioId;
  const janelas = normalizarJanelas(avisos.janelas);
  const tolerancia = avisos.toleranciaMin ?? TOLERANCIA_MIN;
  const espera = avisos.esperaIndisponivelMin ?? ESPERA_INDISPONIVEL_MIN;
  // 28/11 (pedido do proprietário): contas de competência ANTERIOR a `competenciaInicial` (ex.: "2026-10" ⇒ setembro e antes, da
  // importação inicial) não entram no aviso. Continuam no Contas a Pagar; só o aviso as ignora. Sem a configuração, nada muda.
  const desde = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(avisos.competenciaInicial ?? "")) ? avisos.competenciaInicial : null;
  const noPeriodo = (t) => !desde || !t.competencia || t.competencia >= desde;
  const unidadeDe = (id) => cfg.unidades.find((u) => u.unidadeId === id) ?? null;
  const nomeDe = (id) => unidadeDe(id)?.nome ?? "Unidade";
  // Só grupos de LISTA autorizados (nunca conversa privada, de entregador ou derivada) — e só os indicados na configuração.
  const grupos = () => (avisos.grupos ?? []).map((jid) => cfg.gruposAutorizados.find((g) => g.grupoId === jid && String(jid).endsWith("@g.us") && !g.privada && !g.derivada && !g.entregador && g.acesso === "LISTA"))
    .filter(Boolean);

  /** Consulta NOVA de uma unidade: contas em aberto que vencem hoje, as vencidas e as contas entre empresas em aberto. */
  async function consultarUnidade(unidadeId, hoje) {
    const u = unidadeDe(unidadeId);
    const escopo = { organizacaoId: u.organizacaoId, unidadeId, usuarioId: servico };
    try {
      const abertas = (await porta.contasAPagarAbertas(escopo)).filter((t) => t.saldoCentavos > 0 && t.vencimento && noPeriodo(t));
      let entreEmpresas = [];
      try { entreEmpresas = (await porta.ler("consultarContasEntreEmpresas", escopo, { incluirLiquidadas: false })).itens ?? []; }
      catch (e) { if (!porta.ehErroDeRegra(e)) throw e; } // regra (ex.: sem o módulo ainda) ⇒ só a seção some; queda ⇒ unidade indisponível
      return {
        unidadeId, disponivel: true,
        hoje: abertas.filter((t) => t.vencimento === hoje),
        vencidas: abertas.filter((t) => t.vencimento < hoje),
        entreEmpresas: entreEmpresas.filter((i) => i.saldoCentavos > 0),
      };
    } catch (e) {
      registrar({ tipo: "MOVA_AVISO_DIARIO_UNIDADE_INDISPONIVEL", unidadeId, causa: String(e?.causa ?? e?.codigo ?? e?.code ?? "ERRO").slice(0, 40) });
      return { unidadeId, disponivel: false, hoje: [], vencidas: [], entreEmpresas: [] };
    }
  }

  /** Para quem o aviso pode mostrar valores? (mesma regra das consultas no grupo) */
  async function nivelDeDetalhe(grupo) {
    if (grupo.politicaResposta !== POLITICA_RESPOSTA.GRUPO_FINANCEIRO) return { valores: false, motivo: "POLITICA_SEM_VALORES_NO_GRUPO" };
    let retrato = typeof a.membros?.obter === "function" ? await a.membros.obter(grupo.grupoId) : null;
    // 27/11: o Gateway só manda o retrato junto de uma mensagem recebida; numa manhã sem conversa o retrato das 10h estaria velho
    // e o aviso sairia sempre sem valores. Retrato com mais de RETRATO_NOVO_MS ⇒ pede um NOVO ao Gateway (canal isolado, somente
    // leitura). A regra de exibição NÃO muda: decidirSaidaNoGrupo continua exigindo TODOS os membros FINANCEIRO e o retrato dentro
    // da janela. Falha ao pedir ⇒ segue com o que havia (no pior caso, sem valores).
    const velho = !retrato?.verificadoEm || relogio().getTime() - new Date(retrato.verificadoEm).getTime() > RETRATO_NOVO_MS;
    if (velho && typeof avisos.atualizarMembros === "function" && typeof a.membros?.registrar === "function") {
      try {
        const novo = await avisos.atualizarMembros(grupo.grupoId);
        if (novo && Array.isArray(novo.membros) && novo.membros.length && typeof novo.verificadoEm === "string") {
          await a.membros.registrar({ grupoId: grupo.grupoId, membros: novo.membros, verificadoEm: novo.verificadoEm, fonte: "GATEWAY" });
          retrato = { membros: novo.membros, verificadoEm: novo.verificadoEm };
          registrar({ tipo: "MOVA_AVISO_DIARIO_RETRATO_ATUALIZADO", grupo: mascarar(grupo.grupoId) });
        } else registrar({ tipo: "MOVA_AVISO_DIARIO_RETRATO_INDISPONIVEL", grupo: mascarar(grupo.grupoId) });
      } catch (e) { registrar({ tipo: "MOVA_AVISO_DIARIO_RETRATO_INDISPONIVEL", grupo: mascarar(grupo.grupoId), causa: String(e?.codigo ?? "ERRO").slice(0, 40) }); }
    }
    const d = decidirSaidaNoGrupo({ grupo, consulta: "CONTAS_VENCENDO", unidades: grupo.unidades, retrato, agora: relogio() });
    return d.saida === "GRUPO" && d.detalhe === true ? { valores: true, motivo: d.motivo } : { valores: false, motivo: d.motivo };
  }

  const linhaConta = (t, { comVencimento = false } = {}) =>
    `• ${textoCurto(t.fornecedor?.nome || FORNECEDOR_NAO_INFORMADO, 40)} — ${textoCurto(t.descricao || "sem descrição")}${t.parcela?.total > 1 ? ` (${t.parcela.numero}/${t.parcela.total})` : ""}${comVencimento ? ` — venceu ${dataBr(t.vencimento)}` : ""} — ${reais(t.saldoCentavos)}`;
  const limitar = (linhas) => (linhas.length > MAX_ITENS ? [...linhas.slice(0, MAX_ITENS), `… e mais ${linhas.length - MAX_ITENS}`] : linhas);
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

  /** Contas entre empresas: cada vínculo UMA vez (o lado devedor; o credor só se o devedor não está no aviso). */
  function entreEmpresasDoGrupo(resultados) {
    const noAviso = new Set(resultados.map((r) => r.unidadeId));
    const vistos = new Set(); const itens = [];
    for (const r of resultados) for (const i of r.entreEmpresas) {
      const devedora = i.devedora?.unidadeId; const credora = i.credora?.unidadeId;
      if (i.papel === "CREDORA" && noAviso.has(devedora)) continue;
      if (vistos.has(i.vinculoId)) continue;
      vistos.add(i.vinculoId);
      itens.push({ ...i, nomeDevedora: noAviso.has(devedora) ? nomeDe(devedora) : i.devedora?.nome ?? "outra empresa", nomeCredora: noAviso.has(credora) ? nomeDe(credora) : i.credora?.nome ?? "outra empresa" });
    }
    return itens;
  }

  /** Texto do aviso (determinístico). Devolve null quando não há nada a dizer nesta janela (ex.: 15h sem contas desde as 10h). */
  function montarTexto({ hoje, janela, primeira, resultados, entre, valores, anterior }) {
    const indisponiveis = resultados.filter((r) => !r.disponivel);
    const totalHoje = somar(resultados, (r) => r.hoje.length);
    const totalVencidas = somar(resultados, (r) => r.vencidas.length);
    const entreDevidas = entre.filter((i) => i.vencimento && i.vencimento <= hoje);
    const tudoConsultado = indisponiveis.length === 0;
    const linhas = [];
    if (!primeira && tudoConsultado && totalHoje === 0) {
      // 15h: só confirma "tudo pago" quando havia contas na janela anterior E o Financeiro respondeu por todas as unidades.
      const haviaContas = Object.values(anterior?.porUnidade ?? {}).some((x) => (x?.hoje ?? 0) > 0);
      if (!haviaContas && totalVencidas === 0 && entreDevidas.length === 0) return null;
      linhas.push(`✅ *Contas de hoje (${dataBrAno(hoje)})*: ${haviaContas ? "todas as que venciam hoje constam como pagas no Financeiro." : "nenhuma conta vence hoje."}`);
    } else {
      linhas.push(primeira ? `📋 *Contas a pagar — hoje, ${dataBrAno(hoje)}*` : `📋 *Contas de hoje ainda em aberto — ${janela.replace(":", "h").replace(/h00$/, "h")}*`);
      for (const r of resultados) {
        linhas.push("", `*${nomeDe(r.unidadeId)}*`);
        if (!r.disponivel) { linhas.push("⚠️ Financeiro indisponível agora — não consegui conferir as contas desta unidade."); continue; }
        if (!r.hoje.length) { linhas.push(primeira ? "Nenhuma conta vence hoje." : "Nada em aberto do que vence hoje."); continue; }
        if (valores) linhas.push(...limitar(r.hoje.map((t) => linhaConta(t))), `Total: ${reais(somar(r.hoje, (t) => t.saldoCentavos))} (${plural(r.hoje.length, "conta", "contas")})`);
        else linhas.push(`${plural(r.hoje.length, "conta vence", "contas vencem")} hoje.`);
      }
      if (valores && resultados.filter((r) => r.hoje.length).length > 1) linhas.push("", `*Total de hoje:* ${reais(somar(resultados, (r) => somar(r.hoje, (t) => t.saldoCentavos)))}`);
    }
    if (totalVencidas > 0) {
      linhas.push("", "⚠️ *Vencidas em aberto*");
      for (const r of resultados.filter((x) => x.vencidas.length)) {
        if (valores) linhas.push(`_${nomeDe(r.unidadeId)}_`, ...limitar(r.vencidas.map((t) => linhaConta(t, { comVencimento: true }))), `Total vencido: ${reais(somar(r.vencidas, (t) => t.saldoCentavos))}`);
        else linhas.push(`${nomeDe(r.unidadeId)}: ${plural(r.vencidas.length, "conta vencida", "contas vencidas")}.`);
      }
    }
    if (entre.length) {
      linhas.push("", "🔁 *Contas entre empresas (reembolso — não é despesa nem receita)*");
      if (valores) {
        for (const i of entreDevidas) linhas.push(`• ${i.nomeDevedora} deve à ${i.nomeCredora} — ${textoCurto(i.descricao)} — saldo ${reais(i.saldoCentavos)} (vence ${dataBr(i.vencimento)})`);
        const sem = entre.filter((i) => !i.vencimento);
        const futuras = entre.filter((i) => i.vencimento && i.vencimento > hoje);
        if (sem.length) linhas.push(`Em aberto sem vencimento registrado: ${plural(sem.length, "conta", "contas")}, ${reais(somar(sem, (i) => i.saldoCentavos))}.`);
        if (futuras.length) linhas.push(`A vencer: ${plural(futuras.length, "conta", "contas")}, ${reais(somar(futuras, (i) => i.saldoCentavos))}.`);
        // por direção (devedora → credora) e o líquido INDICATIVO entre o par — nenhuma compensação é feita automaticamente
        const direcoes = new Map();
        for (const i of entre) { const k = `${i.nomeDevedora} → ${i.nomeCredora}`; direcoes.set(k, (direcoes.get(k) ?? 0) + i.saldoCentavos); }
        for (const [k, v] of direcoes) linhas.push(`${k}: ${reais(v)}`);
        const pares = new Map();
        for (const [k, v] of direcoes) { const [d, c] = k.split(" → "); const par = [d, c].sort().join("|"); const sinal = d < c ? 1 : -1; pares.set(par, (pares.get(par) ?? 0) + sinal * v); }
        for (const [par, v] of pares) {
          const [x, y] = par.split("|");
          if (direcoes.has(`${x} → ${y}`) && direcoes.has(`${y} → ${x}`) && v !== 0) linhas.push(`Líquido indicativo: ${v > 0 ? x : y} deve ${reais(Math.abs(v))} à ${v > 0 ? y : x} (sem compensação automática).`);
        }
      } else linhas.push(`${plural(entre.length, "conta", "contas")} entre empresas em aberto${entreDevidas.length ? ` (${entreDevidas.length} com reembolso vencendo até hoje)` : ""}.`);
    }
    if (indisponiveis.length && !primeira && totalHoje === 0) linhas.push("", `⚠️ Não consegui conferir: ${indisponiveis.map((r) => nomeDe(r.unidadeId)).join(", ")} (Financeiro indisponível). Não dá para afirmar que tudo foi pago.`);
    if (!valores) linhas.push("", "Valores e fornecedores: no Centro Financeiro (este grupo não está liberado para valores).");
    return linhas.join("\n");
  }

  /** Um passo da rotina (chamado a cada poucos minutos). Idempotente. */
  async function passo() {
    const { data: hoje, minutos: agoraMin } = agoraLocal(relogio());
    const feitos = [];
    for (const grupo of grupos()) {
      for (const [indice, janela] of janelas.entries()) {
        const inicio = minutos(janela);
        if (agoraMin < inicio) continue;
        const chave = { grupoId: grupo.grupoId, data: hoje, janela };
        if (await a.avisos.obter(chave)) continue; // já avisado (inclusive por outra instância ou antes do reinício)
        if (agoraMin > inicio + tolerancia) { continue; } // janela perdida: não manda aviso velho fora de hora
        const resultados = [];
        for (const u of grupo.unidades) if (unidadeDe(u)) resultados.push(await consultarUnidade(u, hoje));
        if (!resultados.length) continue;
        if (resultados.some((r) => !r.disponivel) && agoraMin < inicio + espera) { feitos.push({ ...chave, adiado: "FINANCEIRO_INDISPONIVEL" }); continue; } // tenta de novo no próximo passo
        const detalhe = await nivelDeDetalhe(grupo);
        // janela anterior do MESMO dia (para o "todas pagas" das 15h), só contagens
        const anterior = indice > 0 ? (await a.avisos.obter({ grupoId: grupo.grupoId, data: hoje, janela: janelas[indice - 1] }))?.resumo ?? null : null;
        const entre = entreEmpresasDoGrupo(resultados.filter((r) => r.disponivel));
        const texto = montarTexto({ hoje, janela, primeira: indice === 0 || !anterior, resultados, entre, valores: detalhe.valores, anterior });
        const resumo = {
          porUnidade: Object.fromEntries(resultados.map((r) => [r.unidadeId, { disponivel: r.disponivel, hoje: r.hoje.length, hojeCentavos: somar(r.hoje, (t) => t.saldoCentavos), vencidas: r.vencidas.length, vencidasCentavos: somar(r.vencidas, (t) => t.saldoCentavos) }])),
          entreEmpresas: entre.length, valores: detalhe.valores, motivoDetalhe: detalhe.motivo, enviado: texto !== null,
        };
        // sem nada a dizer (ex.: 15h sem contas o dia todo): registra a janela assim mesmo (sem mensagem), para não reconsultar
        const r = texto === null
          ? await a.avisos.registrarSemMensagem({ ...chave, resumo })
          : await a.avisos.registrarEEnfileirar({ ...chave, resumo, texto });
        if (!r.repetido) registrar({ tipo: texto === null ? "MOVA_AVISO_DIARIO_SEM_MENSAGEM" : "MOVA_AVISO_DIARIO_ENFILEIRADO", grupo: mascarar(grupo.grupoId), data: hoje, janela, valores: detalhe.valores });
        feitos.push({ ...chave, repetido: r.repetido, enviado: texto !== null, respostaId: r.respostaId ?? null });
      }
    }
    return feitos;
  }

  return Object.freeze({ passo, janelas });
}
