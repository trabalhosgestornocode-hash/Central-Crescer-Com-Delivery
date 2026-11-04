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
//
// CONEXÃO COMPARTILHADA (145, flag FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED): a coleta continua ÚNICA, na unidade TITULAR.
//   * flag desligada OU conexão sem nenhum destino → exatamente o comportamento acima (147);
//   * destino ATIVO (aprovado pelas duas organizações) → classificação ESTRITA por catálogo versionado e distribuição por
//     operação (foody.roteamento.js); item desconhecido = TRIAGEM, nunca Subway por padrão;
//   * destino que deixou de estar ativo (revogado) → volta a regra da 144, e as linhas que estavam ativas no destino são
//     DESATIVADAS (sem apagar) antes de a linha nova ser gravada na titular.
//   Um uid nunca fica ativo em dois tenants: a linha antiga é desativada ANTES da nova ser gravada (o banco reforça com
//   uq_foody_pedidos_conexao_uid_ativo). Toda leitura "da conexão" confere o tenant de cada linha devolvida.
import { unidadePermitida, compartilhamentoPermitido } from "./foody.flags.js";
import { janelaDoDia, validarCompetencia, situacaoCompetencia } from "./foody.periodo.js";
import { criarClienteFoody, FoodyApiErro } from "./foody.client.js";
import { sanearPedidoApi, ehOutraOperacao } from "./foody.adapter.js";
import { rotearPedido, indexarDestinos, chaveTenant, ROTA, CAMPOS_DESATIVACAO } from "./foody.roteamento.js";
import { CATALOGO_OPERACAO } from "./foody.catalogo-operacao.js";
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
  const catalogo = deps?.catalogo ?? CATALOGO_OPERACAO; // alternativo só em teste/avaliação; produção usa o versionado
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

  // Destinos só são lidos com a flag de compartilhamento ligada; sem ela, nada muda em relação à 147.
  const destinosTodos = compartilhamentoPermitido(env) ? await repo.listarDestinosDaConexao(t, conexao.id) : [];
  for (const d of destinosTodos) {
    if (d.conexao_id !== conexao.id || d.organizacao_titular_id !== organizacaoId) {
      throw new FoodySyncErro("TENANT_DIVERGENTE", "destino não pertence a esta conexão.");
    }
  }
  const destinosAtivos = destinosTodos.filter((d) => d.estado === "ATIVO");
  const porConexao = destinosTodos.length > 0;      // reconciliação pela conexão (há ou houve destino)
  const compartilhado = destinosAtivos.length > 0;  // classificação estrita + distribuição
  let indiceDestinos;
  try { indiceDestinos = indexarDestinos(destinosAtivos, t); } catch (e) { throw new FoodySyncErro("DESTINO_INVALIDO", e.message); }

  const janela = janelaDoDia(competencia);
  const execucaoId = await repo.abrirExecucao(t, {
    conexao_id: conexao.id, competencia, janela_inicio: janela.inicio, janela_fim: janela.fim, origem, regra_versao: FOODY_REGRA_VERSAO,
  });
  log("info", "foody.sync.inicio", { unidade: unidadeId, competencia, origem, execucaoId }, { segredos });

  try {
    // Limites opcionais (sincronização MANUAL): menos páginas por dia e teto de pedidos ANTES de gravar qualquer linha.
    const limites = deps?.limites ?? {};
    const cliente = criarCliente(Number.isInteger(limites.maxPaginas) && limites.maxPaginas > 0 ? { token, maxPaginas: limites.maxPaginas } : { token });
    const { pedidos, cobertura } = await cliente.listarPedidos(janela);
    if (Number.isInteger(limites.maxPedidos) && cobertura.unicos > limites.maxPedidos) {
      throw new FoodySyncErro("LIMITE_PEDIDOS", `mais de ${limites.maxPedidos} pedidos no dia — nada foi gravado.`);
    }

    const errosSaneamento = {};
    let foraJanela = 0, pontoDivergente = 0;
    const pontosDivergentes = new Set();
    // Comparação tolerante a caixa, acento e espaços (renomear "Subway Saci" para "SUBWAY  SACI" não perde pedido).
    const esperado = conexao.ponto_coleta_esperado ? normalizarNome(conexao.ponto_coleta_esperado) : null;
    const registros = [];
    for (const o of pedidos) {
      const r = sanearPedidoApi(o, { hashEntregador: seguranca.hashEntregador, compartilhado, catalogo: deps?.catalogo });
      if (r.erro) { errosSaneamento[r.erro] = (errosSaneamento[r.erro] || 0) + 1; continue; }
      if (r.registro.competencia !== competencia) { foraJanela++; continue; }
      if (esperado && normalizarNome(r.registro.ponto_coleta) !== esperado) {
        pontoDivergente++;
        if (pontosDivergentes.size < 5) pontosDivergentes.add(r.registro.ponto_coleta ?? "(sem ponto de coleta)");
        continue;
      }
      registros.push(r.registro);
    }

    let inseridos = 0, atualizados = 0, inalterados = 0, ausentes = 0, distribuicao = null;
    const agoraIso = agora().toISOString();
    const recebidos = new Set(registros.map((r) => r.foody_uid));
    if (!porConexao) {
      const existentes = await repo.carregarExistentes(t, registros.map((r) => r.foody_uid));
      const linhas = [];
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
      ausentes = (await repo.listarUidsDaCompetencia(t, competencia)).filter((u) => !recebidos.has(u)).length;
    } else {
      const d = await distribuirPelaConexao({ t, conexao, registros, destinosTodos, indiceDestinos, compartilhado, execucaoId, agoraIso, repo });
      ({ inseridos, atualizados, inalterados, distribuicao } = d);
      ausentes = (await repo.listarUidsAtivosDaConexao(conexao.id, competencia, d.permitidos)).filter((u) => !recebidos.has(u)).length;
    }

    const pendencias = [];
    const totalErros = Object.values(errosSaneamento).reduce((s, n) => s + n, 0);
    if (totalErros) pendencias.push({ codigo: "PEDIDO_MALFORMADO", quantidade: totalErros, porMotivo: errosSaneamento });
    if (cobertura.semUid) pendencias.push({ codigo: "PEDIDO_SEM_UID", quantidade: cobertura.semUid });
    // Ponto de coleta divergente NUNCA é perda silenciosa: o pedido não é gravado nesta unidade (pode ser de outra loja da
    // mesma conta), mas a cobertura do dia passa a INCOMPLETA — o fechamento sai INCOMPLETO/PROVISORIO, com os nomes vistos.
    if (pontoDivergente) pendencias.push({ codigo: "PONTO_COLETA_DIVERGENTE", quantidade: pontoDivergente, pontosVistos: [...pontosDivergentes] });
    // Ausente: o pedido gravado continuaria nos totais sem estar mais na API — o dia não pode sair como consolidado.
    if (ausentes) pendencias.push({ codigo: "PEDIDO_AUSENTE_NA_API", quantidade: ausentes });
    // Nenhum pedido no dia: pode ser loja fechada, mas também conta/janela errada. Nunca vira "consolidado com zero".
    if (cobertura.unicos === 0) pendencias.push({ codigo: "SEM_PEDIDOS_NA_JANELA", quantidade: 0 });
    // Triagem: pedido sem evidência segura de operação. Não é perda de cobertura, mas deixa os fechamentos de TODAS as
    // organizações do vínculo PROVISÓRIOS até a decisão (nenhuma pode consolidar sem saber de quem é o pedido).
    if (distribuicao?.triagem) pendencias.push({ codigo: "TRIAGEM_PENDENTE", quantidade: distribuicao.triagem });

    const resumo = {
      execucaoId, competencia, origem,
      cobertura: {
        completa: totalErros === 0 && cobertura.semUid === 0 && pontoDivergente === 0 && ausentes === 0 && cobertura.unicos > 0,
        janelaInicio: janela.inicio, janelaFim: janela.fim, paginas: cobertura.paginas, pedidosUnicos: cobertura.unicos,
        pendencias,
      },
      contagens: { recebidos: cobertura.recebidos, unicos: cobertura.unicos, foraJanela, pontoDivergente, inseridos, atualizados, inalterados },
    };
    if (porConexao) {
      resumo.cobertura.triagemPendente = distribuicao.triagem;
      resumo.compartilhamento = {
        titular: { organizacaoId, unidadeId },
        destinos: destinosAtivos.map((d) => ({ destinoId: d.id, organizacaoId: d.organizacao_id, unidadeId: d.unidade_id, operacao: d.operacao })),
        distribuicao, catalogoVersao: compartilhado ? catalogo.versao : null,
      };
    }
    await repo.concluirExecucao(t, execucaoId, {
      status: "CONCLUIDA", paginas: cobertura.paginas, pedidos_recebidos: cobertura.recebidos, pedidos_unicos: cobertura.unicos,
      pedidos_fora_janela: foraJanela, pedidos_ponto_divergente: pontoDivergente, inseridos, atualizados, inalterados,
      ...(porConexao ? { pedidos_triagem: distribuicao.triagem, distribuicao, catalogo_versao: compartilhado ? catalogo.versao : null } : {}),
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

/**
 * Distribuição pela CONEXÃO (148). Ordem: rotear todos → DESATIVAR as linhas que mudaram de tenant → gravar por tenant.
 * Devolve só contagens (sem valores).
 */
async function distribuirPelaConexao({ t, conexao, registros, destinosTodos, indiceDestinos, compartilhado, execucaoId, agoraIso, repo }) {
  const tenantDe = (r) => ({ organizacaoId: r.organizacao_id, unidadeId: r.unidade_id });
  const permitidos = new Set([chaveTenant(t), ...destinosTodos.map((d) => chaveTenant(tenantDe(d)))]);
  const uids = registros.map((r) => r.foody_uid);
  const decisoes = compartilhado ? await repo.listarDecisoesTriagem(t, conexao.id, uids) : new Map();
  const ativos = await repo.carregarAtivosDaConexao(conexao.id, uids, permitidos);

  const distribuicao = { titular: 0, minimo: 0, triagem: 0, destinos: {}, reclassificados: 0, decididosNaTriagem: 0 };
  const gravar = new Map();     // tenant → { tenant, linhas }
  const desativar = new Map();  // tenant → { tenant, uids }
  let inseridos = 0, atualizados = 0, inalterados = 0;
  for (const r of registros) {
    let rota, tenant, linha;
    if (compartilhado) {
      const decisao = decisoes.get(r.foody_uid) ?? null;
      ({ rota, tenant, linha } = rotearPedido(r, { titular: t, destinos: indiceDestinos, decisao }));
      if (decisao) distribuicao.decididosNaTriagem++;
    } else {
      // Nenhum destino ativo (revogado): regra da 147 na titular — o adaptador já minimizou a outra operação.
      rota = ehOutraOperacao(r.operacao) ? ROTA.MINIMO : ROTA.TITULAR;
      tenant = t;
      linha = { ...r, destino_id: null, triagem_motivo: null, catalogo_versao: null };
    }
    if (rota === ROTA.DESTINO) distribuicao.destinos[linha.operacao] = (distribuicao.destinos[linha.operacao] ?? 0) + 1;
    else distribuicao[rota]++;

    const k = chaveTenant(tenant);
    const ativo = ativos.get(r.foody_uid);
    const kAtivo = ativo ? chaveTenant(tenantDe(ativo)) : null;
    if (ativo && kAtivo !== k) {
      if (!desativar.has(kAtivo)) desativar.set(kAtivo, { tenant: tenantDe(ativo), uids: [] });
      desativar.get(kAtivo).uids.push(r.foody_uid);
      distribuicao.reclassificados++;
      atualizados++;
    } else if (ativo && ativo.fonte_hash === linha.fonte_hash) {
      inalterados++;
      continue;
    } else if (ativo) {
      // Mesmo tenant, operação diferente (ex.: triagem → Subway por nova versão do catálogo ou decisão): também é reclassificação.
      if (ativo.operacao !== linha.operacao) distribuicao.reclassificados++;
      atualizados++;
    } else {
      inseridos++; // pode reativar uma linha antiga do mesmo tenant: o upsert reaproveita a linha
    }
    if (!gravar.has(k)) gravar.set(k, { tenant, linhas: [] });
    gravar.get(k).linhas.push({ ...linha, organizacao_id: tenant.organizacaoId, unidade_id: tenant.unidadeId, conexao_id: conexao.id,
      roteamento_ativo: true, ultima_execucao_id: execucaoId, sincronizado_em: agoraIso, atualizado_em: agoraIso });
  }

  for (const { tenant, uids: lista } of desativar.values()) {
    await repo.desativarPedidos(tenant, conexao.id, lista, "RECLASSIFICADO", CAMPOS_DESATIVACAO);
  }
  for (const { tenant, linhas } of gravar.values()) {
    const existentes = await repo.carregarExistentes(tenant, linhas.map((l) => l.foody_uid));
    for (const l of linhas) l.primeira_execucao_id = existentes.get(l.foody_uid)?.primeira_execucao_id ?? execucaoId;
    await repo.gravarPedidos(tenant, linhas);
  }
  return { inseridos, atualizados, inalterados, distribuicao, permitidos };
}
