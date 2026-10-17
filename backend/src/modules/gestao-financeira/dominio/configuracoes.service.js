// Configurações Financeiras: visão consolidada do que o domínio REALMENTE suporta configurar. O que depende de decisão empresarial ou de
// homologação de segurança aparece como `indisponivel`, sem controle de enfeite. As escritas reutilizam os endpoints já existentes (contas,
// plano de contas, aberturas, exceções de sangria, política de fechamento), cada um com a sua permissão.
import * as repositorio from "./repositorio.js";
import { exigirContexto } from "./contexto.js";

const padrao = { repo: repositorio, db: undefined };

export const INDISPONIVEIS = Object.freeze([
  { id: "regras-classificacao", titulo: "Regras de classificação automática", motivo: "Depende de decisão empresarial. Hoje nenhum lançamento é classificado sozinho: pendências exigem classificação manual autorizada e justificativa." },
  { id: "reabertura-periodos", titulo: "Reabertura de períodos fechados", motivo: "Indisponível. A política recomendada é autorização administrativa excepcional, com permissão separada e MFA recente, a ser homologada pela fundação de segurança antes de qualquer habilitação." },
  { id: "aprovacao-fechamento-pendencias", titulo: "Fechar período com pendências", motivo: "Bloqueado por padrão. Só pode ser ligado por aprovação explícita registrada (tela Períodos).", somenteInformativo: true },
]);

export async function resumo(ctx, deps = padrao) {
  const c = exigirContexto(ctx);
  const [contas, cats, aberturas, lancs, periodos, cfg, exc] = await Promise.all([
    deps.repo.listarContas(c, deps.db), deps.repo.listarPlanoContas(c, deps.db), deps.repo.listarAberturas(c, deps.db),
    deps.repo.listarTodosLancamentos(c, {}, deps.db), deps.repo.listarPeriodos(c, deps.db), deps.repo.obterConfig(c, deps.db), deps.repo.listarExcecoesSangria(c, { apenasAtivas: true }, deps.db),
  ]);
  const fechados = new Set(periodos.filter((p) => p.status === "fechado").map((p) => String(p.mes).slice(0, 7)));
  const usoConta = new Map(), fechadoConta = new Map(), usoCat = new Map();
  for (const l of lancs) {
    usoConta.set(l.conta_id, (usoConta.get(l.conta_id) ?? 0) + 1);
    if (fechados.has(String(l.data_movimento).slice(0, 7))) fechadoConta.set(l.conta_id, (fechadoConta.get(l.conta_id) ?? 0) + 1);
    if (l.categoria_id) usoCat.set(l.categoria_id, (usoCat.get(l.categoria_id) ?? 0) + 1);
  }
  const abertura = new Map();
  for (const a of [...aberturas].sort((x, y) => String(x.data_referencia).localeCompare(String(y.data_referencia)))) abertura.set(a.conta_id, a);
  const contasOut = contas.map((x) => ({
    id: x.id, nome: x.nome, tipoConta: x.tipo_conta, canalReferencia: x.canal_referencia ?? null, ativo: x.ativo,
    aberturaConhecida: abertura.has(x.id), aberturaCentavos: abertura.has(x.id) ? Number(abertura.get(x.id).valor_centavos) : null, aberturaData: abertura.get(x.id)?.data_referencia ?? null,
    lancamentos: usoConta.get(x.id) ?? 0, lancamentosEmMesFechado: fechadoConta.get(x.id) ?? 0,
    // tipo e canal alteram a conciliação retroativamente: bloqueados se a conta tem movimento em mês fechado
    podeAlterarTipoCanal: (fechadoConta.get(x.id) ?? 0) === 0,
  }));
  const categoriasOut = cats.map((x) => ({ id: x.id, tipo: x.tipo, natureza: x.natureza, nome: x.nome, papel: x.papel, ativo: x.ativo, lancamentos: usoCat.get(x.id) ?? 0, podeTrocarPapel: (usoCat.get(x.id) ?? 0) === 0 }));
  const semAbertura = contasOut.filter((x) => x.ativo && !x.aberturaConhecida);
  return {
    contas: contasOut,
    categorias: categoriasOut,
    saldosAberturaDesconhecidos: semAbertura.map((x) => ({ id: x.id, nome: x.nome, tipoConta: x.tipoConta })),
    conciliacao: { excecoesSangriaAtivas: exc.length, contasComCanal: contasOut.filter((x) => x.canalReferencia).length, contasSemCanal: contasOut.filter((x) => x.ativo && !x.canalReferencia).length },
    politicaFechamento: { permiteFecharComPendencias: cfg?.permite_fechar_com_pendencias === true, aprovadoEm: cfg?.aprovado_em ?? null, notaAprovacao: cfg?.nota_aprovacao ?? null },
    pendencias: { classificacao: lancs.filter((l) => l.status !== "cancelado" && (l.classificacao_pendente || !l.categoria_id)).length },
    indisponiveis: INDISPONIVEIS,
  };
}
