// Menu recolhível: preferência de INTERFACE deste navegador (recolhido/aberto). Não guarda nada financeiro nem credencial.
// O valor inicial é aplicado por tema.js antes da primeira pintura; aqui ficam o botão e a gravação da escolha.
export function iniciarMenuRecolhivel(doc = document) {
  const botao = doc.querySelector("#nav-alternar");
  const aplicar = (recolhido) => {
    doc.documentElement.dataset.nav = recolhido ? "recolhida" : "aberta";
    botao?.setAttribute("aria-expanded", String(!recolhido));
  };
  aplicar(doc.documentElement.dataset.nav === "recolhida");
  botao?.addEventListener("click", () => {
    const recolher = doc.documentElement.dataset.nav !== "recolhida";
    aplicar(recolher);
    try { localStorage.setItem("fv2-menu", recolher ? "recolhido" : "aberto"); } catch { /* preferência é só conveniência */ }
  });
}
