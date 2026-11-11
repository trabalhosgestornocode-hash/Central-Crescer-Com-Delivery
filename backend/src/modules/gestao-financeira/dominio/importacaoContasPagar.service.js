// Importação de contas a pagar por planilha: PRÉVIA (nada é gravado) → CONFIRMAÇÃO com o mapeamento de categorias e contas escolhido por uma pessoa.
// Cada título vira uma conta a pagar (mesma regra de "Registrar conta") e, se já foi pago, um pagamento na conta informada; quando pago por inteiro e quem
// importa pode conciliar, a conta é quitada. IDEMPOTENTE: a marca [imp-cp:<chave>] fica na observação; reenviar o arquivo não duplica. Não cria movimento bancário.
import * as repositorio from "./repositorio.js";
import { exigirContexto } from "./contexto.js";
import { bad } from "./validacao.js";
import * as obr from "./obrigacoes.service.js";
import { lerContasPagarXlsx } from "./importacao/leitorContasPagar.js";
import { normalizarContasPagar, gruposDeMapeamento, chaveDaObservacao, marcaDe } from "../../../financeiro-calculos/importacaoContasPagar.js";

const padrao = { repo: repositorio, db: undefined };
const ACAO_CONCILIAR = "gestao_financeira.conciliar";
const soma = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
/** Valor de mapeamento que tira um grupo da importação (ex.: um item que não é conta a pagar). */
export const IGNORAR = "ignorar";
const PAPEIS_FORA = ["transferencia", "saldo_anterior", "receita_operacional"];

/** Dependências com leitura única de plano de contas, contas e fornecedores (e o fornecedor recém-criado entra na lista). */
function comCache(deps, c) {
  let plano, contas, forn;
  const repo = { ...deps.repo,
    listarPlanoContas: async () => (plano ??= await deps.repo.listarPlanoContas(c, deps.db)),
    listarContas: async () => (contas ??= await deps.repo.listarContas(c, deps.db)),
    listarFornecedores: async () => (forn ??= [...(await deps.repo.listarFornecedores(c, deps.db))]),
    inserirFornecedor: async (cc, f, db) => { const novo = await deps.repo.inserirFornecedor(cc, f, db); (forn ??= []).push(novo); return novo; },
  };
  return { ...deps, repo };
}

async function lerEPrever(c, b, deps) {
  const b64 = b?.conteudoBase64;
  if (typeof b64 !== "string" || !b64) throw bad("Arquivo não enviado.", "ARQUIVO_AUSENTE");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw bad("Arquivo em formato inválido.", "ARQUIVO_INVALIDO");
  const { aba, brutas } = (deps.leitorContasPagar ?? lerContasPagarXlsx)(Buffer.from(b64, "base64"));
  const { itens, fora, erros } = normalizarContasPagar(brutas);
  const [plano, contas, existentes] = await Promise.all([deps.repo.listarPlanoContas(c, deps.db), deps.repo.listarContas(c, deps.db), deps.repo.listarObrigacoes(c, deps.db)]);
  const jaTem = new Set(existentes.map((o) => chaveDaObservacao(o.observacoes)).filter(Boolean));
  const novos = itens.filter((i) => !jaTem.has(i.chave)), jaImportados = itens.length - novos.length;
  return { aba, itens, novos, jaImportados, fora, erros, plano, contas, grupos: gruposDeMapeamento(novos, { plano, contas }) };
}

export async function previaImportacao(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const p = await lerEPrever(c, b, deps);
  const pagos = p.novos.filter((i) => i.realizadoCentavos > 0);
  return {
    aba: p.aba, erros: p.erros,
    resumo: { titulosNoArquivo: p.itens.length, novos: p.novos.length, jaImportados: p.jaImportados, pagos: pagos.length, abertos: p.novos.length - pagos.length,
      valorPrevistoCentavos: soma(p.novos, (i) => i.previstoCentavos), valorPagoCentavos: soma(pagos, (i) => i.realizadoCentavos), foraDoEscopo: p.fora },
    mapeamento: p.grupos,
    opcoes: { categorias: p.plano.filter((x) => x.ativo && !PAPEIS_FORA.includes(x.papel)).map((x) => ({ id: x.id, nome: x.nome })), contas: p.contas.filter((x) => x.ativo).map((x) => ({ id: x.id, nome: x.nome })) },
    amostra: p.novos.slice(0, 8).map((i) => ({ linha: i.linha, vencimento: i.vencimento, descricao: i.descricao, previstoCentavos: i.previstoCentavos, realizadoCentavos: i.realizadoCentavos })),
  };
}

export async function importar(ctx, b, deps = padrao, { permissoes = [] } = {}) {
  const c = exigirContexto(ctx);
  const p = await lerEPrever(c, b, deps);
  if (p.erros.length) throw bad(`O arquivo tem ${p.erros.length} linha(s) com erro e nada foi importado: ${p.erros.slice(0, 3).map((e) => `linha ${e.linha}: ${e.motivo}`).join("; ")}.`, "ARQUIVO_COM_ERROS");
  const mc = b?.mapeamentoCategorias ?? {}, mt = b?.mapeamentoContas ?? {};
  const catOk = new Set(p.plano.filter((x) => x.ativo && !PAPEIS_FORA.includes(x.papel)).map((x) => x.id));
  const contaOk = new Set(p.contas.filter((x) => x.ativo).map((x) => x.id));
  const faltaCat = p.grupos.categorias.filter((g) => mc[g.chave] !== IGNORAR && !catOk.has(mc[g.chave])), faltaConta = p.grupos.contas.filter((g) => !contaOk.has(mt[g.chave]));
  if (faltaCat.length || faltaConta.length) throw bad(`Faltam escolhas antes de importar: ${[...faltaCat.map((g) => `categoria "${g.rotulo}"`), ...faltaConta.map((g) => `conta "${g.rotulo}"`)].join(", ")}.`, "MAPEAMENTO_INCOMPLETO");
  const podeQuitar = Array.isArray(permissoes) && permissoes.includes(ACAO_CONCILIAR);
  const lote = comCache(deps, c);   // plano, contas e fornecedores são lidos uma vez só, não a cada título
  let criadas = 0, pagamentos = 0, quitadas = 0, ignoradas = 0; const falhas = [];
  for (const i of p.novos) {
    if (mc[i.categoriaChave] === IGNORAR) { ignoradas += 1; continue; }
    try {
      const quitar = podeQuitar && i.realizadoCentavos > 0 && i.realizadoCentavos >= i.previstoCentavos;
      await obr.criarSemRetorno(c, {
        categoriaId: mc[i.categoriaChave], fornecedorNome: i.fornecedor, descricao: i.descricao, competencia: i.competencia, vencimento: i.vencimento, valorOriginal: (i.previstoCentavos / 100).toFixed(2),
        observacoes: `Importado da planilha (linha ${i.linha}) ${marcaDe(i.chave)}`,
        ...(i.realizadoCentavos > 0 ? { pagamento: { data: i.dataPagamento, valor: (i.realizadoCentavos / 100).toFixed(2), contaId: mt[i.contaChave], origemPagamento: "conta" } } : {}), ...(quitar ? { quitar: true } : {}),
      }, lote, { permissoes });
      criadas += 1; if (i.realizadoCentavos > 0) pagamentos += 1; if (quitar) quitadas += 1;
    } catch (e) { falhas.push({ linha: i.linha, motivo: e?.message ?? "falha" }); }
  }
  return { importado: criadas > 0 || !p.novos.length || ignoradas === p.novos.length, contasCriadas: criadas, pagamentosRegistrados: pagamentos, quitadas, ignoradasPorEscolha: ignoradas, jaImportadasIgnoradas: p.jaImportados, falhas,
    observacao: "Nenhuma saída bancária foi criada: os pagamentos ficam para conciliar com o extrato. Reenviar o arquivo não duplica." };
}
