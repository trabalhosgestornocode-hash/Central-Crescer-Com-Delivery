// Sincronização de UMA competência de UMA unidade: API Foody (GET) → saneamento → upsert deduplicado em foody_pedidos.
//
// Ordem das travas (todas fail-closed):
//   1. flag mestre ligada E unidade na allowlist;
//   2. competência válida, já encerrada; dia CONGELADO só com origem=reprocessamento E motivo;
//   3. conexão da PRÓPRIA unidade/organização, ATIVA; token decifra com o AAD da unidade E bate com a impressão gravada;
//   4. só então abre a execução e chama a API.
// Ponto de coleta: o filtro é OPCIONAL (ponto_coleta_esperado nulo = sem filtro; a conta pertence à unidade). Quando definido,
// pedido de outro ponto NÃO é gravado, mas o dia fica com cobertura INCOMPLETA (fechamento INCOMPLETO/PROVISORIO) e a pendência
// traz os nomes vistos — nunca há perda silenciosa. Pedido de outra OPERAÇÃO (ex.: Açaí) é gravado na unidade dona da conta,
// marcado com a operação; nunca é roteado para outro tenant.
import { unidadePermitida } from "./foody.flags.js";
import { janelaDoDia, validarCompetencia, situacaoCompetencia } from "./foody.periodo.js";
import { criarClienteFoody, FoodyApiErro } from "./foody.client.js";
import { sanearPedidoApi } from "./foody.adapter.js";
import { impressaoToken, foodyLog, normalizarNome } from "./foody.seguranca.js";
import { FOODY_REGRA_VERSAO, ORIGEM } from "./foody.constants.js";

export class FoodySyncErro extends Error {
  constructor(codigo, mensagem) { super(mensagem); this.name = "FoodySyncErro"; this.codigo = codigo; }
}

/**
 * @param {{organizacaoId:string, unidadeId:string, competencia:string, origem?:string, motivo?:string}} pedido
 * @param {{env?:object, repo:object, seguranca:object, criarCliente?:Function, agora?:()=>Date, log?:Function}} deps
 */
export async function sincronizarCompetencia(pedido, deps) {
  const { organizacaoId, unidadeId, competencia, origem = ORIGEM.MANUAL, motivo = null } = pedido ?? {};
  const { env = process.env, repo, seguranca, criarCliente = criarClienteFoody, agora = () => new Date(), log = foodyLog } = deps ?? {};
  const t = { organizacaoId, unidadeId };

  if (!unidadePermitida(env, unidadeId)) throw new FoodySyncErro("DESLIGADO", "camada central Foody desligada para esta unidade.");
  if (!organizacaoId) throw new FoodySyncErro("TENANT_AUSENTE", "organização obrigatória.");
  if (!Object.values(ORIGEM).includes(origem)) throw new FoodySyncErro("ORIGEM_INVALIDA", "origem inválida.");
  if (!validarCompetencia(competencia)) throw new FoodySyncErro("COMPETENCIA_INVALIDA", "competência inválida.");
  const situacao = situacaoCompetencia(competencia, agora());
  if (situacao === "FUTURA_OU_ABERTA") throw new FoodySyncErro("COMPETENCIA_ABERTA", "só dias encerrados são sincronizados.");
  if (situacao === "CONGELADA" && !(origem === ORIGEM.REPROCESSAMENTO && String(motivo ?? "").trim())) {
    throw new FoodySyncErro("COMPETENCIA_CONGELADA", "dia congelado: exige reprocessamento explícito com motivo.");
  }

  const conexao = await repo.obterConexao(t);
  if (!conexao) throw new FoodySyncErro("SEM_CONEXAO", "unidade sem conexão Foody.");
  if (conexao.organizacao_id !== organizacaoId || conexao.unidade_id !== unidadeId) {
    throw new FoodySyncErro("TENANT_DIVERGENTE", "conexão não pertence a esta unidade/organização.");
  }
  if (conexao.status !== "ATIVA") throw new FoodySyncErro("CONEXAO_INATIVA", `conexão ${conexao.status}.`);

  let token;
  try { token = seguranca.decifrarToken(conexao.token_cifrado, unidadeId); } catch {
    throw new FoodySyncErro("TOKEN_INVALIDO", "token não decifra para esta unidade.");
  }
  if (impressaoToken(token) !== conexao.token_impressao) throw new FoodySyncErro("TOKEN_DIVERGENTE", "token não confere com a impressão gravada.");
  const segredos = [token];

  const janela = janelaDoDia(competencia);
  const execucaoId = await repo.abrirExecucao(t, {
    conexao_id: conexao.id, competencia, janela_inicio: janela.inicio, janela_fim: janela.fim, origem, regra_versao: FOODY_REGRA_VERSAO,
  });
  log("info", "foody.sync.inicio", { unidade: unidadeId, competencia, origem, execucaoId }, { segredos });

  try {
    const cliente = criarCliente({ token });
    const { pedidos, cobertura } = await cliente.listarPedidos(janela);

    const errosSaneamento = {};
    let foraJanela = 0, pontoDivergente = 0;
    const pontosDivergentes = new Set();
    // Comparação tolerante a caixa, acento e espaços (renomear "Subway Saci" para "SUBWAY  SACI" não perde pedido).
    const esperado = conexao.ponto_coleta_esperado ? normalizarNome(conexao.ponto_coleta_esperado) : null;
    const registros = [];
    for (const o of pedidos) {
      const r = sanearPedidoApi(o, { hashEntregador: seguranca.hashEntregador });
      if (r.erro) { errosSaneamento[r.erro] = (errosSaneamento[r.erro] || 0) + 1; continue; }
      if (r.registro.competencia !== competencia) { foraJanela++; continue; }
      if (esperado && normalizarNome(r.registro.ponto_coleta) !== esperado) {
        pontoDivergente++;
        if (pontosDivergentes.size < 5) pontosDivergentes.add(r.registro.ponto_coleta ?? "(sem ponto de coleta)");
        continue;
      }
      registros.push(r.registro);
    }

    const existentes = await repo.carregarExistentes(t, registros.map((r) => r.foody_uid));
    let inseridos = 0, atualizados = 0, inalterados = 0;
    const linhas = [];
    const agoraIso = agora().toISOString();
    for (const r of registros) {
      const ant = existentes.get(r.foody_uid);
      if (ant && ant.fonte_hash === r.fonte_hash) { inalterados++; continue; }
      if (ant) atualizados++; else inseridos++;
      linhas.push({
        ...r, organizacao_id: organizacaoId, unidade_id: unidadeId,
        primeira_execucao_id: ant?.primeira_execucao_id ?? execucaoId, ultima_execucao_id: execucaoId,
        sincronizado_em: agoraIso, atualizado_em: agoraIso,
      });
    }
    if (linhas.length) await repo.gravarPedidos(t, linhas);

    // Pedido que já estava gravado para o dia e não veio mais na API: nunca é apagado — vira pendência.
    const recebidos = new Set(registros.map((r) => r.foody_uid));
    const ausentes = (await repo.listarUidsDaCompetencia(t, competencia)).filter((u) => !recebidos.has(u)).length;

    const pendencias = [];
    const totalErros = Object.values(errosSaneamento).reduce((s, n) => s + n, 0);
    if (totalErros) pendencias.push({ codigo: "PEDIDO_MALFORMADO", quantidade: totalErros, porMotivo: errosSaneamento });
    if (cobertura.semUid) pendencias.push({ codigo: "PEDIDO_SEM_UID", quantidade: cobertura.semUid });
    // Ponto de coleta divergente NUNCA é perda silenciosa: o pedido não é gravado nesta unidade (pode ser de outra loja da
    // mesma conta), mas a cobertura do dia passa a INCOMPLETA — o fechamento sai INCOMPLETO/PROVISORIO, com os nomes vistos.
    if (pontoDivergente) pendencias.push({ codigo: "PONTO_COLETA_DIVERGENTE", quantidade: pontoDivergente, pontosVistos: [...pontosDivergentes] });
    if (ausentes) pendencias.push({ codigo: "PEDIDO_AUSENTE_NA_API", quantidade: ausentes });

    const resumo = {
      execucaoId, competencia, origem,
      cobertura: {
        completa: totalErros === 0 && cobertura.semUid === 0 && pontoDivergente === 0,
        janelaInicio: janela.inicio, janelaFim: janela.fim, paginas: cobertura.paginas, pedidosUnicos: cobertura.unicos,
        pendencias,
      },
      contagens: { recebidos: cobertura.recebidos, unicos: cobertura.unicos, foraJanela, pontoDivergente, inseridos, atualizados, inalterados },
    };
    await repo.concluirExecucao(t, execucaoId, {
      status: "CONCLUIDA", paginas: cobertura.paginas, pedidos_recebidos: cobertura.recebidos, pedidos_unicos: cobertura.unicos,
      pedidos_fora_janela: foraJanela, pedidos_ponto_divergente: pontoDivergente, inseridos, atualizados, inalterados,
    });
    await repo.marcarConexao(t, conexao.id, { ultimo_erro_codigo: null, ultima_sync_em: agoraIso });
    log("info", "foody.sync.fim", { unidade: unidadeId, competencia, execucaoId, ...resumo.contagens, completa: resumo.cobertura.completa }, { segredos });
    return resumo;
  } catch (e) {
    const codigo = e instanceof FoodyApiErro || e?.codigo ? String(e.codigo) : "ERRO_INTERNO";
    try {
      await repo.concluirExecucao(t, execucaoId, { status: "FALHOU", erro_codigo: /^[A-Z_]{2,40}$/.test(codigo) ? codigo : "ERRO_INTERNO" });
      await repo.marcarConexao(t, conexao.id, { ultimo_erro_codigo: /^[A-Z_]{2,40}$/.test(codigo) ? codigo : "ERRO_INTERNO" });
    } catch { /* o erro original é o que importa */ }
    log("error", "foody.sync.falha", { unidade: unidadeId, competencia, execucaoId, codigo, erro: e }, { segredos });
    const erro = new FoodySyncErro(codigo, `sincronização falhou (${codigo}).`);
    erro.execucaoId = execucaoId;
    throw erro;
  }
}
