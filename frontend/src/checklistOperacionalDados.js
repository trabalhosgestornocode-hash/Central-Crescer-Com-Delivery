// Checklist Operacional — ADAPTADOR dos dados reais (funções puras, sem DOM/estado/fetch).
//
// Converte a resposta de GET /api/v1/checklist-operacional/resumo no `ResumoChecklist` que os componentes já
// conhecem (contrato em checklistOperacionalModelo.js). A tela não muda: só a origem dos dados.
//
// Também decide o AVISO da faixa no topo — sempre escrito, nunca só cor:
//   integração não ativada · nenhum pedido registrado no período · dados desatualizados · sem conexão
// Valor ausente continua ausente: nada aqui completa número, horário ou avaliação.

const ESTADO_SELO = { ao_vivo: "ao_vivo", desatualizado: "desatualizado", nao_ativada: "sem_dados" };

/** Sem resposta boa por mais que N intervalos, a própria tela passa a se declarar desatualizada. */
export const INTERVALOS_ATE_ENVELHECER = 3;

const indicadorVazio = () => ({ disponivel: true, motivo: null, ultimo: null, mediaDia: null, amostras: 0 });

/** Aviso da faixa a partir do estado da integração e do dia. */
export function avisoDe(dados) {
  const i = dados?.integracao ?? {};
  // Unidade sem loja iFood vinculada: o Checklist abre normalmente, sem números — nada é inventado.
  if (dados?.modo === "sem_integracao") {
    return { tom: "neutro", titulo: "Unidade sem integração com o iFood", texto: "Os pedidos, os tempos e as médias aparecem aqui quando a loja desta unidade for conectada ao iFood. Nenhum número é estimado enquanto isso." };
  }
  if (i.estado === "nao_ativada") return { tom: "neutro", titulo: "Integração não ativada", texto: i.mensagem ?? null };
  if (i.estado === "desatualizado") return { tom: "atencao", titulo: "Dados desatualizados", texto: i.mensagem ?? null };
  if (dados?.semPedidosNoDia) return { tom: "neutro", titulo: "Nenhum pedido registrado no período", texto: "Os indicadores aparecem com o primeiro pedido do dia operacional." };
  return null;
}

const finitoPositivo = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Metas que vieram no resumo (fonte única: o servidor). Valores fora do formato = ignorados (fica o `reserva`, que é a
 * última configuração válida desta tela). `info` diz de onde vieram, para a tela e o diálogo explicarem.
 * @returns {{valores: object, info: {origem: 'unidade'|'padrao'|'indisponivel'|'local', versao: number|null, atualizadoEm: string|null, atualizadoPor: string|null, motivo?: string}}}
 */
export function metasDoResumo(dados, reserva) {
  const m = dados?.metas;
  const ok = m?.valores && ["preparo", "entrega", "vida"].every((k) => finitoPositivo(m.valores[k]?.meta) && finitoPositivo(m.valores[k]?.avisoPct));
  if (!ok) return { valores: reserva, info: { origem: "local", versao: null, atualizadoEm: null, atualizadoPor: null } };
  return {
    valores: m.valores,
    info: { origem: m.origem ?? "unidade", versao: Number.isInteger(m.versao) ? m.versao : null, atualizadoEm: m.atualizadoEm ?? null, atualizadoPor: m.atualizadoPor ?? null, motivo: m.motivo ?? null },
  };
}

/** Tela antes da primeira resposta: nada de número, só "conectando". */
export function resumoCarregando({ unidade, metas }) {
  return {
    origem: "api",
    unidade: { id: unidade?.id ?? null, nome: unidade?.nome ?? "Unidade" },
    conexao: { estado: "carregando", ultimaSincronizacao: null },
    metas,
    indicadores: { preparo: indicadorVazio(), entrega: indicadorVazio(), vida: { ...indicadorVazio(), decomposicao: null } },
    pedidosAtivos: [],
    ultimosPedidos: [],
    avaliacoes: { disponivel: false },
    contagemDia: { concluidos: 0, cancelados: 0 },
    alertas: [],
    aviso: { tom: "neutro", titulo: "Carregando", texto: "Buscando o resumo da unidade." },
    relogioOffsetMs: 0,
    atualizarEmS: 30,
    avisosTempoReal: false,
    recebidoEmMs: null,
  };
}

/**
 * Resposta da API → ResumoChecklist.
 * @param {object} dados `data` do endpoint
 * @param {{unidade: {id: string, nome: string}, metas: object, recebidoEmMs: number}} ctx
 *   `recebidoEmMs`: Date.now() do aparelho na chegada — com `servidorEm`, corrige o relógio da TV.
 */
export function adaptarResumo(dados, { unidade, metas, recebidoEmMs }) {
  const servidor = Date.parse(dados?.servidorEm);
  const m = metasDoResumo(dados, metas);
  return {
    origem: "api",
    unidade: { id: unidade?.id ?? null, nome: unidade?.nome ?? "Unidade" },
    conexao: { estado: ESTADO_SELO[dados?.integracao?.estado] ?? "sem_dados", ultimaSincronizacao: dados?.integracao?.ultimaSincronizacao ?? null },
    metas: m.valores,
    metasInfo: m.info,
    indicadores: {
      preparo: dados?.indicadores?.preparo ?? indicadorVazio(),
      entrega: dados?.indicadores?.entrega ?? indicadorVazio(),
      vida: dados?.indicadores?.vida ?? { ...indicadorVazio(), decomposicao: null },
    },
    pedidosAtivos: dados?.pedidosAtivos ?? [],
    ultimosPedidos: dados?.ultimosPedidos ?? [],
    avaliacoes: dados?.avaliacoes ?? { disponivel: false },
    contagemDia: dados?.contagemDia ?? { concluidos: 0, cancelados: 0 },
    alertas: dados?.alertas ?? [],
    // Várias lojas iFood na unidade: contagem por loja (rótulo, estado, recebidos…). Vazio com uma loja só.
    lojas: Array.isArray(dados?.lojas) ? dados.lojas : [],
    aviso: avisoDe(dados),
    diaOperacional: dados?.diaOperacional ?? null,
    relogioOffsetMs: Number.isFinite(servidor) ? servidor - recebidoEmMs : 0,
    atualizarEmS: Number.isFinite(dados?.atualizarEmS) && dados.atualizarEmS >= 10 ? dados.atualizarEmS : 30,
    // Só `true` explícito do servidor: emissão de avisos ligada E recebimento ao vivo (sem isso, polling).
    avisosTempoReal: dados?.tempoReal?.avisosAtivos === true,
    recebidoEmMs,
  };
}

/** A consulta falhou: mantém o último retrato (marcado), troca o selo e explica. Nunca zera nem inventa. */
export function marcarFalha(resumo, erro) {
  const semPermissao = erro?.status === 403;
  return {
    ...resumo,
    conexao: { ...resumo.conexao, estado: "indisponivel" },
    aviso: semPermissao
      ? { tom: "critico", titulo: "Sem acesso", texto: "Este perfil não tem permissão para ver o Checklist Operacional desta unidade, ou a empresa não tem o módulo habilitado." }
      : {
        tom: "critico",
        titulo: resumo.recebidoEmMs ? "Dados desatualizados" : "Sem conexão",
        texto: resumo.recebidoEmMs ? "Sem conexão com a Central. Mostrando os últimos dados recebidos; tentando de novo." : "Não foi possível falar com a Central. Tentando de novo.",
      },
  };
}

/** A tela ficou sem resposta boa por tempo demais (ex.: aba congelada, rede lenta)? */
export function envelhecido(resumo, agoraLocalMs) {
  if (!resumo?.recebidoEmMs) return false;
  return agoraLocalMs - resumo.recebidoEmMs > INTERVALOS_ATE_ENVELHECER * (resumo.atualizarEmS ?? 30) * 1000;
}

/** Marca o retrato como desatualizado pela idade (sem mexer nos números). */
export function marcarEnvelhecido(resumo) {
  return {
    ...resumo,
    conexao: { ...resumo.conexao, estado: "desatualizado" },
    aviso: { tom: "atencao", titulo: "Dados desatualizados", texto: "A tela não recebe atualização há alguns minutos." },
  };
}

/** Assinatura do que é VISÍVEL: resposta igual à anterior não redesenha a tela (sem reiniciar pulsos). */
export function assinaturaDados(dados) {
  if (!dados) return "";
  // Horários que mudam a cada ciclo sem mudar a tela: o tique de 1 s já atualiza o texto da sincronização.
  const { servidorEm: _s, integracao, ...resto } = dados;
  const { ultimaSincronizacao: _u, ultimoEventoEm: _e, ...estadoIntegracao } = integracao ?? {};
  return JSON.stringify({ ...resto, integracao: estadoIntegracao });
}
