// AÇÕES (escrita) do Financeiro v2 pela plataforma (Execução 10). Cada uma chama a operação REAL do núcleo, que confere
// permissão por ação, escopo, versão esperada, estado e grava histórico na mesma transação; a sessão de banco vem do
// gateway e o banco confere concessão e RLS de novo. Nada aqui decide regra financeira.
//
// Ligadas SÓ com FV2_ESCRITA_HABILITADA=1 (além de FV2_HABILITADO). Ficam FORA nesta fase:
//   - envio e abertura de arquivos (cofre sem antimalware efetivo) → 503;
//   - homologar: além do segundo fator, exige FV2_HOMOLOGACAO_HABILITADA=1 (matriz 24a ainda não aprovada).
// Conceder, revogar, homologar e reabrir exigem prova de segundo fator RECENTE (adaptador + verificador do provedor).
import { ACAO } from "../financeiro-v2/index.js";

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
  // Abertura da unidade no v2: implanta o plano de contas de um MODELO do núcleo (nada vem do legado).
  "/configuracoes/implantar-plano": { campos: ["modelo"], fazer: (n, c, b) => n.implantarPlanoDeContas(c, { modelo: b.modelo }) },
  "/configuracoes/unidade": { campos: ["nomeExibicao", "identificacaoEmpresa", "situacao", "observacao", "justificativa"], fazer: (n, c, b) => n.configurarUnidade(c, semVazios(b, ["nomeExibicao", "identificacaoEmpresa", "situacao", "observacao", "justificativa"])) },
  "/configuracoes/canal": { campos: ["papel", "codigo", "codigoBase", "nome", "situacao", "observacao", "justificativa"], fazer: (n, c, b) => n.registrarCanalOuProcessador(c, semVazios(b, ["papel", "codigo", "codigoBase", "nome", "situacao", "observacao", "justificativa"])) },
  "/configuracoes/conta": { campos: ["conta", "nome", "ativa", "justificativa"], fazer: (n, c, b) => n.alterarContaFinanceira(c, { contaId: id(b.conta), ...(b.nome ? { nome: b.nome } : {}), ...(b.ativa === "true" || b.ativa === "false" ? { ativa: b.ativa === "true" } : {}), justificativa: b.justificativa }) },
  "/configuracoes/categoria": { campos: ["codigo", "nome", "ativa", "justificativa"], fazer: (n, c, b) => n.alterarCategoria(c, { codigo: b.codigo, mudancas: { ...(b.nome ? { nome: b.nome } : {}), ...(b.ativa === "true" || b.ativa === "false" ? { ativa: b.ativa === "true" } : {}) }, justificativa: b.justificativa }) },
});
