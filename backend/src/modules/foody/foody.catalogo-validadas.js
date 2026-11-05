// Linhas de item VALIDADAS À MÃO (conexão compartilhada Subway Saci + Açaí no Grau Saci). Complementa o catálogo GERADO
// (foody.catalogo-operacao.js): o gerador só treina com pedidos que trazem termo de operação, então itens que aparecem em
// pedidos sem termo — ou que são raros — nunca entram sozinhos e mandam o pedido para a triagem.
//
// Regras (conferidas por incluirValidadas() e pelo teste de regressão):
//   * a linha já vem NORMALIZADA (normalizarLinhaItem), é cardápio (não texto livre) e não contém termo validado da outra operação;
//   * não pode existir no catálogo da outra operação;
//   * cada linha registra a evidência e quando foi validada. Mudança só por PR, com nova versão do catálogo.
// Conteúdo: só nomes de produto do cardápio — nenhum dado de cliente, endereço ou entregador.
export const LINHAS_VALIDADAS = Object.freeze([
  Object.freeze({
    operacao: "subway",
    linha: "combos no precinho #cm #x frango defumado com cream cheese",
    validadoEm: "2026-11-05",
    evidencia: "triagem do piloto Foody de 02/11/2026; no histórico do Parser: 21 pedidos Subway em 16 dias desde 17/08/2026, 0 no Açaí; "
      + "'frango defumado' aparece em 2.667 pedidos Subway e 0 do Açaí; 'combos no precinho' em 91 Subway e 0 do Açaí",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "subs #cm #x b.m.t.",
    validadoEm: "2026-11-05",
    evidencia: "triagem do piloto Foody de 02/11/2026; B.M.T. é sanduíche do cardápio Subway: 67 pedidos Subway e 0 do Açaí no histórico; "
      + "categoria 'subs' em 961 pedidos Subway e 0 do Açaí; o Excel do dia classifica o pedido como Subway",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "sucos #x suco del valle uva",
    validadoEm: "2026-11-05",
    evidencia: "triagem do piloto Foody de 02/11/2026; 'del valle' em 184 pedidos Subway e 0 do Açaí no histórico; o único suco já vendido "
      + "pelo Açaí é de outra marca e sem a categoria 'sucos'; o Excel do dia classifica o pedido como Subway",
  }),
  Object.freeze({
    operacao: "acai_no_grau",
    linha: "suco nectar maracuja #ml - mirador",
    validadoEm: "2026-11-05",
    evidencia: "triagem de 31/10–01/11/2026; confirmado pelo responsável na ordem de 05/11/2026: o suco Mirador é do Açaí; no histórico "
      + "do Parser: 1 pedido, rotulado Açaí (veio junto de açaí), 0 na Subway; a marca 'mirador' nunca aparece em pedido Subway",
  }),
]);
