// Ícones SVG inline compartilhados pelos dois dashboards (Dashboard principal
// e Dashboard iFood) — mesmo estilo "stroke" já usado na tela de login e no
// topbar/sidebar (index.html): sem preenchimento, traço fino, pontas
// arredondadas. Usados no lugar de emoji (rebrand visual — remoção de emoji
// dos títulos/cards/alertas/badges/plano de ação/estados).
//
// Um SVG inline só, nunca um ícone de fonte/CDN externo: continua funcionando
// junto com o resto do app mesmo sem rede.
const ATRIBUTOS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

// path/conteúdo interno de cada ícone — nomes emprestados do vocabulário de
// cada tela (ver plano de rebrand) pra ficar óbvio onde cada um é usado.
const PATHS = {
  // seções / abas
  target: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.5"/><circle cx="12" cy="12" r=".6" fill="currentColor" stroke="none"/>',
  "bar-chart": '<path d="M3 21h18"/><rect x="5" y="12" width="3.5" height="7"/><rect x="10.2" y="8" width="3.5" height="11"/><rect x="15.5" y="4" width="3.5" height="15"/>',
  "pie-chart": '<path d="M21.2 15.9A10 10 0 1 1 8 2.8"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  "trending-up": '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M8 2.5v4M16 2.5v4M3 9.5h18"/>',
  archive: '<rect x="2.5" y="3.5" width="19" height="5" rx="1.2"/><path d="M4.5 8.5v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-10"/><path d="M10 13h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 3.2"/>',
  // alertas / diagnóstico
  "alert-triangle": '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  "clipboard-list": '<rect x="8" y="2.2" width="8" height="3.6" rx="1"/><path d="M9 4H6.5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H15"/><path d="M9 11h6M9 15h6"/>',
  "check-circle": '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.3 2.4 2.4 4.6-5.3"/>',
  // financeiro
  banknote: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.3"/><path d="M6.5 12h.01M17.5 12h.01"/>',
  wallet: '<path d="M20.5 12V7.5H5.8a2.3 2.3 0 0 1 0-4.5h13.7v4"/><path d="M3.5 5.5v13a2 2 0 0 0 2 2h15v-5.5"/><circle cx="17.5" cy="12.3" r="1.1" fill="currentColor" stroke="none"/>',
  tag: '<path d="M20.6 13.4 13 21 3 11V4h7l10.6 10.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" stroke="none"/>',
  "minus-circle": '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  calculator: '<rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M8 6.5h8M8 11h1.2M11.4 11h1.2M14.8 11h1.2M8 14.5h1.2M11.4 14.5h1.2M14.8 14.5h1.2v3.5h-1.2zM8 18h1.2"/>',
  // ações de tabela
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.5 5.5 13 13"/>',
  undo: '<path d="M3 4v6h6"/><path d="M3.5 12.5A9 9 0 1 0 6 5.6L3 8.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  // estados vazios / páginas em construção
  inbox: '<path d="M21.5 12.5v6a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-6"/><path d="M2.5 12.5h6l1.8 3h3.4l1.8-3h6"/><path d="M6.2 5 2.5 12.5M17.8 5l3.7 7.5M6.2 5h11.6"/>',
  package: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/>',
  truck: '<rect x="1.5" y="6" width="14" height="11" rx="1"/><path d="M15.5 10h4l3 3v4h-7z"/><circle cx="6" cy="19" r="2"/><circle cx="17.5" cy="19" r="2"/>',
  receipt: '<path d="M6 2.5h12a1 1 0 0 1 1 1V21l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21V3.5a1 1 0 0 1 1-1Z"/><path d="M8 8h8M8 12h8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9c.2.6.7 1 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  hammer: '<path d="m15 12-8.5 8.5a2.1 2.1 0 1 1-3-3L12 9"/><path d="M17.6 15 22 10.6"/><path d="M20.9 11.7 18.9 9.6a1 1 0 0 1 0-1.4l1-1a3.4 3.4 0 0 0-.1-4.8L18 1l-3 3 1.4 1.8a3.4 3.4 0 0 0 4.8.1l1-1a1 1 0 0 1 1.4 0l2 2Z"/>',
  // sidebar / menu / integrações
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  award: '<circle cx="12" cy="8" r="5.5"/><path d="M8.2 13 6.5 21l5.5-3 5.5 3-1.7-8"/>',
  link: '<path d="M9 17H7a5 5 0 0 1 0-10h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/>',
  bot: '<rect x="5" y="9" width="14" height="10" rx="2.5"/><path d="M12 9V5"/><circle cx="12" cy="3.4" r="1.1" fill="currentColor" stroke="none"/><path d="M9 14h.01M15 14h.01"/><path d="M2.5 12v4M21.5 12v4"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  "message-circle": '<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.4 8.4 0 0 1 12.5 3a8.4 8.4 0 0 1 8.5 8.5Z"/>',
  "credit-card": '<rect x="2" y="5" width="20" height="14" rx="2.2"/><path d="M2 10h20"/><path d="M6 15h4"/>',
  store: '<path d="M3 9h18l-1.5-5h-15L3 9z"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/>',
  smartphone: '<rect x="6" y="2.5" width="12" height="19" rx="2.2"/><path d="M11.2 18.5h1.6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  flask: '<path d="M9 2v6.3a2 2 0 0 1-.3 1L4 18a2 2 0 0 0 1.7 3h12.6a2 2 0 0 0 1.7-3l-4.7-8.7a2 2 0 0 1-.3-1V2"/><path d="M7 2h10"/><path d="M7.5 14h9"/>',
  paperclip: '<path d="M20.5 12.5 12 21a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 19a2 2 0 1 1-3-3l7.5-7.5"/>',
  "id-card": '<rect x="2" y="4.5" width="20" height="15" rx="2"/><circle cx="8.5" cy="11" r="2"/><path d="M5.5 16.2c.6-1.6 1.9-2.4 3-2.4s2.4.8 3 2.4"/><path d="M14.5 9.5h4M14.5 13h4"/>',
  "shopping-cart": '<circle cx="9" cy="20" r="1.2"/><circle cx="18" cy="20" r="1.2"/><path d="M2.5 3h2l2.6 12.6a2 2 0 0 0 2 1.6h8.5a2 2 0 0 0 2-1.6L21 7H6"/>',
  building: '<path d="M3 21h18"/><path d="M5 21V5h9v16"/><path d="M14 10h5v11"/><path d="M8 8h2M8 12h2M8 16h2"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  "trending-down": '<path d="M3 7l6 6 4-4 8 8"/><path d="M15 17h6v-6"/>',
  "list-checks": '<path d="m3.5 7 1.7 1.7L9 5"/><path d="M12 6.5h9"/><path d="m3.5 15 1.7 1.7L9 13"/><path d="M12 14.5h9"/>',
  // Agente Crescer (chat)
  send: '<path d="m3 11 18-8-8 18-2.5-7.5L3 11z"/>',
  // Parser Food Delivery (rebrand visual — famílias de ícones únicas, sem emoji)
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 9l5-5 5 5"/><path d="M12 4v12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  "sliders-horizontal": '<path d="M3 7h11M18 7h3M3 17h3M10 17h11"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  users: '<path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="3.2"/><path d="M22 20v-2a4 4 0 0 0-3-3.87"/><path d="M16 4.13a4 4 0 0 1 0 7.75"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  "file-text": '<path d="M14 2H6.5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7.5z"/><path d="M14 2v5.5h5.5"/><path d="M8.5 13h7M8.5 17h7M8.5 9h2"/>',
  "arrow-right": '<path d="M5 12h14M13 6l6 6-6 6"/>',
  "chevron-left": '<path d="m15 6-6 6 6 6"/>',
  "chevron-right": '<path d="m9 6 6 6-6 6"/>',
  scale: '<path d="M12 3v18M7 21h10"/><path d="M6.5 6 3 13a3.5 3.5 0 0 0 7 0L6.5 6zM17.5 6 14 13a3.5 3.5 0 0 0 7 0L17.5 6z"/><path d="M6.5 6h11"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  filter: '<path d="M3 4h18l-7 8.5V20l-4-2v-5.5z"/>',
};

/**
 * SVG inline de um ícone do conjunto. `nome` fora do conjunto retorna string
 * vazia (silencioso — nunca quebra o render por um nome digitado errado).
 * @param {keyof typeof PATHS} nome
 * @param {{size?: number, classe?: string}} [opts]
 */
export function icon(nome, { size = 16, classe = "" } = {}) {
  const conteudo = PATHS[nome];
  if (!conteudo) return "";
  return `<svg class="icon${classe ? ` ${classe}` : ""}" ${ATRIBUTOS} width="${size}" height="${size}" aria-hidden="true">${conteudo}</svg>`;
}
