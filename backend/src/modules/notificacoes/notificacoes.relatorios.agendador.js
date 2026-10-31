// AGENDADOR dos relatórios operacionais (diário + semanal). NÃO é ligado no server.js: só roda quando alguém chama `criarAgendadorRelatorios(...).iniciar()`
// e, mesmo assim, exige NOTIFICACOES_RELATORIOS_AGENDADOR_HABILITADO=true (fail-closed). O ENVIO real tem a sua própria trava
// (NOTIFICACOES_RELATORIOS_ENVIO_HABILITADO + lista de números autorizados); sem ela o ciclo só gera fechamentos e enfileira.
//
// Cada ciclo (a cada 15 min): (1) garante o fechamento de ONTEM de cada unidade (mesma função e idempotência do agendador do Dashboard 2.0);
// (2) enfileira o diário e, na segunda-feira local, o semanal — só para unidades com módulo + integração de pedidos + dado válido;
// (3) despacha a fila. Idempotente: repetir o ciclo não duplica fechamento, resumo nem envio (chaves únicas + CAS no banco).
// Uma unidade com erro nunca impede as outras.
import { executarCiclo as gerarFechamentosDeOntem } from "../checklist-operacional/checklistOperacional.agendador.js";
import { unidadesComIntegracaoViva } from "./notificacoes.relatorios.integracao.js";
import { enfileirarRelatoriosDaUnidade } from "./notificacoes.relatorios.servico.js";
import { processarFilaRelatorios } from "./notificacoes.relatorios.envio.js";
import { unidadesCandidatas } from "./notificacoes.relatorios.repository.js";

export const INTERVALO_PADRAO_MS = 15 * 60_000;
export const agendadorRelatoriosPermitido = (env = process.env) => String(env?.NOTIFICACOES_RELATORIOS_AGENDADOR_HABILITADO ?? "").trim().toLowerCase() === "true";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * PILOTO por unidade: NOTIFICACOES_RELATORIOS_UNIDADES_PILOTO (ids de unidade, separados por vírgula). Definida ⇒ SÓ essas unidades entram no ciclo
 * (inclusive a geração do fechamento); valor inválido/vazio-com-vírgulas ⇒ NENHUMA (fail-closed). Ausente ⇒ todas as elegíveis (disponibilidade geral).
 * @returns {Set<string>|null}
 */
export function unidadesPiloto(env = process.env) {
  const bruto = String(env?.NOTIFICACOES_RELATORIOS_UNIDADES_PILOTO ?? "").trim();
  if (!bruto) return null;
  const ids = bruto.split(",").map((x) => x.trim());
  return new Set(ids.every((x) => UUID.test(x)) ? ids.map((x) => x.toLowerCase()) : []);
}

/**
 * Um ciclo completo.
 * @param {{agora?: () => Date, env?: object, deps?: {candidatas?: Function, funil?: Function, gerar?: Function, enfileirar?: Function, despachar?: Function, [k: string]: any}}} p
 */
export async function executarCicloRelatorios({ agora = () => new Date(), env = process.env, deps = {} } = {}) {
  const piloto = unidadesPiloto(env);
  const todas = await (deps.candidatas ?? unidadesCandidatas)(deps.repoDeps ?? {});
  const candidatas = piloto ? todas.filter((u) => piloto.has(String(u.unidadeId).toLowerCase())) : todas;
  const { elegiveis, recusadas } = await (deps.funil ?? ((u) => unidadesComIntegracaoViva(u, { agora, deps: deps.integracaoDeps ?? {} })))(candidatas);
  // (1) fechamento de ontem de cada unidade elegível (nunca de unidade sem integração: não há o que fechar)
  const geracao = await (deps.gerar ?? gerarFechamentosDeOntem)({ unidades: elegiveis.map((u) => ({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId })), agora, deps: deps.opDeps ?? {} });
  // (2) enfileiramento
  const enfileirados = [];
  for (const u of elegiveis) {
    try { enfileirados.push(await (deps.enfileirar ?? enfileirarRelatoriosDaUnidade)({ ...u, modulosEfetivos: u.modulosEfetivos ?? ["checklist_operacional"] }, { agora, deps: deps.servicoDeps ?? {} })); }
    catch (e) { enfileirados.push({ unidadeId: u.unidadeId, erro: String(e?.message ?? e).slice(0, 200) }); }
  }
  // (3) despacho (desligado por padrão: devolve { desligado: true })
  const envio = await (deps.despachar ?? processarFilaRelatorios)({ agora, env, deps: deps.envioDeps ?? {} });
  return { recusadas: recusadas.map((u) => ({ unidadeId: u.unidadeId, motivo: u.motivo })), geracao, enfileirados, envio };
}

/** @param {{env?: object, agora?: () => Date, intervaloMs?: number, deps?: object, temporizador?: {set: Function, clear: Function}, aoTerminarCiclo?: Function}} p */
export function criarAgendadorRelatorios({ env = process.env, agora = () => new Date(), intervaloMs = INTERVALO_PADRAO_MS, deps = {}, temporizador = { set: setInterval, clear: clearInterval }, aoTerminarCiclo = () => {} } = {}) {
  let handle = null; let emCurso = false;
  const ciclo = async () => {
    if (emCurso) return null;                               // nunca dois ciclos sobrepostos no mesmo processo
    emCurso = true;
    try { const r = await executarCicloRelatorios({ agora, env, deps }); aoTerminarCiclo(r); return r; }
    catch (e) { aoTerminarCiclo({ erro: String(e?.message ?? e).slice(0, 200) }); return null; }
    finally { emCurso = false; }
  };
  return {
    ciclo,
    iniciar() {
      if (!agendadorRelatoriosPermitido(env)) throw Object.assign(new Error("Agendador dos relatórios recusado: NOTIFICACOES_RELATORIOS_AGENDADOR_HABILITADO não está ligado."), { codigo: "AGENDADOR_RELATORIOS_DESLIGADO" });
      if (handle) return;
      handle = temporizador.set(ciclo, intervaloMs); handle?.unref?.();
    },
    parar() { if (handle) { temporizador.clear(handle); handle = null; } },
  };
}
