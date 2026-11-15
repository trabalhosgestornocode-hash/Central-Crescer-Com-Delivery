// AÇÕES (escrita) do Financeiro v2 pela plataforma (Execução 10). Cada uma chama a operação REAL do núcleo, que confere
// permissão por ação, escopo, versão esperada, estado e grava histórico na mesma transação; a sessão de banco vem do
// gateway e o banco confere concessão e RLS de novo. Nada aqui decide regra financeira.
//
// Ligadas SÓ com FV2_ESCRITA_HABILITADA=1 (além de FV2_HABILITADO). Ficam FORA nesta fase:
//   - envio e abertura de arquivos (cofre sem antimalware efetivo) → 503;
//   - homologar: além do segundo fator, exige FV2_HOMOLOGACAO_HABILITADA=1 (matriz 24a ainda não aprovada).
// Conceder, revogar, homologar e reabrir exigem prova de segundo fator RECENTE (adaptador + verificador do provedor).
import { ACAO, CODIGO, ErroFinanceiro, tempo } from "../financeiro-v2/index.js";
import { CATEGORIA_TITULOS_ANTERIORES } from "../financeiro-v2/dominio/planoDeContas.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NENHUM = "00000000-0000-4000-8000-000000000000";
/** Identificador vindo da tela: só UUID; qualquer outra coisa vira um id que não existe (o núcleo responde "não encontrado"). */
export const id = (v) => (typeof v === "string" && UUID.test(v) ? v.toLowerCase() : NENHUM);
/** Chave de pendência ("CODIGO:uuid:..."): cada parte que parece id precisa ser UUID. */
const chave = (v) => String(v ?? "").slice(0, 400);
/** "1.234,56" → 123456 (estrito; sem ponto flutuante). Inválido segue como texto e o núcleo recusa. */
export const centavos = (v) => { const t = String(v ?? "").trim().replace(/\./g, ""); const m = /^(\d{1,9})(?:,(\d{1,2}))?$/.exec(t); return m ? Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0")) : t; };
const inteiro = (v) => (/^\d{1,9}$/.test(String(v ?? "")) ? Number(v) : v);
const marcado = (v) => v === true || v === "on" || v === "true";
const semVazios = (b, campos) => Object.fromEntries(campos.filter((k) => b[k] !== undefined && b[k] !== "").map((k) => [k, b[k]]));
const acoesMarcadas = (b) => Object.values(ACAO).filter((a) => marcado(b[`acao_${a.split(".")[1]}`]));
const indisponivel = (mensagem) => () => { throw Object.assign(new Error(mensagem), { codigoHttp: 503, codigo: "COFRE_INDISPONIVEL" }); };

const erroDeEntrada = (mensagem, codigo = CODIGO.ENTRADA_INVALIDA, campo = null) => new ErroFinanceiro(codigo, mensagem, campo ? { campo } : {});
/** Referência documental EXTERNA (cofre desligado): só texto; nunca afirma que um anexo foi conferido. */
const referenciaExterna = (v) => {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  if (t.length < 5 || t.length > 160) throw erroDeEntrada("Informe a origem do valor (documento, extrato ou contagem), com 5 a 160 caracteres.", CODIGO.ENTRADA_INVALIDA, "origem");
  return t;
};
export const SEM_ANEXO = "referência externa; sem anexo verificado no sistema";
const competenciaValida = (v) => { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v ?? ""))) throw erroDeEntrada("Competência inválida (AAAA-MM).", CODIGO.ENTRADA_INVALIDA, "competencia"); return v; };
/** Véspera da competência de início: o saldo de abertura é a posição comprovada no ENCERRAMENTO desse dia. */
export const vesperaDaCompetencia = (competencia) => tempo.somarDias(`${competenciaValida(competencia)}-01`, -1);
const chaveDoFormulario = (b, prefixo) => (b.chave ? { fonte: { sistema: "MANUAL", idExterno: `${prefixo}:${id(b.chave)}` } } : {});
/** Devedor de um recebível manual: processador (só título ANTERIOR), cliente existente ou cliente novo (mesma transação). */
function devedor(b, { aceitaProcessador, ref }) {
  const informados = [b.processador, b.cliente, b.clienteNovo].filter((v) => v !== undefined && v !== null && v !== "");
  if (informados.length !== 1) throw erroDeEntrada("Informe quem deve: um processador, um cliente cadastrado ou o nome de um cliente novo (só um).", CODIGO.ENTRADA_INVALIDA, "processador");
  if (b.processador) {
    // Recebível do período com processador nasce da VENDA e do demonstrativo; registrá-lo à mão duplicaria o repasse.
    if (!aceitaProcessador) throw erroDeEntrada("Repasses de processadores (Stone, iFood…) do período nascem das vendas e demonstrativos: não registre à mão.", CODIGO.ENTRADA_INVALIDA, "processador");
    return { processador: String(b.processador) };
  }
  if (b.cliente) return { contraparteId: ref(b.cliente) };
  return { contraparteNova: { tipo: "CLIENTE", nome: String(b.clienteNovo).slice(0, 120) } };
}
const fornecedor = (b, ref) => (b.fornecedor ? { contraparteId: ref(b.fornecedor) } : { contraparteNova: { tipo: "FORNECEDOR", nome: String(b.fornecedorNovo ?? "").slice(0, 120) } });
const comOrigem = (descricao, origem) => `${String(descricao ?? "").trim()} · origem: ${referenciaExterna(origem)} (${SEM_ANEXO})`.slice(0, 500);

/**
 * ABERTURA FINANCEIRA (doc 29) — formulários que faltavam para receber os primeiros dados reais. Mesma regra de todas as
 * escritas: só a operação do núcleo decide; escopo da sessão; histórico na transação; reenvio do mesmo formulário (chave)
 * não duplica. Nenhum valor é presumido: todo número vem do formulário, com a origem informada.
 * @param {{ hoje?: () => string, ref?: (v:any) => string }} [o] data de hoje e tradução de identificadores (a demonstração usa
 *   o relógio e as referências opacas dela; a plataforma, UUID)
 */
export function escritasDaAbertura({ hoje = () => tempo.hojeEm(new Date()), ref = id } = {}) {
  return Object.freeze({
    // Contas: Unicred, caixa físico e as que vierem depois. Sem campo de saldo (saldo é registrado à parte, com origem).
    "/configuracoes/conta/criar": { campos: ["tipo", "nome", "instituicao"], fazer: (n, c, b) => n.configurarContaFinanceira(c, { tipo: b.tipo, nome: b.nome, ...(b.instituicao ? { instituicao: b.instituicao } : {}) }) },
    // Saldo de ABERTURA: posição comprovada no FIM da véspera da competência de início (ex.: 31/10 para 2026-11).
    "/abertura/saldo": { campos: ["conta", "competencia", "valor", "origem"], fazer: (n, c, b) => n.registrarSaldoDeConta(c, {
      contaId: ref(b.conta), data: vesperaDaCompetencia(b.competencia), referencia: "FIM_DO_DIA", valorCentavos: centavos(b.valor),
      observacao: `Saldo de abertura da competência ${b.competencia} · origem: ${referenciaExterna(b.origem)} (${SEM_ANEXO})`.slice(0, 300),
    }) },
    // Conta a pagar ANTERIOR à abertura: posição inicial do passivo (categoria patrimonial do sistema, fora da DRE).
    "/abertura/obrigacao-anterior": { campos: ["fornecedor", "fornecedorNovo", "descricao", "valor", "competencia", "dataEmissao", "vencimento", "origem", "chave"], fazer: (n, c, b) => n.registrarObrigacao(c, {
      ...fornecedor(b, ref), valorOriginalCentavos: centavos(b.valor), categoria: CATEGORIA_TITULOS_ANTERIORES, descricao: comOrigem(b.descricao, b.origem),
      competencia: competenciaValida(b.competencia), dataEmissao: b.dataEmissao, vencimento: b.vencimento, ...chaveDoFormulario(b, "abertura-obrigacao"),
    }) },
    // Conta a receber ANTERIOR à abertura: o saldo a receber (sem retenções, sem venda, nenhuma receita nova).
    "/abertura/recebivel-anterior": { campos: ["processador", "cliente", "clienteNovo", "descricao", "valor", "competencia", "dataOrigem", "vencimento", "origem", "chave"], fazer: (n, c, b) => n.registrarRecebivel(c, {
      ...devedor(b, { aceitaProcessador: true, ref }), brutoCentavos: centavos(b.valor), competencia: competenciaValida(b.competencia), dataOrigem: b.dataOrigem,
      ...(b.vencimento ? { dataPrevista: b.vencimento } : {}), anteriorAAbertura: true, descricao: comOrigem(b.descricao, b.origem), ...chaveDoFormulario(b, "abertura-recebivel"),
    }) },
    // Conta a receber do período (cliente): repasse de processador NÃO entra por aqui (nasce da venda).
    "/recebiveis/registrar": { campos: ["processador", "cliente", "clienteNovo", "descricao", "valor", "competencia", "vencimento", "chave"], fazer: (n, c, b) => n.registrarRecebivel(c, {
      ...devedor(b, { aceitaProcessador: false, ref }), brutoCentavos: centavos(b.valor), competencia: b.competencia, ...(b.vencimento ? { dataPrevista: b.vencimento } : {}),
      ...(b.descricao ? { descricao: b.descricao } : {}), ...chaveDoFormulario(b, "recebivel"),
    }) },
    // Caixa físico: abertura com o dinheiro CONTADO (não é faturamento nem receita), operações e fechamento.
    "/caixa/abrir": { campos: ["conta", "data", "contado", "observacao"], fazer: (n, c, b) => n.abrirCaixa(c, { contaId: ref(b.conta), dataAbertura: b.data, saldoContadoCentavos: centavos(b.contado), ...(b.observacao ? { observacao: b.observacao } : {}) }) },
    "/caixa/operacao": { campos: ["sessao", "operacao", "valor", "data", "descricao", "contraConta", "chave"], fazer: (n, c, b) => n.registrarOperacaoDeCaixa(c, {
      sessaoId: ref(b.sessao), operacao: b.operacao, valorCentavos: centavos(b.valor), data: b.data, descricao: b.descricao,
      ...(b.contraConta ? { contraContaId: ref(b.contraConta) } : {}), ...(b.chave ? { chave: id(b.chave) } : {}),
    }) },
    "/caixa/fechar": { campos: ["sessao", "data", "contado", "justificativa"], fazer: (n, c, b) => n.fecharCaixa(c, { sessaoId: ref(b.sessao), dataFechamento: b.data, contadoCentavos: centavos(b.contado), ...(b.justificativa ? { justificativa: b.justificativa } : {}), confirmar: true }) },
    // Plano de contas: implantação só com o NOME do modelo redigitado (confirmação que o servidor confere). Idempotente.
    "/configuracoes/implantar-plano": { campos: ["modelo", "modeloConfirmado"], fazer: (n, c, b) => {
      if (typeof b.modelo !== "string" || b.modeloConfirmado !== b.modelo) throw erroDeEntrada("Para implantar, digite o nome do modelo exatamente como aparece.", CODIGO.CONFIRMACAO_EXIGIDA, "modeloConfirmado");
      return n.implantarPlanoDeContas(c, { modelo: b.modelo });
    } },
    // Conciliação: procurar candidatas (a tela já chamava esta ação; nenhuma candidata é confirmada automaticamente).
    "/conciliacoes/gerar": { campos: ["competencia"], fazer: (n, c, b) => {
      const fim = tempo.ultimoDiaDe(competenciaValida(b.competencia));
      const h = hoje();
      return n.gerarCandidatasDeConciliacao(c, { relacao: "SAIPOS_X_STONE", periodoInicio: `${b.competencia}-01`, periodoFim: fim < h ? fim : h });
    } },
  });
}

/** Ação de MFA exigida por uma mudança de estado da competência (conservador: voltar a ABERTA é reabrir). */
export function acaoSensivelDoFechamento(b) {
  if (b?.novoEstado === "FECHAMENTO_HOMOLOGADO") return ACAO.HOMOLOGAR;
  if (b?.novoEstado === "ABERTA") return ACAO.REABRIR;
  return null;
}

/** caminho → { campos, sensivel?(corpo) → ACAO|null, fazer(núcleo, contexto, corpo) } */
export const ESCRITAS = Object.freeze({
  "/importacao/receber": { campos: [], fazer: indisponivel("Envio de arquivos indisponível: o cofre documental ainda não tem verificação antimalware.") },
  "/documentos/enviar": { campos: [], fazer: indisponivel("Envio de arquivos indisponível: o cofre documental ainda não tem verificação antimalware.") },
  "/documentos/verificar": { campos: [], fazer: indisponivel("Verificação de arquivos indisponível enquanto o cofre estiver desligado.") },
  "/importacao/confirmar": { campos: ["importacao", "impressaoPrevia", "aceitarPendencias", "justificativa"], fazer: (n, c, b) => n.confirmarImportacao(c, { importacaoId: id(b.importacao), impressaoPrevia: b.impressaoPrevia, ...(b.aceitarPendencias === true ? { aceitarPendencias: true } : {}), ...(b.justificativa ? { justificativa: b.justificativa } : {}) }) },
  "/importacao/rejeitar": { campos: ["importacao", "justificativa"], fazer: (n, c, b) => n.rejeitarImportacao(c, { importacaoId: id(b.importacao), justificativa: b.justificativa }) },
  "/propostas/gerar": { campos: ["importacao"], fazer: (n, c, b) => n.gerarPropostas(c, { importacaoId: id(b.importacao) }) },
  "/propostas/aprovar": { campos: ["proposta", "justificativa"], fazer: (n, c, b) => n.aprovarProposta(c, { propostaId: id(b.proposta), ...(b.justificativa ? { justificativa: b.justificativa } : {}) }) },
  "/propostas/rejeitar": { campos: ["proposta", "justificativa"], fazer: (n, c, b) => n.rejeitarProposta(c, { propostaId: id(b.proposta), justificativa: b.justificativa }) },
  "/propostas/aplicar": { campos: ["proposta"], fazer: (n, c, b) => n.aplicarProposta(c, { propostaId: id(b.proposta) }) },
  // `chave` (UUID do formulário): o MESMO envio repetido (clique duplo, rede) devolve o registro já gravado, sem duplicar.
  "/obrigacoes/registrar": { campos: ["fornecedor", "fornecedorNovo", "descricao", "valor", "categoria", "competencia", "dataEmissao", "vencimento", "chave"], fazer: (n, c, b) => n.registrarObrigacao(c, {
    ...(b.fornecedor ? { contraparteId: id(b.fornecedor) } : { contraparteNova: { tipo: "FORNECEDOR", nome: String(b.fornecedorNovo ?? "").slice(0, 120) } }),
    valorOriginalCentavos: centavos(b.valor), categoria: b.categoria, descricao: b.descricao, competencia: b.competencia, dataEmissao: b.dataEmissao, vencimento: b.vencimento,
    ...(b.chave ? { fonte: { sistema: "MANUAL", idExterno: `formulario:${id(b.chave)}` } } : {}),
  }) },
  "/obrigacoes/vincular-extrato": { campos: ["obrigacao", "movimentacao", "versao", "valor", "documento", "justificativa", "pagamentoAntecipado"], fazer: (n, c, b) => n.vincularPagamentoDoExtrato(c, {
    movimentacaoId: id(b.movimentacao), versaoMovimentacao: inteiro(b.versao), alocacoes: [{ obrigacaoId: id(b.obrigacao), valorCentavos: centavos(b.valor) }],
    ...(b.documento ? { documentoId: id(b.documento) } : {}), justificativa: b.justificativa, confirmar: true, ...(marcado(b.pagamentoAntecipado) ? { pagamentoAntecipado: true } : {}),
  }) },
  "/obrigacoes/pagar": { campos: ["obrigacao", "conta", "dataEfetiva", "valor"], fazer: (n, c, b) => n.pagarContaAPagar(c, { obrigacaoId: id(b.obrigacao), contaId: id(b.conta), dataEfetiva: b.dataEfetiva, valorCentavos: centavos(b.valor) }) },
  "/saldos/registrar": { campos: ["conta", "data", "referencia", "valor", "observacao"], fazer: (n, c, b) => n.registrarSaldoDeConta(c, { contaId: id(b.conta), data: b.data, referencia: b.referencia, valorCentavos: centavos(b.valor), ...(b.observacao ? { observacao: b.observacao } : {}) }) },
  "/reclassificar": { campos: ["lancamento", "categoria", "justificativa", "versaoEsperada", "documento"], fazer: (n, c, b) => n.reclassificarLancamento(c, {
    lancamentoId: id(b.lancamento), categoria: b.categoria, justificativa: b.justificativa, versaoEsperada: inteiro(b.versaoEsperada), ...(b.documento ? { documentoId: id(b.documento) } : {}),
  }) },
  "/conciliacoes/confirmar": { campos: ["correspondencia", "justificativa"], fazer: (n, c, b) => n.confirmarConciliacao(c, { correspondenciaId: id(b.correspondencia), ...(b.justificativa ? { justificativa: b.justificativa } : {}) }) },
  "/conciliacoes/rejeitar": { campos: ["correspondencia", "justificativa"], fazer: (n, c, b) => n.rejeitarCorrespondencia(c, { correspondenciaId: id(b.correspondencia), justificativa: b.justificativa }) },
  "/pendencias/documentar": { campos: ["competencia", "chave", "descricao", "impacto", "decisao", "documentacaoFaltante", "justificativa"], fazer: (n, c, b) => n.documentarPendenciaDoFechamento(c, {
    competencia: b.competencia, ...(b.justificativa ? { justificativa: b.justificativa } : {}),
    pendencia: { chave: chave(b.chave), descricao: b.descricao, impacto: b.impacto, ...(b.decisao ? { decisao: b.decisao } : {}), ...(b.documentacaoFaltante ? { documentacaoFaltante: b.documentacaoFaltante } : {}) },
  }) },
  "/pendencias/atribuir": { campos: ["competencia", "chave", "responsavel", "dataRevisao", "comentario", "justificativa"], fazer: (n, c, b) => n.atribuirResponsavelDePendencia(c, {
    competencia: b.competencia, chave: chave(b.chave), responsavelId: id(b.responsavel),
    ...(b.dataRevisao ? { dataRevisao: b.dataRevisao } : {}), ...(b.comentario ? { comentario: b.comentario } : {}), ...(b.justificativa ? { justificativa: b.justificativa } : {}),
  }) },
  "/pendencias/acompanhar": { campos: ["competencia", "chave", "situacao", "comentario"], fazer: (n, c, b) => n.atualizarAcompanhamentoDePendencia(c, { competencia: b.competencia, chave: chave(b.chave), situacao: b.situacao, ...(b.comentario ? { comentario: b.comentario } : {}) }) },
  "/fechamento/alterar": { campos: ["competencia", "novoEstado", "metodologia", "justificativa"], sensivel: acaoSensivelDoFechamento, fazer: (n, c, b) => n.alterarEstadoDaCompetencia(c, {
    competencia: b.competencia, novoEstado: b.novoEstado, confirmar: true, ...(b.metodologia ? { metodologia: b.metodologia } : {}), ...(b.justificativa ? { justificativa: b.justificativa } : {}),
  }) },
  "/permissoes/conceder": { campos: ["usuario", "justificativa", ...Object.values(ACAO).map((a) => `acao_${a.split(".")[1]}`)], sensivel: () => ACAO.CONCEDER, fazer: (n, c, b) => n.concederAcesso(c, { usuarioId: id(b.usuario), acoes: acoesMarcadas(b), justificativa: b.justificativa }) },
  "/permissoes/revogar": { campos: ["usuario", "justificativa", ...Object.values(ACAO).map((a) => `acao_${a.split(".")[1]}`)], sensivel: () => ACAO.REVOGAR, fazer: (n, c, b) => n.revogarAcesso(c, { usuarioId: id(b.usuario), ...(acoesMarcadas(b).length ? { acoes: acoesMarcadas(b) } : {}), justificativa: b.justificativa }) },
  "/configuracoes/unidade": { campos: ["nomeExibicao", "identificacaoEmpresa", "situacao", "observacao", "justificativa"], fazer: (n, c, b) => n.configurarUnidade(c, semVazios(b, ["nomeExibicao", "identificacaoEmpresa", "situacao", "observacao", "justificativa"])) },
  "/configuracoes/canal": { campos: ["papel", "codigo", "codigoBase", "nome", "situacao", "observacao", "justificativa"], fazer: (n, c, b) => n.registrarCanalOuProcessador(c, semVazios(b, ["papel", "codigo", "codigoBase", "nome", "situacao", "observacao", "justificativa"])) },
  "/configuracoes/conta": { campos: ["conta", "nome", "ativa", "justificativa"], fazer: (n, c, b) => n.alterarContaFinanceira(c, { contaId: id(b.conta), ...(b.nome ? { nome: b.nome } : {}), ...(b.ativa === "true" || b.ativa === "false" ? { ativa: b.ativa === "true" } : {}), justificativa: b.justificativa }) },
  "/configuracoes/categoria": { campos: ["codigo", "nome", "ativa", "justificativa"], fazer: (n, c, b) => n.alterarCategoria(c, { codigo: b.codigo, mudancas: { ...(b.nome ? { nome: b.nome } : {}), ...(b.ativa === "true" || b.ativa === "false" ? { ativa: b.ativa === "true" } : {}) }, justificativa: b.justificativa }) },
  ...escritasDaAbertura(),
});
