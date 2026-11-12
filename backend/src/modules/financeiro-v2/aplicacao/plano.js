// Plano de contas gerencial: cadastro hierárquico de categorias POR UNIDADE.
// As classificações principais são fixas; cada empresa tem as próprias categorias. Categoria nunca é apagada — é inativada.
import { CODIGO, falhar } from "../dominio/erros.js";
import { EVENTO_HISTORICO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { MODELO_DE_PLANO, exigirFilhaCompativel, naturezaDaCategoria } from "../dominio/planoDeContas.js";
import { validarAlteracaoCategoria, validarCategoria, validarImplantacaoDePlano } from "../contratos/comandos.js";
import { chaveDaCategoria } from "./base.js";

export function operacoesDePlano(b) {
  async function criarCategoria(tx, cx, c, doSistema = false) {
    let pai = null;
    if (c.paiCodigo) {
      pai = await b.categoriaPorCodigo(tx, cx, c.paiCodigo);
      if (!pai) falhar(CODIGO.CATEGORIA_INVALIDA, "Categoria superior inexistente.", { paiCodigo: c.paiCodigo });
    }
    const classificacao = c.classificacao ?? pai?.classificacao;
    if (!classificacao) falhar(CODIGO.CATEGORIA_INVALIDA, "Categoria de primeiro nível precisa informar a classificação.", { codigo: c.codigo });
    if (pai) exigirFilhaCompativel(pai, { classificacao });
    return b.criar(tx, cx, TIPO.CATEGORIA, {
      codigo: c.codigo, nome: c.nome, classificacao, natureza: naturezaDaCategoria(classificacao, c.natureza), paiId: pai?.id ?? null,
      aceitaLancamento: c.aceitaLancamento, exigeDocumento: c.exigeDocumento, ativa: true, doSistema,
      chaveIdempotencia: chaveDaCategoria(c.codigo), impressao: null,
    });
  }

  return {
    registrarCategoria(ctx, entrada) {
      const c = validarCategoria(entrada);
      return b.executar(ctx, ACAO.CONFIGURAR, async (cx, tx) => {
        if (await b.categoriaPorCodigo(tx, cx, c.codigo)) falhar(CODIGO.CATEGORIA_INVALIDA, "Já existe uma categoria com este código.", { codigo: c.codigo });
        return criarCategoria(tx, cx, c);
      });
    },

    /** Renomeia, inativa/reativa ou muda as regras de uso. Código, classificação e posição na árvore não mudam. */
    alterarCategoria(ctx, entrada) {
      const c = validarAlteracaoCategoria(entrada);
      return b.executar(ctx, ACAO.CONFIGURAR, async (cx, tx) => {
        const atual = await b.categoriaPorCodigo(tx, cx, c.codigo);
        if (!atual) falhar(CODIGO.NAO_ENCONTRADO, "Categoria não encontrada.", { tipo: TIPO.CATEGORIA });
        if (atual.doSistema && (c.mudancas.ativa === false || c.mudancas.aceitaLancamento === false)) {
          falhar(CODIGO.CATEGORIA_INVALIDA, "Categoria usada pelo sistema não pode ser inativada.", { codigo: c.codigo });
        }
        return b.alterar(tx, cx, TIPO.CATEGORIA, atual, c.mudancas, EVENTO_HISTORICO.CORRECAO, c.justificativa);
      });
    },

    /**
     * Implanta um MODELO de plano (BASE = genérico; ACAITERIA = BASE + categorias de uma açaiteria).
     * Idempotente: cria só o que falta e não mexe em categoria já existente.
     */
    implantarPlanoDeContas(ctx, entrada) {
      const c = validarImplantacaoDePlano(entrada);
      return b.executar(ctx, ACAO.CONFIGURAR, async (cx, tx) => {
        const criadas = [];
        for (const def of MODELO_DE_PLANO[c.modelo]) {
          if (await b.categoriaPorCodigo(tx, cx, def.codigo)) continue;
          criadas.push(await criarCategoria(tx, cx, {
            codigo: def.codigo, nome: def.nome, classificacao: def.classificacao ?? null, natureza: def.natureza ?? null, paiCodigo: def.pai,
            aceitaLancamento: def.aceitaLancamento, exigeDocumento: def.exigeDocumento === true,
          }, def.doSistema === true));
        }
        return { modelo: c.modelo, criadas: criadas.map((x) => x.codigo), total: (await tx.listar(cx, TIPO.CATEGORIA)).length };
      });
    },

    /** Plano da unidade em árvore (ordenado por código), pronto para exibição. */
    consultarPlanoDeContas(ctx) {
      return b.consultar(ctx, async (cx, tx) => {
        const todas = (await tx.listar(cx, TIPO.CATEGORIA)).sort((x, y) => x.codigo.localeCompare(y.codigo));
        const no = (c) => ({
          id: c.id, codigo: c.codigo, nome: c.nome, classificacao: c.classificacao, natureza: c.natureza, aceitaLancamento: c.aceitaLancamento,
          exigeDocumento: c.exigeDocumento, ativa: c.ativa, doSistema: c.doSistema, filhas: todas.filter((f) => f.paiId === c.id).map(no),
        });
        return todas.filter((c) => !c.paiId).map(no);
      });
    },
  };
}
