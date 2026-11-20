// Início do Crescer Com Delivery Financeiro. Arquivo próprio e SÍNCRONO no <head> (CSP sem 'unsafe-inline'), curto e sem esperar rede.
//
// 1) TEMA = o escolhido na plataforma (mesma chave e mesma regra de src/tema.js: claro por padrão, escuro só por escolha explícita),
//    aplicado antes da primeira pintura para não piscar o tema errado.
// 2) AMBIENTE: dentro da Crescer (?modo=plataforma) o aviso de demonstração NUNCA aparece, nem enquanto o resto carrega. Antes isso só
//    era decidido depois que o app.js e todos os módulos carregavam (alguns segundos com o aviso visível numa sessão real). Fora da
//    plataforma (demonstração local) o aviso continua, como deve.
// 3) FONTES sem bloquear a pintura: o CSS das fontes é pedido sem travar a renderização (o texto aparece na fonte do sistema e troca
//    para a Inter quando ela chega; font-display=swap).
// 4) PRÉ-CARGA PLANA (só na plataforma): os módulos e o supabase-js que a autenticação vai pedir em cadeia são pedidos TODOS de uma vez,
//    em vez de um nível por viagem de rede.
try {
  if (localStorage.getItem("saci-tema") === "dark") document.documentElement.setAttribute("data-theme", "dark");
} catch (e) { /* armazenamento bloqueado: segue no tema claro */ }

// 5) MENU recolhido (preferência de interface deste navegador): aplicado antes da primeira pintura para a página não "pular" depois.
try { document.documentElement.dataset.nav = localStorage.getItem("fv2-menu") === "recolhido" ? "recolhida" : "aberta"; } catch (e) { document.documentElement.dataset.nav = "aberta"; }

const naPlataforma = new URLSearchParams(location.search).get("modo") === "plataforma";
if (naPlataforma) document.documentElement.dataset.modo = "plataforma";

const fonte = document.createElement("link");
fonte.rel = "stylesheet";
fonte.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";
fonte.media = "print"; // não bloqueia a renderização; vira "all" quando carrega
fonte.onload = () => { fonte.media = "all"; };
document.head.append(fonte);

if (naPlataforma) {
  for (const href of ["../src/supabaseClient.js", "../src/sessao.js", "../src/config.js", "../src/state.js", "../src/contextoEscopo.js", "../src/contaInativa.js"]) {
    const l = document.createElement("link");
    l.rel = "modulepreload";
    l.href = href;
    document.head.append(l);
  }
  const s = document.createElement("link");
  s.rel = "preload";
  s.as = "script";
  s.href = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"; // o MESMO script que a autenticação carrega (plataforma.js)
  document.head.append(s);
}
