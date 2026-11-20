// Execução 06D — CONFIGURAÇÕES do Financeiro v2 (por organização + unidade do contexto; nada vem do cliente).
//
//   - Organização e unidade: identificação de exibição e situação da unidade no Financeiro v2.
//   - Canais e processadores: cadastro DA UNIDADE, separado da forma de pagamento. Cada item aponta para um código base
//     do motor (canal ou processador); taxa contratual NÃO é cadastrada nem presumida — taxas vêm dos relatórios.
//   - Contas financeiras: renomear com permissão de configurar; DESATIVAR afeta saldos e conciliação, então exige também
//     a permissão de conciliar, justificativa e nenhuma sessão de caixa aberta.
//   - Plano de contas: categoria nunca é apagada; inativar mantém o histórico e impede lançamentos novos.
//   - Metodologia: consulta do catálogo versionado (dominio/metodologias.js); nada recalcula competências homologadas.
// Toda alteração exige justificativa e fica no histórico (antes/depois, quem, quando).
import { CODIGO, falhar } from "../dominio/erros.js";
import { CANAL, EVENTO_HISTORICO, NATUREZAS_DA_CLASSIFICACAO, PAPEL_COMERCIAL, PROCESSADOR, SITUACAO_CADASTRO, SITUACAO_SESSAO_CAIXA, TIPO } from "../dominio/catalogos.js";
import { unidadeUsaSwf } from "./fontesDeFaturamento.js";
import { ACAO } from "../dominio/contexto.js";
import { conciliacaoEfetiva } from "../dominio/tesouraria.js";
import { METODOLOGIAS, identificadorDa, metodologiaVigente } from "../dominio/metodologias.js";
import { exigirTexto, exigirUmDe, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";

const CODIGO_LIVRE = /^[A-Z][A-Z0-9_]{1,39}$/;
const SITUACAO_UNIDADE = Object.freeze(["ATIVA", "INATIVA"]);
const NOMES_BASE = Object.freeze({
  CANAL: { BALCAO: "Presencial (balcão)", IFOOD: "iFood", ANOTA_AI: "Anota AI", NOVENTA_E_NOVE_FOOD: "99Food", OUTRO: "Outro canal" },
  PROCESSADOR: { STONE: "Stone", PAGBANK: "PagBank", MAQUININHA_IFOOD: "Maquininha do iFood (presencial)", IFOOD: "iFood (repasse do marketplace)", ANOTA_AI: "Anota AI (repasse)", NOVENTA_E_NOVE_FOOD: "99Food (repasse)", OPERADORA_BENEFICIOS: "Operadora de vale", MAQUINA_TERCEIROS: "Máquina de terceiros", OUTRO: "Outro processador" },
});

export function operacoesDeConfiguracao(b) {
  const chaveDoCadastro = (papel, codigo) => `cadastro:${papel}:${codigo}`;

  return {
    /** Visão geral das configurações da unidade, para a área Configurações. */
    consultarConfiguracoes(ctx) {
      return b.consultar(ctx, async (cx, tx) => {
        const [unidade] = await tx.listar(cx, TIPO.CONFIGURACAO_UNIDADE);
        const contas = await tx.listar(cx, TIPO.CONTA);
        const movs = await tx.listar(cx, TIPO.MOVIMENTACAO);
        const sessoes = await tx.listar(cx, TIPO.SESSAO_CAIXA);
        const cadastros = await tx.listar(cx, TIPO.CANAL_PROCESSADOR);
        const categorias = await tx.listar(cx, TIPO.CATEGORIA);
        const competencias = await tx.listar(cx, TIPO.COMPETENCIA);
        const hoje = b.hoje();
        let vigente = null;
        try { vigente = metodologiaVigente(hoje.slice(0, 7)); } catch { vigente = null; }
        // Unidade que usa o SWF (Subway) não opera o Anota AI: só aparece se já houver cadastro (nada é escondido de quem já registrou).
        const swf = unidadeUsaSwf(unidade);
        const base = (papel, enumeracao) => Object.keys(enumeracao).filter((codigo) => !(swf && codigo === "ANOTA_AI" && !cadastros.some((x) => x.papel === papel && x.codigo === codigo))).map((codigo) => {
          const c = cadastros.find((x) => x.papel === papel && x.codigoBase === codigo && x.codigo === codigo);
          return { papel, codigo, codigoBase: codigo, nome: c?.nome ?? NOMES_BASE[papel][codigo] ?? codigo, situacao: c?.situacao ?? "NAO_CADASTRADO", doSistema: true, cadastrado: !!c, observacao: c?.observacao ?? null };
        });
        const extras = cadastros.filter((x) => x.codigo !== x.codigoBase).map((c) => ({ papel: c.papel, codigo: c.codigo, codigoBase: c.codigoBase, nome: c.nome, situacao: c.situacao, doSistema: false, cadastrado: true, observacao: c.observacao ?? null }));
        return {
          dataBase: hoje,
          unidade: unidade ? { nomeExibicao: unidade.nomeExibicao, identificacaoEmpresa: unidade.identificacaoEmpresa ?? null, situacao: unidade.situacao, observacao: unidade.observacao ?? null, atualizadoEm: unidade.atualizadoEm } : null,
          contas: contas.map((c) => ({
            id: c.id, nome: c.nome, tipo: c.tipo, instituicao: c.instituicao ?? null, ativa: c.ativa,
            movimentacoes: movs.filter((m) => m.contaId === c.id).length, naoConciliadas: movs.filter((m) => m.contaId === c.id && conciliacaoEfetiva(m) === "NAO_CONCILIADA" && m.situacao !== "ESTORNADA").length,
            sessaoDeCaixaAberta: sessoes.some((s) => s.contaId === c.id && s.situacao === SITUACAO_SESSAO_CAIXA.ABERTA),
          })),
          canais: [...base(PAPEL_COMERCIAL.CANAL, CANAL), ...extras.filter((x) => x.papel === PAPEL_COMERCIAL.CANAL)],
          processadores: [...base(PAPEL_COMERCIAL.PROCESSADOR, PROCESSADOR), ...extras.filter((x) => x.papel === PAPEL_COMERCIAL.PROCESSADOR)],
          observacaoComercial: "Canal de venda, forma de pagamento e processador são cadastros distintos. Taxas contratuais não são cadastradas nem presumidas: vêm dos relatórios importados.",
          planoDeContas: { categorias: categorias.length, ativas: categorias.filter((c) => c.ativa).length, regras: Object.entries(NATUREZAS_DA_CLASSIFICACAO).map(([classificacao, naturezas]) => ({ classificacao, naturezas })) },
          metodologias: METODOLOGIAS.map((m) => ({ ...m, identificador: identificadorDa(m), vigente: vigente ? identificadorDa(vigente) === identificadorDa(m) : false })),
          competencias: competencias.sort((a, c) => (a.competencia < c.competencia ? 1 : -1)).map((c) => ({ competencia: c.competencia, estado: c.estado, revisoes: c.revisoes, metodologia: c.metodologia ?? null })),
          voce: { podeConfigurar: cx.permissoes.includes(ACAO.CONFIGURAR), podeConciliar: cx.permissoes.includes(ACAO.CONCILIAR), podeConceder: cx.permissoes.includes(ACAO.CONCEDER) },
        };
      });
    },

    /** Identificação de exibição e situação da unidade no Financeiro v2 (um registro por escopo). */
    configurarUnidade(ctx, e = {}) {
      semCamposDesconhecidos(e, ["nomeExibicao", "identificacaoEmpresa", "situacao", "observacao", "justificativa"], "unidade");
      const c = {
        nomeExibicao: exigirTexto(e.nomeExibicao, "nomeExibicao", { max: 120 }), identificacaoEmpresa: exigirTexto(e.identificacaoEmpresa, "identificacaoEmpresa", { max: 120, opcional: true }),
        situacao: exigirUmDe(e.situacao ?? "ATIVA", SITUACAO_UNIDADE, "situacao"), observacao: exigirTexto(e.observacao, "observacao", { max: 300, opcional: true }),
      };
      const justificativa = exigirTexto(e.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.CONFIGURAR, async (cx, tx) => {
        const atual = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        if (!atual) return b.criar(tx, cx, TIPO.CONFIGURACAO_UNIDADE, { ...c, chaveIdempotencia: "unidade", impressao: null }, justificativa);
        return b.alterar(tx, cx, TIPO.CONFIGURACAO_UNIDADE, atual, c, EVENTO_HISTORICO.CONFIGURACAO, justificativa);
      });
    },

    /** Cadastra (ou reativa/renomeia) um canal ou processador da unidade. Código livre aponta para um código BASE do motor. */
    registrarCanalOuProcessador(ctx, e = {}) {
      semCamposDesconhecidos(e, ["papel", "codigo", "codigoBase", "nome", "situacao", "observacao", "justificativa"], "cadastroComercial");
      const papel = exigirUmDe(e.papel, PAPEL_COMERCIAL, "papel");
      const codigo = typeof e.codigo === "string" && CODIGO_LIVRE.test(e.codigo) ? e.codigo : falhar(CODIGO.ENTRADA_INVALIDA, "Código em letras maiúsculas, números e _ (2 a 40).", { campo: "codigo" });
      const codigoBase = exigirUmDe(e.codigoBase ?? codigo, papel === PAPEL_COMERCIAL.CANAL ? CANAL : PROCESSADOR, "codigoBase");
      const dados = {
        papel, codigo, codigoBase, nome: exigirTexto(e.nome, "nome", { max: 80 }), situacao: exigirUmDe(e.situacao ?? SITUACAO_CADASTRO.ATIVO, SITUACAO_CADASTRO, "situacao"),
        observacao: exigirTexto(e.observacao, "observacao", { max: 300, opcional: true }),
      };
      const justificativa = exigirTexto(e.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.CONFIGURAR, async (cx, tx) => {
        const chave = chaveDoCadastro(papel, codigo);
        const atual = await tx.buscarPorChave(cx, TIPO.CANAL_PROCESSADOR, chave);
        if (!atual) return b.criar(tx, cx, TIPO.CANAL_PROCESSADOR, { ...dados, chaveIdempotencia: chave, impressao: null }, justificativa);
        if (atual.codigoBase !== codigoBase) falhar(CODIGO.ENTRADA_INVALIDA, "O código base de um cadastro não muda: cadastre outro código.", { campo: "codigoBase" });
        return b.alterar(tx, cx, TIPO.CANAL_PROCESSADOR, atual, { nome: dados.nome, situacao: dados.situacao, observacao: dados.observacao }, EVENTO_HISTORICO.CONFIGURACAO, justificativa);
      });
    },

    /**
     * Altera uma conta financeira. Renomear exige configurar; DESATIVAR (ou reativar) afeta saldos e conciliação e exige
     * também conciliar. Conta com sessão de caixa aberta não é desativada.
     */
    alterarContaFinanceira(ctx, e = {}) {
      semCamposDesconhecidos(e, ["contaId", "nome", "instituicao", "ativa", "justificativa"], "conta");
      const contaId = exigirUuid(e.contaId, "contaId");
      const mudancas = {};
      if (e.nome !== undefined) mudancas.nome = exigirTexto(e.nome, "nome", { max: 80 });
      if (e.instituicao !== undefined) mudancas.instituicao = exigirTexto(e.instituicao, "instituicao", { max: 80, opcional: true });
      if (e.ativa !== undefined) {
        if (typeof e.ativa !== "boolean") falhar(CODIGO.ENTRADA_INVALIDA, "ativa deve ser verdadeiro ou falso.", { campo: "ativa" });
        mudancas.ativa = e.ativa;
      }
      if (!Object.keys(mudancas).length) falhar(CODIGO.ENTRADA_INVALIDA, "Nada a alterar.");
      const justificativa = exigirTexto(e.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.CONFIGURAR, async (cx, tx) => {
        const conta = await b.obterOuFalhar(tx, cx, TIPO.CONTA, contaId, "Conta financeira");
        if ("ativa" in mudancas && mudancas.ativa !== conta.ativa) {
          if (!cx.permissoes.includes(ACAO.CONCILIAR)) falhar(CODIGO.PERMISSAO_INSUFICIENTE, "Ativar ou desativar uma conta afeta saldos e conciliação: exige também a permissão de conciliar.", { acao: ACAO.CONCILIAR });
          await b.exigirConcessaoVigente(tx, cx, ACAO.CONCILIAR);
          const abertas = await tx.listar(cx, TIPO.SESSAO_CAIXA, { onde: { contaId, situacao: SITUACAO_SESSAO_CAIXA.ABERTA } });
          if (abertas.length) falhar(CODIGO.OPERACAO_INVALIDA, "Há sessão de caixa aberta nesta conta: feche-a antes de desativar.");
        }
        return b.alterar(tx, cx, TIPO.CONTA, conta, mudancas, EVENTO_HISTORICO.CONFIGURACAO, justificativa);
      });
    },

    /** Histórico e uso de uma categoria (lançamentos e competências), para decidir inativação com segurança. */
    consultarCategoria(ctx, e = {}) {
      semCamposDesconhecidos(e, ["codigo"], "categoria");
      const codigo = exigirTexto(e.codigo, "codigo", { max: 60 });
      return b.consultar(ctx, async (cx, tx) => {
        const cat = await b.categoriaPorCodigo(tx, cx, codigo);
        if (!cat) falhar(CODIGO.NAO_ENCONTRADO, "Categoria não encontrada.");
        const lancs = await tx.listar(cx, TIPO.LANCAMENTO, { onde: { categoria: codigo } });
        const historico = await tx.listarHistorico(cx, { onde: { registroTipo: TIPO.CATEGORIA, registroId: cat.id } });
        return {
          codigo: cat.codigo, nome: cat.nome, classificacao: cat.classificacao, natureza: cat.natureza, ativa: cat.ativa, doSistema: cat.doSistema, aceitaLancamento: cat.aceitaLancamento,
          uso: { lancamentos: lancs.length, ativos: lancs.filter((l) => l.situacao === "ATIVO").length, competencias: [...new Set(lancs.map((l) => l.competencia))].sort() },
          lancamentos: lancs.filter((l) => l.situacao === "ATIVO").sort((a, b2) => String(b2.data ?? "").localeCompare(String(a.data ?? ""))).slice(0, 50)
            .map((l) => ({ id: l.id, descricao: l.descricao ?? null, valorCentavos: l.valorCentavos, data: l.data ?? null, competencia: l.competencia })),
          podeExcluir: false, observacao: lancs.length ? "Categoria com lançamentos: pode ser inativada (bloqueia lançamentos novos), nunca excluída — o histórico continua apurável." : "Categoria nunca é excluída; sem uso, pode ser inativada.",
          historico: historico.map((h) => ({ evento: h.evento, em: h.em, justificativa: h.justificativa ?? null, ativaAntes: h.antes?.ativa ?? null, ativaDepois: h.depois?.ativa ?? null, nomeAntes: h.antes?.nome ?? null, nomeDepois: h.depois?.nome ?? null })),
        };
      });
    },
  };
}
