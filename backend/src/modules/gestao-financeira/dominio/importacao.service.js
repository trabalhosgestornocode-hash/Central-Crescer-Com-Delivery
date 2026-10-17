// Fluxo de importação do livro-caixa: prévia → decisões (pares, alterações) → confirmação ATÔMICA (RPC) → relatório.
// Nada é gravado nos lançamentos antes da confirmação; a confirmação é uma única transação no banco (tudo ou nada).
import * as repositorio from "./repositorio.js";
import { exigirContexto } from "./contexto.js";
import { texto, uuid, bad } from "./validacao.js";
import { ApiError } from "../../../shared/ApiError.js";
import { lerLivroCaixaXlsx, LIMITE_BYTES } from "./importacao/leitorXlsx.js";
import { montarPrevia, aplicarDecisoesPares } from "../../../financeiro-calculos/importacao.js";

const padrao = { repo: repositorio, db: undefined, leitor: lerLivroCaixaXlsx };

function decodificar(b64) {
  if (typeof b64 !== "string" || !b64) throw bad("Arquivo não enviado.", "ARQUIVO_AUSENTE");
  if (b64.length > Math.ceil(LIMITE_BYTES * 4 / 3) + 8) throw bad("Arquivo acima do limite de 5 MB.", "ARQUIVO_GRANDE");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw bad("Arquivo em formato inválido.", "ARQUIVO_INVALIDO");
  return Buffer.from(b64, "base64");
}

/** Visão enxuta (sem o jsonb inteiro) para listas/resultado. */
const cabecalho = (i) => ({ id: i.id, arquivoNome: i.arquivo_nome, status: i.status, resumo: i.resumo ?? null, criadoEm: i.created_at, confirmadoEm: i.confirmado_em ?? null });

export async function gerarPrevia(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const nome = texto(b?.nomeArquivo, "nomeArquivo", { max: 200, obrigatorio: false });
  const { aba, brutas, totalDeclarado, abasIgnoradas } = (deps.leitor ?? lerLivroCaixaXlsx)(decodificar(b?.conteudoBase64), { nomeAba: b?.nomeAba });
  const [existentesBd, contas, aberturas] = await Promise.all([
    deps.repo.listarExistentesImportacao(c, deps.db), deps.repo.listarContas(c, deps.db), deps.repo.listarAberturas(c, deps.db),
  ]);
  const nomeDaConta = new Map(contas.map((x) => [x.id, x.nome]));
  const existentes = existentesBd.filter((e) => nomeDaConta.has(e.conta_id)).map((e) => ({
    chave: e.chave_origem, dataISO: e.data_movimento, conta: nomeDaConta.get(e.conta_id), sentido: e.sentido, valorCentavos: Number(e.valor_centavos), descricao: e.descricao,
  }));
  const saldosAbertura = Object.fromEntries(aberturas.filter((a) => nomeDaConta.has(a.conta_id)).map((a) => [nomeDaConta.get(a.conta_id), Number(a.valor_centavos)]));
  const previa = montarPrevia({ brutas, existentes, totalDeclarado, saldosAbertura });
  if (!previa.lancamentos.length && !previa.erros.length) throw bad("Nenhum lançamento encontrado no arquivo.", "ARQUIVO_SEM_LANCAMENTOS");
  const gravada = await deps.repo.inserirImportacao(c, { arquivo_nome: nome, arquivo_hash: previa.hashConteudo, previa, resumo: previa.resumo }, deps.db);
  return { id: gravada.id, aba, abasIgnoradas, ...visao(previa) };
}

const visao = (previa) => ({ resumo: previa.resumo, erros: previa.erros, lancamentos: previa.lancamentos, pares: previa.pares, ausentes: previa.ausentes, categorias: previa.categorias, contas: previa.contas, saldos: previa.saldos });

async function carregarPrevia(c, id, deps) {
  const imp = await deps.repo.obterImportacao(c, uuid(id, "id"), deps.db);
  if (!imp) throw ApiError.notFound("Importação não encontrada.");
  return imp;
}
const exigirPrevia = (imp) => { if (imp.status !== "previa") throw bad("A importação não está mais em estado de prévia.", "IMPORTACAO_ESTADO_INVALIDO"); };

export async function obterPrevia(ctx, id, deps = padrao) {
  const imp = await carregarPrevia(exigirContexto(ctx), id, deps);
  return { id: imp.id, status: imp.status, arquivoNome: imp.arquivo_nome, ...visao(imp.previa), resumo: imp.status === "confirmada" ? imp.resumo : imp.previa.resumo };
}
export async function listarImportacoes(ctx, deps = padrao) {
  return (await deps.repo.listarImportacoes(exigirContexto(ctx), deps.db)).map(cabecalho);
}

/** Decisão humana sobre pares: confirmar específicos, rejeitar, ou aceitar em lote só os de ALTA confiança. Ambíguos nunca entram em lote. */
export async function decidirPares(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const imp = await carregarPrevia(c, id, deps);
  exigirPrevia(imp);
  const lista = (v, campo) => { if (v == null) return []; if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw bad(`${campo} inválido.`); return v; };
  const ids = new Set(imp.previa.pares.map((p) => p.id));
  const confirmar = lista(b?.confirmar, "confirmar");
  const rejeitar = lista(b?.rejeitar, "rejeitar");
  if ([...confirmar, ...rejeitar].some((x) => !ids.has(x))) throw bad("Par desconhecido.", "PAR_DESCONHECIDO");
  const nova = aplicarDecisoesPares(imp.previa, { confirmar, rejeitar, confirmarAltaConfianca: b?.confirmarAltaConfianca === true });
  await deps.repo.atualizarPreviaImportacao(c, imp.id, nova, deps.db);
  return { id: imp.id, ...visao(nova) };
}

/** Aceite explícito de linhas que parecem edição de lançamentos já importados. Sem aceite, essas linhas NÃO entram. */
export async function aceitarAlteracoes(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const imp = await carregarPrevia(c, id, deps);
  exigirPrevia(imp);
  if (!Array.isArray(b?.chaves) || b.chaves.some((x) => typeof x !== "string")) throw bad("chaves inválido.");
  const aceitas = new Set(b.chaves);
  let n = 0;
  const lancamentos = imp.previa.lancamentos.map((l) => { if (l.status === "possivel_alteracao" && aceitas.has(l.chave)) { n++; return { ...l, importar: true }; } return l; });
  if (n !== aceitas.size) throw bad("Há chaves que não são possíveis alterações desta prévia.", "CHAVE_DESCONHECIDA");
  const nova = { ...imp.previa, lancamentos };
  await deps.repo.atualizarPreviaImportacao(c, imp.id, nova, deps.db);
  return { id: imp.id, aceitas: n };
}

export async function cancelarImportacao(ctx, id, deps = padrao) {
  const c = exigirContexto(ctx);
  await deps.repo.cancelarImportacao(c, uuid(id, "id"), deps.db);
  return { cancelada: true };
}

/**
 * Confirmação explícita. Recusa: prévia com erros de leitura, totais declarados que não conferem, ou ausência do aceite textual.
 * Pendências NÃO bloqueiam (ficam marcadas como pendentes no banco): ter papel técnico não é classificação empresarial confirmada.
 */
export async function confirmarImportacao(ctx, id, b, deps = padrao) {
  const c = exigirContexto(ctx);
  if (b?.confirmo !== true) throw bad("Confirmação explícita ausente.", "CONFIRMACAO_AUSENTE");
  const imp = await carregarPrevia(c, id, deps);
  if (imp.status === "confirmada") return { id: imp.id, jaConfirmada: true, resultado: imp.resumo };
  exigirPrevia(imp);
  const p = imp.previa;
  if (p.erros?.length) throw bad(`A prévia tem ${p.erros.length} linha(s) com erro de leitura; corrija o arquivo e gere nova prévia.`, "PREVIA_COM_ERROS");
  if (p.resumo?.conferencia?.confere === false) throw bad("Os totais declarados no arquivo não conferem com os lançamentos lidos.", "TOTAIS_NAO_CONFEREM");
  const aGravar = p.lancamentos.filter((l) => l.importar).length;
  const resultado = await deps.repo.confirmarImportacaoRpc(c, imp.id, deps.db);
  return {
    id: imp.id, resultado,
    reconciliacao: {
      previstos: aGravar, gravados: resultado.lancamentosGravados, jaExistentes: resultado.jaExistentes,
      confere: resultado.lancamentosGravados + resultado.jaExistentes === aGravar,
      pendentesPreservados: p.resumo.pendentes, paresVinculados: resultado.paresVinculados, saldosGravados: resultado.saldosGravados,
      contasSemAbertura: p.resumo.contasSemAbertura, naoImportadasPorAlteracao: p.lancamentos.filter((l) => !l.importar && l.status === "possivel_alteracao").length,
    },
  };
}
