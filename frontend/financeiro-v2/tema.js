// Tema do Crescer Com Delivery Financeiro = o tema escolhido na plataforma (mesma chave e mesma regra de src/tema.js:
// claro por padrão, escuro só por escolha explícita). Arquivo próprio (CSP sem 'unsafe-inline'), carregado de forma
// SÍNCRONA no <head> para não piscar o tema errado.
try {
  if (localStorage.getItem("saci-tema") === "dark") document.documentElement.setAttribute("data-theme", "dark");
} catch (e) { /* armazenamento bloqueado: segue no tema claro */ }
