// AÇÕES (escrita) do Financeiro v2 pela plataforma (Execução 10). Cada uma chama a operação REAL do núcleo, que confere
// permissão por ação, escopo, versão esperada, estado e grava histórico na mesma transação; a sessão de banco vem do
// gateway e o banco confere concessão e RLS de novo. Nada aqui decide regra financeira.
//
// Ligadas SÓ com FV2_ESCRITA_HABILITADA=1 (além de FV2_HABILITADO). Ficam FORA nesta fase:
//   - envio e abertura de arquivos (cofre sem antimalware efetivo) → 503;
//   - homologar: além do segundo fator, exige FV2_HOMOLOGACAO_HABILITADA=1 (matriz 24a ainda não aprovada).
// Conceder, revogar, homologar e reabrir exigem prova de segundo fator RECENTE (adaptador + verificador do provedor).
import { ACAO, CODIGO, ErroFinanceiro, tempo } from "../financeiro-v2/index.js";
import { taxasDoTexto } from "../financeiro-v2/dominio/taxasContratadas.js";

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
/** doc 37: relatórios aceitos na importação pela plataforma (os conferidos com arquivo real) → fonte. */
export const FONTE_DO_RELATORIO = Object.freeze({
  SAIPOS_VENDAS: "SAIPOS", SAIPOS_DESEMPENHO_POR_ATENDENTE: "SAIPOS", SAIPOS_FORMAS_PAGAMENTO: "SAIPOS", SAIPOS_FATURAMENTO_POR_DIA: "SAIPOS", SAIPOS_MOVIMENTOS_CAIXA: "SAIPOS", STONE_VENDAS: "STONE", UNICRED_EXTRATO: "UNICRED",
});
const MIME_DA_EXTENSAO = Object.freeze({ pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv", ofx: "application/x-ofx" });
/** Base64 estrito → bytes (até 5 MiB). */
function arquivoDoBase64(texto) {
  if (typeof texto !== "string" || !texto || texto.length > 7 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(texto)) throw erroDeEntrada("Arquivo ausente, inválido ou maior que 5 MiB.", CODIGO.ENTRADA_INVALIDA, "arquivoBase64");
  const bytes = new Uint8Array(Buffer.from(texto, "base64"));
  if (!bytes.byteLength || bytes.byteLength > 5 * 1024 * 1024) throw erroDeEntrada("Arquivo vazio ou maior que 5 MiB.", CODIGO.ENTRADA_INVALIDA, "arquivoBase64");
  return bytes;
}
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
const fonteObrigatoria = (v) => { if (typeof v !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw erroDeEntrada("Formulário sem chave de envio: recarregue a tela.", CODIGO.ENTRADA_INVALIDA, "chave"); return { sistema: "MANUAL", idExterno: `formulario:${v.toLowerCase()}` }; };
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
    // ABERTURA persistida (0022): competência de início e data de corte da unidade. Os formulários seguintes NÃO informam
    // competência: o núcleo usa a abertura gravada (e recusa sem ela, ou depois de concluída).
    "/abertura/configurar": { campos: ["competencia", "observacao", "justificativa"], fazer: (n, c, b) => n.configurarAbertura(c, { competencia: competenciaValida(b.competencia), ...(b.observacao ? { observacao: b.observacao } : {}), ...(b.justificativa ? { justificativa: b.justificativa } : {}) }) },
    "/abertura/concluir": { campos: ["justificativa"], fazer: (n, c, b) => n.concluirAbertura(c, { justificativa: b.justificativa }) },
    "/abertura/reabrir": { campos: ["justificativa"], sensivel: () => ACAO.REABRIR, fazer: (n, c, b) => n.reabrirAbertura(c, { justificativa: b.justificativa }) },
    // Saldo de ABERTURA: posição comprovada no FIM do dia de corte (ex.: 31/10 para início em 2026-11).
    "/abertura/saldo": { campos: ["conta", "valor", "origem"], fazer: (n, c, b) => n.registrarSaldoDeAbertura(c, { contaId: ref(b.conta), valorCentavos: centavos(b.valor), origem: referenciaExterna(b.origem) }) },
    // Conta a pagar ANTERIOR à abertura: posição inicial do passivo (categoria patrimonial do sistema, fora da DRE).
    "/abertura/obrigacao-anterior": { campos: ["fornecedor", "fornecedorNovo", "descricao", "valor", "dataEmissao", "vencimento", "origem", "identificador", "chave"], fazer: (n, c, b) => n.registrarObrigacaoAnterior(c, {
      ...fornecedor(b, ref), valorOriginalCentavos: centavos(b.valor), descricao: comOrigem(b.descricao, b.origem),
      dataEmissao: b.dataEmissao, vencimento: b.vencimento, ...(b.identificador ? { identificador: b.identificador } : {}), ...chaveDoFormulario(b, "abertura-obrigacao"),
    }) },
    // Conta a receber ANTERIOR à abertura: o saldo a receber (sem retenções, sem venda, nenhuma receita nova).
    "/abertura/recebivel-anterior": { campos: ["processador", "cliente", "clienteNovo", "descricao", "valor", "dataOrigem", "vencimento", "origem", "identificador", "chave"], fazer: (n, c, b) => n.registrarRecebivelAnterior(c, {
      ...devedor(b, { aceitaProcessador: true, ref }), brutoCentavos: centavos(b.valor), dataOrigem: b.dataOrigem,
      ...(b.vencimento ? { dataPrevista: b.vencimento } : {}), ...(b.identificador ? { identificador: b.identificador } : {}), descricao: comOrigem(b.descricao, b.origem), ...chaveDoFormulario(b, "abertura-recebivel"),
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
    // RECEITA manual (venda): sem depender de SAIPOS/iFood. A chave do formulário é OBRIGATÓRIA: o mesmo envio repetido devolve o
    // registro já gravado; outro formulário é outra venda. Dinheiro/Pix entram na conta informada; cartão/app ficam a receber
    // da operadora (o repasse nasce da venda). Nada é presumido.
    "/vendas/registrar": { campos: ["canal", "dataVenda", "valor", "forma", "processador", "conta", "dataPagamento", "descricao", "chave"], fazer: (n, c, b) => n.registrarVenda(c, {
      canal: b.canal, dataVenda: b.dataVenda, brutoCentavos: centavos(b.valor),
      pagamentos: b.forma ? [{ forma: b.forma, valorCentavos: centavos(b.valor), ...(b.processador ? { processador: b.processador } : {}), ...(b.conta ? { contaId: ref(b.conta) } : {}), ...(b.dataPagamento ? { dataPagamento: b.dataPagamento } : {}) }] : [],
      ...(b.forma ? {} : { pagamentoParcial: true }), ...(b.descricao ? { descricao: b.descricao } : {}), fonte: fonteObrigatoria(b.chave),
    }) },
    "/vendas/cancelar": { campos: ["venda", "justificativa"], fazer: (n, c, b) => n.cancelarVenda(c, { vendaId: ref(b.venda), justificativa: b.justificativa }) },
    // 17/11/2026 — correção de ENTRADA EM CONTA de um pagamento de venda (dinheiro de importação errada): estorno total por
    // correção, do mesmo motor do núcleo. Exige corrigir + cancelar, venda + pagamento + justificativa; recusa entrada conciliada.
    "/vendas/pagamento/corrigir-entrada": { campos: ["venda", "pagamento", "justificativa"], fazer: (n, c, b) => n.corrigirEntradaDePagamentoDeVenda(c, { vendaId: ref(b.venda), pagamentoId: ref(b.pagamento), justificativa: b.justificativa }) },
    // Plano de contas: implantação só com o NOME do modelo redigitado (confirmação que o servidor confere). Idempotente.
    // Categoria nova: o código é gerado do nome (sem acento, maiúsculas, _); classificação e natureza vêm da categoria superior.
  "/configuracoes/categoria-nova": { campos: ["nome", "paiCodigo"], fazer: (n, c, b) => {
    const nome = String(b.nome ?? "").trim();
    let codigo = nome.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 70);
    if (!/^[A-Z]/.test(codigo)) codigo = `CAT_${codigo}`;
    return n.registrarCategoria(c, { codigo, nome, paiCodigo: b.paiCodigo });
  } },
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
    // doc 33: contas a pagar × saídas do extrato da competência (sugestões; forte só quando inequívoca; nada é baixado aqui).
    "/conciliacoes/gerar-contas-a-pagar": { campos: ["competencia"], fazer: (n, c, b) => {
      const fim = tempo.ultimoDiaDe(competenciaValida(b.competencia));
      const h = hoje();
      return n.gerarCandidatasObrigacaoMovimentacao(c, { periodoInicio: `${b.competencia}-01`, periodoFim: fim < h ? fim : h });
    } },
  });
}

/** Ação de MFA exigida por uma mudança de estado da competência (conservador: voltar a ABERTA é reabrir). */
export function acaoSensivelDoFechamento(b) {
  if (b?.novoEstado === "FECHAMENTO_HOMOLOGADO") return ACAO.HOMOLOGAR;
  if (b?.novoEstado === "ABERTA") return ACAO.REABRIR;
  return null;
}

/**
 * Fase 04 (doc 42) — grade FIXA do formulário de fechamento manual: grupo × bandeira (cartões/voucher) ou operadora (Pix).
 * Campo `f_<GRUPO>_<SUB>_inf` = informado e `_esp` = esperado (opcional), em reais. Só as linhas preenchidas são enviadas.
 */
export const GRADE_FECHAMENTO = Object.freeze([
  ...["MASTERCARD", "VISA", "ELO", "AMEX", "HIPERCARD", "OUTRA"].map((s) => ["CREDITO", s]),
  ...["MASTERCARD", "VISA", "ELO", "OUTRA"].map((s) => ["DEBITO", s]),
  ...["MAQUININHA_IFOOD", "STONE", "PAGBANK", "DIRETO"].map((s) => ["PIX", s]),
  ...["ALELO", "PLUXEE", "VR", "TICKET", "OUTRA"].map((s) => ["VOUCHER", s]),
  ["ANOTA_AI", ""], ["OUTRA", ""], ["IFOOD_CONFERENCIA", ""], ["NOVENTA_E_NOVE_FOOD_CONFERENCIA", ""],
]);
const campoDaGrade = (g, s, k) => `f_${g}${s ? `_${s}` : ""}_${k}`;
const DINHEIRO_FECHAMENTO = ["abertura", "vendas", "retiradas", "reforcos", "transferencias", "informado"];
const CAMPOS_FECHAMENTO = Object.freeze(["data", "caixa", "responsavelAbertura", "responsavelFechamento", "horaAbertura", "horaFechamento", "observacao", "justificativa",
  ...DINHEIRO_FECHAMENTO.map((k) => `din_${k}`), ...GRADE_FECHAMENTO.flatMap(([g, s]) => [campoDaGrade(g, s, "inf"), campoDaGrade(g, s, "esp")])]);
const reaisOuNulo = (v) => (v === undefined || v === null || String(v).trim() === "" ? null : centavos(v));
const CAMPOS_FATURAMENTO = Object.freeze(["data", "caixa", "canal", "justificativa", "din_vendas", ...GRADE_FECHAMENTO.filter(([g]) => !g.endsWith("_CONFERENCIA")).map(([g, s]) => campoDaGrade(g, s, "inf"))]);
/** Faturamento manual: os MESMOS campos "Informado" da grade (sem as linhas só de conferência) + vendas em dinheiro. */
function corpoDoFaturamento(b) {
  const formas = [
    ...(reaisOuNulo(b.din_vendas) ? [{ grupo: "DINHEIRO", valorCentavos: reaisOuNulo(b.din_vendas) }] : []),
    ...GRADE_FECHAMENTO.filter(([g]) => !g.endsWith("_CONFERENCIA")).filter(([g, s]) => reaisOuNulo(b[campoDaGrade(g, s, "inf")])).map(([g, s]) => ({
      grupo: g, ...(["CREDITO", "DEBITO", "VOUCHER"].includes(g) ? { bandeira: s } : {}), ...(g === "PIX" ? { operadora: s } : {}), valorCentavos: reaisOuNulo(b[campoDaGrade(g, s, "inf")]),
    })),
  ];
  return { data: b.data, caixa: b.caixa, canal: b.canal, justificativa: b.justificativa, formas };
}
function corpoDoFechamento(b) {
  const texto = (k) => (b[k] === undefined || String(b[k]).trim() === "" ? undefined : String(b[k]));
  const dinheiro = Object.fromEntries(DINHEIRO_FECHAMENTO.map((k) => [`${k}Centavos`, reaisOuNulo(b[`din_${k}`])]));
  const formas = GRADE_FECHAMENTO.filter(([g, s]) => reaisOuNulo(b[campoDaGrade(g, s, "inf")]) !== null).map(([g, s]) => ({
    grupo: g, ...(["CREDITO", "DEBITO", "VOUCHER"].includes(g) ? { bandeira: s } : {}), ...(g === "PIX" ? { operadora: s } : {}),
    informadoCentavos: reaisOuNulo(b[campoDaGrade(g, s, "inf")]), ...(reaisOuNulo(b[campoDaGrade(g, s, "esp")]) !== null ? { esperadoCentavos: reaisOuNulo(b[campoDaGrade(g, s, "esp")]) } : {}),
  }));
  return {
    data: b.data, caixa: b.caixa, ...Object.fromEntries(["responsavelAbertura", "responsavelFechamento", "horaAbertura", "horaFechamento", "observacao", "justificativa"].filter((k) => texto(k)).map((k) => [k, texto(k)])),
    dinheiro, formas,
  };
}

/** caminho → { campos, sensivel?(corpo) → ACAO|null, fazer(núcleo, contexto, corpo) } */
export const ESCRITAS = Object.freeze({
  // doc 37: importação SEM GUARDA do arquivo (o cofre documental segue desligado): o arquivo é lido, conferido e descartado;
  // ficam a impressão digital (SHA-256) e as linhas extraídas. A fonte vem do tipo de relatório (lista fechada).
  "/importacao/receber": { campos: ["tipoRelatorio", "periodoInicio", "periodoFim", "arquivoBase64", "nomeArquivo", "tipoMime", "descricao"], fazer: (n, c, b) => {
    const fonte = FONTE_DO_RELATORIO[b.tipoRelatorio];
    if (!fonte) throw erroDeEntrada("Escolha um dos relatórios aceitos.", CODIGO.ENTRADA_INVALIDA, "tipoRelatorio");
    const conteudo = arquivoDoBase64(b.arquivoBase64);
    const tipoMime = MIME_DA_EXTENSAO[String(b.nomeArquivo ?? "").toLowerCase().split(".").pop()] ?? (typeof b.tipoMime === "string" && b.tipoMime ? b.tipoMime : "application/octet-stream");
    return n.receberArquivoParaImportacao(c, { fonte, tipoRelatorio: b.tipoRelatorio, tipoMime, conteudo, periodoInicio: b.periodoInicio, periodoFim: b.periodoFim,
      descricao: `${String(b.nomeArquivo ?? "arquivo").slice(0, 120)} (arquivo não guardado: só a impressão digital e as linhas extraídas)` });
  } },
  // Entregadores Próprios: fechamento, duplicidade, documentos, conferência, liberação e divergências. Nenhuma ação paga nada.
  "/entregadores/pagamento-historico": { campos: ["inicio", "entregador", "movimentacao", "justificativa"], fazer: (n, c, b) => n.reconhecerPagamentoHistorico(c, { inicio: b.inicio, entregador: b.entregador, movimentacaoId: id(b.movimentacao), justificativa: b.justificativa }) },
  "/entregadores/extra": { campos: ["entregador", "data", "descricao", "valor", "situacao", "meioPagamento", "origem", "justificativa", "confirmarSemDuplicidade"], fazer: (n, c, b) => {
    const [chave, ...nome] = String(b.entregador ?? "").split("|");
    const [tipo, ref] = String(b.origem ?? "").split(":");
    return n.registrarExtraDoEntregador(c, { entregador: chave, entregadorNome: nome.join("|"), data: b.data, descricao: b.descricao, valorCentavos: centavos(b.valor), situacao: b.situacao, ...(b.meioPagamento ? { meioPagamento: b.meioPagamento } : {}),
      ...(tipo === "conta" ? { obrigacaoExistenteId: id(ref) } : {}), ...(tipo === "saida" ? { movimentacaoId: id(ref) } : {}), justificativa: b.justificativa, ...(marcado(b.confirmarSemDuplicidade) ? { confirmarSemDuplicidade: true } : {}) });
  } },
  "/entregadores/extra/vincular": { campos: ["extra", "origem", "justificativa"], fazer: (n, c, b) => { const [tipo, ref] = String(b.origem ?? "").split(":"); return n.vincularExtraAoCaixa(c, { extraId: id(b.extra), ...(tipo === "conta" ? { obrigacaoExistenteId: id(ref) } : {}), ...(tipo === "saida" ? { movimentacaoId: id(ref) } : {}), justificativa: b.justificativa }); } },
  "/entregadores/extra/cancelar": { campos: ["extra", "justificativa"], fazer: (n, c, b) => n.cancelarExtraDoEntregador(c, { extraId: id(b.extra), justificativa: b.justificativa }) },
  "/entregadores/fechar": { campos: ["inicio", "reconciliacao", "aceitarDiasSemDados", "aceitarTriagem", "pedidosAdiados", "pagarEm", "justificativa"], fazer: (n, c, b) => n.fecharSemanaDeEntregadores(c, { inicio: b.inicio, ...(marcado(b.reconciliacao) ? { reconciliacao: true } : {}), ...(marcado(b.aceitarDiasSemDados) ? { aceitarDiasSemDados: true } : {}), ...(marcado(b.aceitarTriagem) ? { aceitarTriagem: true } : {}), ...(String(b.pedidosAdiados ?? "").trim() ? { adiamentos: String(b.pedidosAdiados).split(/[,;\s]+/).filter(Boolean).map((numeroPedido) => ({ numeroPedido, vencimento: b.pagarEm })) } : {}), ...(b.justificativa ? { justificativa: b.justificativa } : {}) }) },
  "/entregadores/verificar": { campos: ["inicio"], fazer: (n, c, b) => n.verificarAlteracoesDaSemana(c, { inicio: b.inicio }) },
  "/entregadores/duplicidade": { campos: ["inicio", "entregador", "decisao", "obrigacaoManual", "justificativa"], fazer: (n, c, b) => n.resolverDuplicidadeDoEntregador(c, { inicio: b.inicio, entregador: b.entregador, decisao: b.decisao, ...(b.obrigacaoManual ? { obrigacaoManualId: id(b.obrigacaoManual) } : {}), justificativa: b.justificativa }) },
  "/entregadores/documento": { campos: ["inicio", "entregador", "tipoAnexo", "numero", "emitente", "tomador", "valor", "referencia", "arquivoBase64", "nomeArquivo", "tipoMime"], fazer: (n, c, b) => n.anexarDocumentoDoEntregador(c, {
    inicio: b.inicio, entregador: b.entregador, tipoAnexo: b.tipoAnexo, numero: b.numero, emitente: b.emitente, tomador: b.tomador, referencia: b.referencia, ...(b.valor ? { valorCentavos: centavos(b.valor) } : {}),
    arquivo: { conteudo: arquivoDoBase64(b.arquivoBase64), nome: b.nomeArquivo, tipoMime: b.tipoMime },
  }) },
  "/entregadores/documento/abrir": { campos: ["inicio", "entregador", "documento"], fazer: async (n, c, b) => { const r = await n.abrirDocumentoDoEntregador(c, { inicio: b.inicio, entregador: b.entregador, documento: id(b.documento) }); return { nome: r.nomeSeguro, conteudoBase64: Buffer.from(r.conteudo).toString("base64") }; } },
  "/entregadores/conferir": { campos: ["inicio", "entregador"], fazer: (n, c, b) => n.iniciarConferenciaDaNota(c, { inicio: b.inicio, entregador: b.entregador }) },
  "/entregadores/decidir-nota": { campos: ["inicio", "entregador", "decisao", "justificativa", "emitente", "tomador", "periodo", "valor", "numero", "duplicidade"], fazer: (n, c, b) => n.decidirNotaDoEntregador(c, { inicio: b.inicio, entregador: b.entregador, decisao: b.decisao, justificativa: b.justificativa, conferido: Object.fromEntries(["emitente", "tomador", "periodo", "valor", "numero", "duplicidade"].map((k) => [k, marcado(b[k])])) }) },
  "/entregadores/liberar": { campos: ["inicio", "entregador", "demonstrativoConferido", "justificativa"], fazer: (n, c, b) => n.liberarPagamentoDoEntregador(c, { inicio: b.inicio, entregador: b.entregador, demonstrativoConferido: marcado(b.demonstrativoConferido), justificativa: b.justificativa }) },
  "/entregadores/divergencia": { campos: ["inicio", "divergencia", "decisao", "justificativa"], fazer: (n, c, b) => n.decidirDivergenciaDoEntregador(c, { inicio: b.inicio, divergencia: b.divergencia, decisao: b.decisao, justificativa: b.justificativa }) },
  "/documentos/enviar": { campos: [], fazer: indisponivel("Envio de arquivos indisponível: o cofre documental ainda não tem verificação antimalware.") },
  "/documentos/verificar": { campos: [], fazer: indisponivel("Verificação de arquivos indisponível enquanto o cofre estiver desligado.") },
  "/importacao/confirmar": { campos: ["importacao", "impressaoPrevia", "aceitarPendencias", "justificativa"], fazer: (n, c, b) => n.confirmarImportacao(c, { importacaoId: id(b.importacao), impressaoPrevia: b.impressaoPrevia, ...(b.aceitarPendencias === true ? { aceitarPendencias: true } : {}), ...(b.justificativa ? { justificativa: b.justificativa } : {}) }) },
  "/importacao/rejeitar": { campos: ["importacao", "justificativa"], fazer: (n, c, b) => n.rejeitarImportacao(c, { importacaoId: id(b.importacao), justificativa: b.justificativa }) },
  // doc 38: a conta vem da unidade quando é INEQUÍVOCA (extrato Unicred → a única conta bancária "Unicred" ativa; dinheiro
  // de pedidos → o único caixa físico ativo). Ambígua ou ausente: recusa e pede o cadastro/escolha — nunca "chuta".
  "/propostas/gerar": { campos: ["importacao", "contaBancaria", "contaCaixa"], fazer: async (n, c, b) => {
    const importacaoId = id(b.importacao);
    const imp = await n.consultarImportacao(c, { importacaoId });
    const contas = (await n.consultarConfiguracoes(c)).contas.filter((x) => x.ativa);
    const unica = (lista, oQue) => {
      if (lista.length === 1) return lista[0].id;
      throw erroDeEntrada(lista.length ? `Há mais de uma ${oQue} ativa: informe qual usar.` : `Cadastre a ${oQue} antes de gerar as propostas.`, CODIGO.OPERACAO_INVALIDA, "conta");
    };
    const extra = {};
    if (imp.fonte === "UNICRED") extra.contaBancariaId = b.contaBancaria ? id(b.contaBancaria) : unica(contas.filter((x) => x.tipo === "BANCARIA" && /unicred/i.test(`${x.nome} ${x.instituicao ?? ""}`)), "conta bancária Unicred");
    if (imp.fonte === "SAIPOS") {
      const caixas = contas.filter((x) => x.tipo === "CAIXA_FISICO");
      if (b.contaCaixa) extra.contaCaixaId = id(b.contaCaixa);
      else if (caixas.length === 1) extra.contaCaixaId = caixas[0].id;
    }
    return n.gerarPropostas(c, { importacaoId, ...extra });
  } },
  "/propostas/aprovar": { campos: ["proposta", "justificativa"], fazer: (n, c, b) => n.aprovarProposta(c, { propostaId: id(b.proposta), ...(b.justificativa ? { justificativa: b.justificativa } : {}) }) },
  "/propostas/rejeitar": { campos: ["proposta", "justificativa"], fazer: (n, c, b) => n.rejeitarProposta(c, { propostaId: id(b.proposta), justificativa: b.justificativa }) },
  "/propostas/aplicar": { campos: ["proposta"], fazer: (n, c, b) => n.aplicarProposta(c, { propostaId: id(b.proposta) }) },
  // Lote: aprova e aplica, uma a uma (cada uma na sua transação, com as mesmas checagens), as propostas PRONTAS (estado
  // PROPOSTA) da importação. As em revisão/aguardando evidência ficam para a revisão individual. Falha de uma não para o resto.
  "/propostas/aprovar-e-aplicar-prontas": { campos: ["importacao"], fazer: async (n, c, b) => {
    const importacaoId = id(b.importacao);
    // Prontas = PROPOSTA (aprova e aplica) e APROVADA ainda não aplicada (ex.: recusada antes por conflito já resolvido: só aplica).
    const todas = [...await n.listarPropostas(c, { importacaoId, estado: "PROPOSTA" }), ...await n.listarPropostas(c, { importacaoId, estado: "APROVADA" })].sort((x, y) => String(x.dataOperacao).localeCompare(String(y.dataOperacao)));
    const prontas = todas.slice(0, 400); // por chamada; o restante sai no clique seguinte (a resposta informa quantas faltam)
    let aplicadas = 0;
    let valorCentavos = 0;
    const falhas = [];
    for (const p of prontas) {
      try {
        // 17/11/2026: aprovar e aplicar numa só transação (mesmas regras; menos idas ao banco por proposta).
        if (p.estado === "PROPOSTA") await n.aprovarEAplicarProposta(c, { propostaId: p.id, justificativa: "Aprovada em lote (propostas prontas da importação)." });
        else await n.aplicarProposta(c, { propostaId: p.id });
        aplicadas += 1;
        valorCentavos += p.valorCentavos ?? 0;
      } catch (e) {
        falhas.push({ propostaId: p.id, data: p.dataOperacao, mensagem: e?.message ?? "Falha ao aplicar." });
      }
    }
    return { importacaoId, prontas: prontas.length, aplicadas, valorCentavos, falhas, restantes: todas.length - prontas.length };
  } },
  // `chave` (UUID do formulário): o MESMO envio repetido (clique duplo, rede) devolve o registro já gravado, sem duplicar.
  "/obrigacoes/registrar": { campos: ["fornecedor", "fornecedorNovo", "descricao", "valor", "categoria", "competencia", "dataEmissao", "vencimento", "identificador", "chave"], fazer: (n, c, b) => n.registrarObrigacao(c, {
    ...(b.fornecedor ? { contraparteId: id(b.fornecedor) } : { contraparteNova: { tipo: "FORNECEDOR", nome: String(b.fornecedorNovo ?? "").slice(0, 120) } }),
    valorOriginalCentavos: centavos(b.valor), categoria: b.categoria, descricao: b.descricao, competencia: b.competencia, dataEmissao: b.dataEmissao, vencimento: b.vencimento,
    ...(b.identificador ? { identificador: String(b.identificador).slice(0, 60) } : {}),
    ...(b.chave ? { fonte: { sistema: "MANUAL", idExterno: `formulario:${id(b.chave)}` } } : {}),
  }) },
  // Retiradas de caixa importadas da SAIPOS → despesa paga em dinheiro (fornecedor Sangrias, Outras despesas, Caixa da loja). Só o que é NOVO; nada duplica.
  "/movimentos-caixa/lancar-despesas": { campos: ["periodoInicio", "periodoFim", "justificativa"], fazer: (n, c, b) => n.lancarSangriasComoDespesa(c, { periodoInicio: b.periodoInicio, periodoFim: b.periodoFim, ...(b.justificativa ? { justificativa: b.justificativa } : {}), confirmar: true }) },
  // `valor` = o que quita a CONTA; `juros` (opcional) = juro/multa cobrado além dela. A saída paga os dois (valor + juros), numa só transação.
  "/obrigacoes/vincular-extrato": { campos: ["obrigacao", "movimentacao", "versao", "valor", "juros", "documento", "justificativa", "pagamentoAntecipado"], fazer: (n, c, b) => {
    const juros = b.juros === undefined || b.juros === null || String(b.juros).trim() === "" ? 0 : centavos(b.juros);
    return n.vincularPagamentoDoExtrato(c, {
      movimentacaoId: id(b.movimentacao), versaoMovimentacao: inteiro(b.versao), alocacoes: [{ obrigacaoId: id(b.obrigacao), valorCentavos: centavos(b.valor) + juros }],
      ...(juros > 0 ? { jurosCentavos: juros } : {}),
      ...(b.documento ? { documentoId: id(b.documento) } : {}), justificativa: b.justificativa, confirmar: true, ...(marcado(b.pagamentoAntecipado) ? { pagamentoAntecipado: true } : {}),
    });
  } },
  // Corrigir o VALOR de uma conta a pagar: o histórico é preservado — grava um ajuste (diferença) com motivo, na mesma categoria.
  "/obrigacoes/corrigir-valor": { campos: ["obrigacao", "novoValor", "justificativa"], fazer: async (n, c, b) => {
    const d = await n.detalharContaAPagar(c, { id: id(b.obrigacao) });
    const atual = (d.titulo.valorOriginalCentavos ?? 0) + (d.titulo.ajustesCentavos ?? 0);
    const diferenca = centavos(b.novoValor) - atual;
    if (!Number.isInteger(diferenca) || diferenca === 0) throw new ErroFinanceiro(CODIGO.ENTRADA_INVALIDA, "Informe um valor diferente do atual.");
    return n.registrarAjuste(c, { alvoTipo: "OBRIGACAO", alvoId: id(b.obrigacao), valorCentavos: diferenca, motivo: b.justificativa, categoria: d.lancamento.categoria });
  } },
  // Corrigir descrição, vencimento ou fornecedor de uma conta a pagar (valor: "/obrigacoes/corrigir-valor"). Só o que mudou vai ao núcleo.
  "/obrigacoes/corrigir": { campos: ["obrigacao", "descricao", "vencimento", "fornecedor", "novoFornecedor", "justificativa"], fazer: async (n, c, b) => {
    const mudancas = {};
    if (b.descricao) mudancas.descricao = String(b.descricao).trim();
    if (b.vencimento) mudancas.vencimento = b.vencimento;
    const novo = String(b.novoFornecedor ?? "").trim();
    if (novo) mudancas.contraparteId = (await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: novo })).id;
    else if (b.fornecedor) mudancas.contraparteId = id(b.fornecedor);
    return n.corrigirObrigacao(c, { obrigacaoId: id(b.obrigacao), mudancas, justificativa: b.justificativa });
  } },
  // Pagar. Se o valor pago é MAIOR que o saldo, a diferença é juros/multa: entra antes como ajuste (despesa financeira, na
  // competência do pagamento, com motivo) e o pagamento quita o total. Se o pagamento falhar, o ajuste é desfeito por outro ajuste.
  "/obrigacoes/pagar": { campos: ["obrigacao", "conta", "dataEfetiva", "valor"], fazer: async (n, c, b) => {
    const entrada = { obrigacaoId: id(b.obrigacao), contaId: id(b.conta), dataEfetiva: b.dataEfetiva, valorCentavos: centavos(b.valor) };
    const saldo = (await n.detalharContaAPagar(c, { id: entrada.obrigacaoId })).titulo.saldoCentavos;
    const juros = Number.isInteger(entrada.valorCentavos) ? entrada.valorCentavos - saldo : 0;
    if (juros <= 0) return n.pagarContaAPagar(c, entrada);
    const ajuste = { alvoTipo: "OBRIGACAO", alvoId: entrada.obrigacaoId, categoria: "JUROS_E_TARIFAS_BANCARIAS", competencia: String(b.dataEfetiva ?? "").slice(0, 7) };
    const real = (v) => `R$ ${(v / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
    await n.registrarAjuste(c, { ...ajuste, valorCentavos: juros, motivo: `Juros/multa: pago ${real(entrada.valorCentavos)} sobre o saldo de ${real(saldo)} em ${b.dataEfetiva}` });
    try { return { ...(await n.pagarContaAPagar(c, entrada)), jurosCentavos: juros }; } catch (e) {
      await n.registrarAjuste(c, { ...ajuste, valorCentavos: -juros, motivo: "Desfeito: o pagamento não foi concluído" }).catch(() => {});
      throw e;
    }
  } },
  "/saldos/registrar": { campos: ["conta", "data", "referencia", "valor", "observacao"], fazer: (n, c, b) => n.registrarSaldoDeConta(c, { contaId: id(b.conta), data: b.data, referencia: b.referencia, valorCentavos: centavos(b.valor), ...(b.observacao ? { observacao: b.observacao } : {}) }) },
  "/reclassificar": { campos: ["lancamento", "categoria", "justificativa", "versaoEsperada", "documento"], fazer: (n, c, b) => n.reclassificarLancamento(c, {
    lancamentoId: id(b.lancamento), categoria: b.categoria, justificativa: b.justificativa, versaoEsperada: inteiro(b.versaoEsperada), ...(b.documento ? { documentoId: id(b.documento) } : {}),
  }) },
  // doc 33: "baixar" (caixa marcada) confirma a conta × saída e dá baixa na conta na MESMA transação.
  "/conciliacoes/confirmar": { campos: ["correspondencia", "justificativa", "baixar"], fazer: (n, c, b) => n.confirmarConciliacao(c, { correspondenciaId: id(b.correspondencia), ...(b.justificativa ? { justificativa: b.justificativa } : {}), ...(b.baixar === "1" || b.baixar === true ? { baixar: true } : {}) }) },
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
  // doc 35: tabela de taxas contratadas (uma linha por taxa: "DEBITO;MASTERCARD;2,15"), com vigência e fonte documental.
  "/configuracoes/taxas-contratadas": { campos: ["processador", "operadora", "vigenciaInicio", "vigenciaFim", "fonte", "prazoDeRecebimento", "taxas", "justificativa"], fazer: (n, c, b) => n.registrarTaxasContratadas(c, {
    ...(b.operadora ? { operadora: b.operadora } : { processador: b.processador || "STONE" }), vigenciaInicio: b.vigenciaInicio, ...(b.vigenciaFim ? { vigenciaFim: b.vigenciaFim } : {}), fonte: b.fonte,
    ...(b.prazoDeRecebimento ? { prazoDeRecebimento: b.prazoDeRecebimento } : {}), taxas: taxasDoTexto(b.taxas), justificativa: b.justificativa,
  }) },
  // Fase 04 (doc 42): fechamento manual de UM caixa num dia (conferência; nunca receita). Grade fixa de formas (GRADE_FECHAMENTO).
  "/fechamento-manual/registrar": { campos: CAMPOS_FECHAMENTO, fazer: (n, c, b) => n.registrarFechamentoManual(c, corpoDoFechamento(b)) },
  // Fase 08 (doc 44): faturamento manual PROVISÓRIO (ação explícita, separada do fechamento) e a substituição auditada.
  "/faturamento-manual/registrar": { campos: CAMPOS_FATURAMENTO, fazer: (n, c, b) => n.registrarFaturamentoManual(c, corpoDoFaturamento(b)) },
  // Fase 10 (doc 47): dias (ou dias da semana) sem operação de um canal, com justificativa e histórico.
  "/calendario-faturamento/sem-operacao": { campos: ["canal", "data", "diaDaSemana", "situacao", "justificativa"], fazer: (n, c, b) => n.registrarDiaSemOperacao(c, {
    canal: b.canal, ...(b.data ? { data: b.data } : {}), ...(b.diaDaSemana !== undefined && b.diaDaSemana !== "" ? { diaDaSemana: b.diaDaSemana } : {}),
    ...(b.situacao ? { situacao: b.situacao } : {}), justificativa: b.justificativa,
  }) },
  "/faturamento-manual/substituir": { campos: ["data", "canal", "justificativa"], fazer: (n, c, b) => n.substituirFaturamentoProvisorio(c, { data: b.data, canal: b.canal, justificativa: b.justificativa }) },
  // Fase 02 (doc 40): operadoras de pagamento da unidade (cadastro, ativação/desativação, encerramento; nada é apagado).
  "/configuracoes/operadoras": { campos: ["codigo", "nome", "processador", "inicio", "encerramento", "modalidades", "observacao", "justificativa"], fazer: (n, c, b) => n.registrarOperadora(c, {
    codigo: b.codigo, nome: b.nome, processador: b.processador, inicio: b.inicio, ...(b.encerramento ? { encerramento: b.encerramento } : {}),
    modalidades: Array.isArray(b.modalidades) ? b.modalidades : String(b.modalidades ?? "").split(/[,;\s]+/).filter(Boolean), ...(b.observacao ? { observacao: b.observacao } : {}), justificativa: b.justificativa,
  }) },
  "/configuracoes/operadoras/situacao": { campos: ["codigo", "situacao", "encerramento", "nome", "observacao", "justificativa"], fazer: (n, c, b) => n.alterarSituacaoOperadora(c, {
    codigo: b.codigo, ...(b.situacao ? { situacao: b.situacao } : {}), ...(b.encerramento !== undefined ? { encerramento: b.encerramento || null } : {}),
    ...(b.nome ? { nome: b.nome } : {}), ...(b.observacao !== undefined ? { observacao: b.observacao } : {}), justificativa: b.justificativa,
  }) },
  // doc 36: taxas Stone do período na DRE (uma vez por importação e competência) e o estorno autorizado.
  "/importacao/reconhecer-taxas": { campos: ["importacao", "justificativa"], fazer: (n, c, b) => n.reconhecerTaxasDoPeriodo(c, { importacaoId: id(b.importacao), justificativa: b.justificativa }) },
  "/importacao/estornar-taxas": { campos: ["importacao", "competencia", "justificativa"], fazer: (n, c, b) => n.estornarTaxasDoPeriodo(c, { importacaoId: id(b.importacao), competencia: b.competencia, justificativa: b.justificativa }) },
  // doc 38: demonstrativo OFICIAL do iFood do período (faturamento do canal iFood; retenções; ajustes; líquido conferido).
  "/vendas/demonstrativo-ifood": { campos: ["periodoInicio", "periodoFim", "vendas", "comissoes", "taxaPagamento", "mensalidade", "servicosEPromocoes", "ajustes", "liquido", "origem", "justificativa"], fazer: (n, c, b) => n.registrarDemonstrativoIfood(c, {
    periodoInicio: b.periodoInicio, periodoFim: b.periodoFim, vendasCentavos: centavos(b.vendas), comissoesCentavos: centavos(b.comissoes || "0,00"), taxaPagamentoCentavos: centavos(b.taxaPagamento || "0,00"),
    mensalidadeCentavos: centavos(b.mensalidade || "0,00"), servicosEPromocoesCentavos: centavos(b.servicosEPromocoes || "0,00"), ajustesCentavos: centavos(b.ajustes || "0,00"),
    liquidoInformadoCentavos: centavos(b.liquido), origem: b.origem, justificativa: b.justificativa,
  }) },
  "/configuracoes/unidade": { campos: ["nomeExibicao", "identificacaoEmpresa", "situacao", "observacao", "justificativa"], fazer: (n, c, b) => n.configurarUnidade(c, semVazios(b, ["nomeExibicao", "identificacaoEmpresa", "situacao", "observacao", "justificativa"])) },
  "/configuracoes/canal": { campos: ["papel", "codigo", "codigoBase", "nome", "situacao", "observacao", "justificativa"], fazer: (n, c, b) => n.registrarCanalOuProcessador(c, semVazios(b, ["papel", "codigo", "codigoBase", "nome", "situacao", "observacao", "justificativa"])) },
  "/configuracoes/conta": { campos: ["conta", "nome", "ativa", "justificativa"], fazer: (n, c, b) => n.alterarContaFinanceira(c, { contaId: id(b.conta), ...(b.nome ? { nome: b.nome } : {}), ...(b.ativa === "true" || b.ativa === "false" ? { ativa: b.ativa === "true" } : {}), justificativa: b.justificativa }) },
  "/configuracoes/categoria": { campos: ["codigo", "nome", "ativa", "justificativa"], fazer: (n, c, b) => n.alterarCategoria(c, { codigo: b.codigo, mudancas: { ...(b.nome ? { nome: b.nome } : {}), ...(b.ativa === "true" || b.ativa === "false" ? { ativa: b.ativa === "true" } : {}) }, justificativa: b.justificativa }) },
  ...escritasDaAbertura(),
});
