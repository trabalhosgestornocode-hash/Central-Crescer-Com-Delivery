// Trava de concorrência por unidade da coleta Foody — COMPARTILHADA entre a sincronização manual e o agendador.
//
//   1. em memória (um Set por processo): duas coletas da mesma unidade no mesmo processo nunca se sobrepõem;
//   2. no banco: execução EM_ANDAMENTO recente (< janela) de outra instância (deploy sobreposto) bloqueia; a mais velha é encerrada
//      como FALHOU/ABANDONADA antes de abrir a nova, para nunca travar para sempre;
//   3. (migration 150, quando aplicada) índice único parcial: uma única EM_ANDAMENTO por unidade — fecha a corrida residual
//      entre (2) e a abertura da execução. Sem a 150, (1)+(2) seguem valendo.
export const JANELA_CONCORRENCIA_MS = 60 * 60_000;

export class FoodyTravaErro extends Error {
  constructor(mensagem) { super(mensagem); this.name = "FoodyTravaErro"; this.codigo = "CONCORRENCIA"; }
}

/** Estado do processo: um único Set compartilhado pela rota manual e pelo agendador embutido. */
export const UNIDADES_EM_COLETA = new Set();

/**
 * Reserva a unidade. Devolve `{ liberar, abandonadas }`; lança FoodyTravaErro (codigo CONCORRENCIA) se já houver coleta.
 * @param {{ t:{organizacaoId,unidadeId}, conexaoId:string, repo:object, agora?:()=>Date, emCurso?:Set, janelaMs?:number }} p
 */
export async function reservarUnidade({ t, conexaoId, repo, agora = () => new Date(), emCurso = UNIDADES_EM_COLETA, janelaMs = JANELA_CONCORRENCIA_MS }) {
  if (emCurso.has(t.unidadeId)) throw new FoodyTravaErro("já há uma sincronização desta unidade em andamento.");
  emCurso.add(t.unidadeId);
  const liberar = () => { emCurso.delete(t.unidadeId); };
  try {
    const abertas = await repo.listarExecucoesEmAndamento(t, conexaoId);
    const agoraMs = agora().getTime();
    if (abertas.some((e) => agoraMs - Date.parse(e.iniciado_em) < janelaMs)) {
      throw new FoodyTravaErro("já há uma sincronização desta unidade em andamento (outra instância, o agendador ou a tela).");
    }
    for (const e of abertas) await repo.concluirExecucao(t, e.id, { status: "FALHOU", erro_codigo: "ABANDONADA" });
    return { liberar, abandonadas: abertas.length };
  } catch (e) {
    liberar();
    throw e;
  }
}
