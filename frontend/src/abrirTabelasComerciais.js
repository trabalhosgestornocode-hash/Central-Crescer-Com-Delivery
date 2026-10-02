// Destino do CTA "Selecionar tabelas oficiais" (Indicadores de Rentabilidade
// bloqueados no Dashboard iFood): abre Configurações → Tabelas Comerciais DA
// UNIDADE QUE O DASHBOARD ESTAVA ANALISANDO.
//
// Por que pode precisar trocar o contexto: GET/PATCH /unidade/tabelas-comerciais
// são escopados pela unidade da SESSÃO (req.tenant.unidadeId) — e o Dashboard
// iFood pode estar mostrando outra unidade (sessão em "todas as unidades" +
// seletor próprio do Dashboard). Abrir Configurações sem trocar mostraria a
// unidade errada (ou nenhuma).
//
// A troca usa o MESMO caminho do seletor global do topbar
// (sessao.js#trocarUnidadeDoContexto → POST /sessao/trocar-unidade): o backend
// valida acesso/vínculo/unidade ativa; recusa = contexto intacto, nada é aberto.
// Depois, `recarregarApp` (app.js#mostrarApp, já com rota inicial
// "configuracoes") é o funil único que reseta o estado de todos os módulos
// para a unidade nova. Ele é AGUARDADO até o fim da carga inicial: o
// `carregar()` do shell re-renderiza a rota atual ao terminar, e abrir a seção
// antes disso a faria voltar para a grade de Configurações.
//
// Dependências injetadas (app.js) — este módulo não importa router/app/sessão,
// então não cria import circular e é testável sem DOM.

/**
 * @param {{unidadeId?: string|null}} detalhe — `detail` do evento.
 * @param {{
 *   unidadeDaSessao: () => string|null,
 *   trocarUnidade: (unidadeId: string) => Promise<unknown>,
 *   recarregarApp: () => Promise<unknown>,  // resolve só depois da carga inicial do shell
 *   irPara: (rota: string) => void,
 *   rotaAtual: () => string,
 *   abrirSecao: (id: string) => void,
 *   avisar: (msg: string) => void,
 * }} deps
 * @returns {Promise<{aberto: boolean, motivo?: string, unidadeId?: string|null}>}
 */
export async function abrirTabelasComerciaisDaUnidade(detalhe, deps) {
  const alvo = typeof detalhe?.unidadeId === "string" && detalhe.unidadeId ? detalhe.unidadeId : null;

  if (alvo && alvo !== deps.unidadeDaSessao()) {
    try {
      await deps.trocarUnidade(alvo);
    } catch (e) {
      // Unidade não autorizada/inativa/inexistente: o backend recusou e o
      // contexto atual segue como estava. Não navega — fica no Dashboard.
      deps.avisar(e?.message || "Não foi possível abrir as tabelas comerciais desta unidade.");
      return { aberto: false, motivo: "troca_recusada" };
    }
    try { await deps.recarregarApp(); } catch { /* a checagem abaixo decide */ }
    // Defesa extra: só abre se o contexto realmente ficou na unidade pedida
    // (ex.: outra troca concorrente venceu durante a recarga).
    if (deps.unidadeDaSessao() !== alvo) return { aberto: false, motivo: "contexto_divergente" };
  }

  deps.irPara("configuracoes");
  if (deps.rotaAtual() !== "configuracoes") return { aberto: false, motivo: "rota_indisponivel" };
  deps.abrirSecao("precos");
  return { aberto: true, unidadeId: deps.unidadeDaSessao() };
}
