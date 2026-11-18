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
  Object.freeze({
    operacao: "subway",
    linha: "2 saladas mais desejadas: frango defumado/frango teriyaki #x salada frango defumado com cream cheese",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "acompanhamento + bebida #x doritos queijo nacho",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "aveia e mel (integral com fibras)",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "batata rustica com ervas finas #x maionese temperada",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "batata rustica com ervas finas #x parmesao",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "carne seca c/ cream cheese",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "cha ice tea limao",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "chas #x cha ice tea pessego",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "combo do dia: salada frango #x salada de frango",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "combo do dia: salada frango teriyaki #x salada frango teriyaki",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "combo do dia: salada steak churrasco #x salada steak churrasco",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "combos no precinho #cm #x presunto",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "combos no precinho #cm #x steak cheddar cremoso",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "cookie a sua escolha + bebida #x cookie macadamia",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "cookie red velvet - novo!",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "cookies individuais #x cookie recheado com brigadeiro - novo!",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "energetico monster mango loco",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "frango empanado",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "frango mostarda e mel proteico #x frango mostarda e mel proteico #cm",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "kit com 3 cookies #x cookie macadamia",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "kit com 3 cookies #x cookie recheado com nutella",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "kit com 3 cookies #x cookie red velvet - novo!",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "kit com 6 cookies #x cookie red velvet - novo!",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "kit com 6 cookies #x cookie tradicional gotas de chocolate",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "molho extra para acompanhamento #x barbecue",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "molho extra para acompanhamento #x pimenta brasileira - novo!",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "molho extra para acompanhamento #x supreme",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "salada frango desfiado - novo! #x alface",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "salada frango teriyaki",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "salada frango teriyaki - receita exclusiva #x alface",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "steak churrasco",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
  Object.freeze({
    operacao: "subway",
    linha: "suco del valle frut uva",
    validadoEm: "2026-11-18",
    evidencia: "triagem de nov/2026 conferida em 18/11/2026: item do cardápio Subway; pedidos até 15/11 confirmados na planilha da unidade Subway e nenhum pedido do Açaí (4.450 no histórico) traz este produto",
  }),
]);
