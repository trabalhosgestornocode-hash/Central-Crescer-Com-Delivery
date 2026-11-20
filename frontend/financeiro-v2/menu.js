// Menu recolhível: preferência de INTERFACE deste navegador (recolhido/aberto). Não guarda nada financeiro nem credencial.
// O valor inicial é aplicado por tema.js antes da primeira pintura; aqui ficam o botão e a gravação da escolha.
// No celular o menu é uma gaveta: começa fechada, não grava preferência (ela vale só para telas largas) e fecha ao navegar.
export function iniciarMenuRecolhivel(doc = document, janela = window) {
  const botao = doc.querySelector("#nav-alternar");
  const celular = () => Boolean(janela.matchMedia?.("(max-width: 760px)").matches);
  const aplicar = (recolhido) => {
    doc.documentElement.dataset.nav = recolhido ? "recolhida" : "aberta";
    botao?.setAttribute("aria-expanded", String(!recolhido));
  };
  aplicar(doc.documentElement.dataset.nav === "recolhida");
  botao?.addEventListener("click", () => {
    const recolher = doc.documentElement.dataset.nav !== "recolhida";
    aplicar(recolher);
    if (celular()) return;
    try { localStorage.setItem("fv2-menu", recolher ? "recolhido" : "aberto"); } catch { /* preferência é só conveniência */ }
  });
  janela.addEventListener("hashchange", () => { if (celular()) aplicar(true); });
}
