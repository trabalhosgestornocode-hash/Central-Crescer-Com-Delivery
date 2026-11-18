// AGENDADOR do fechamento semanal de entregadores, embutido no backend (sem serviço pago novo, sem depender do navegador).
// DESLIGADO POR PADRÃO. Roda de hora em hora; o próprio ciclo decide o que fazer e é idempotente: execução perdida é refeita.
//   FV2_ENTREGADORES_AGENDADOR_HABILITADO=1
//   FV2_ENTREGADORES_INICIO=AAAA-MM-DD       primeira segunda-feira automática (nada anterior é fechado sozinho)
//   FV2_ENTREGADORES_UNIDADES=org:unidade:identidade[,...]   identidade de automação com concessão própria (ver + registrar)
import { ACAO } from "../financeiro-v2/dominio/contexto.js";
import { IDENTIDADE_DE_AUTOMACAO } from "../financeiro-v2/dominio/entregadoresProprios.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ITEM = new RegExp(`^(${UUID}):(${UUID}):(${UUID})$`, "i");
export const INTERVALO_MS = 60 * 60_000;

/** Configuração estrita: qualquer item inválido desliga tudo (falha fechada). */
export function lerConfiguracaoDoAgendador(env) {
  if (env.FV2_ENTREGADORES_AGENDADOR_HABILITADO !== "1") return { habilitado: false, motivo: "DESLIGADO" };
  if (env.FV2_HABILITADO !== "1" || env.FV2_ESCRITA_HABILITADA !== "1") return { habilitado: false, motivo: "FINANCEIRO_SEM_ESCRITA" };
  if (env.FV2_AUTORIDADE_MODO !== "local") return { habilitado: false, motivo: "EXIGE_AUTORIDADE_LOCAL" };
  const inicio = String(env.FV2_ENTREGADORES_INICIO ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio) || new Date(`${inicio}T12:00:00Z`).getUTCDay() !== 1) return { habilitado: false, motivo: "INICIO_INVALIDO" };
  const itens = String(env.FV2_ENTREGADORES_UNIDADES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const unidades = itens.map((s) => ITEM.exec(s)).map((m) => (m ? { organizacaoId: m[1].toLowerCase(), unidadeId: m[2].toLowerCase(), usuarioId: m[3].toLowerCase() } : null));
  if (!unidades.length || unidades.some((u) => !u || u.usuarioId !== IDENTIDADE_DE_AUTOMACAO)) return { habilitado: false, motivo: "UNIDADES_INVALIDAS" };
  return { habilitado: true, inicio, unidades };
}

/** Uma passada por todas as unidades configuradas. Erro de uma unidade nunca impede as outras. */
export async function executarCiclo({ unidades, criarNucleo, comAutomacao, unidadeLiberada, registrar = () => {} }) {
  const saida = [];
  for (const u of unidades) {
    try {
      if (!(await unidadeLiberada(u))) { saida.push({ unidadeId: u.unidadeId, ignorada: "ESCRITA_DA_UNIDADE_DESLIGADA" }); continue; }
      const ctx = { ...u, permissoes: [ACAO.VER, ACAO.REGISTRAR] };
      const r = await comAutomacao(() => criarNucleo(u).executarCicloDeEntregadores(ctx));
      saida.push({ unidadeId: u.unidadeId, semanas: r.semanas.length, contas: r.semanas.reduce((n, s) => n + (s.contasCriadas ?? 0), 0), pendentes: r.semanas.filter((s) => s.situacao === "PENDENTE").length });
    } catch (e) {
      saida.push({ unidadeId: u.unidadeId, erro: String(e?.codigo ?? "ERRO_INTERNO").slice(0, 40) });
    }
  }
  registrar({ tipo: "ENTREGADORES_CICLO", itens: saida });
  return saida;
}

export function criarAgendadorEntregadores({ executar, intervaloMs = INTERVALO_MS, atrasoInicialMs = 5 * 60_000, temporizador = { set: setTimeout, clear: clearTimeout } }) {
  let ativo = false; let pendente = null; let rodando = null;
  const tique = () => {
    if (!ativo || rodando) return rodando;
    rodando = Promise.resolve().then(executar).catch(() => {}).finally(() => { rodando = null; if (ativo) { pendente = temporizador.set(tique, intervaloMs); pendente?.unref?.(); } });
    return rodando;
  };
  return {
    iniciar() { if (ativo) return; ativo = true; pendente = temporizador.set(tique, atrasoInicialMs); pendente?.unref?.(); },
    parar() { ativo = false; if (pendente) temporizador.clear(pendente); pendente = null; return rodando ?? Promise.resolve(); },
    tique, get ativo() { return ativo; },
  };
}
