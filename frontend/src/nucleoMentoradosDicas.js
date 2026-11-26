// Camada de interação dos gráficos SVG do Núcleo: passar o mouse ou focar (Tab) uma marca mostra o valor exato
// no quadro de leitura do gráfico. Um único listener delegado por raiz.
export function ligarDicas(raiz) {
  const mostrar = (alvo) => {
    const g = alvo?.closest?.("[data-nm-dica]");
    const bloco = alvo?.closest?.(".nm-bloco, .ap-slide");
    const dica = bloco?.querySelector(".nm-dica");
    if (!dica) return;
    raiz.querySelectorAll(".nm-g-ponto.is-ativo").forEach((x) => x.classList.remove("is-ativo"));
    if (!g) { dica.hidden = true; return; }
    g.classList.add("is-ativo");
    dica.textContent = g.dataset.nmDica;
    dica.hidden = false;
  };
  const sobre = (e) => mostrar(e.target);
  const fora = (e) => { if (!e.relatedTarget?.closest?.("[data-nm-dica]")) mostrar(null); };
  raiz.addEventListener("pointerover", sobre);
  raiz.addEventListener("focusin", sobre);
  raiz.addEventListener("pointerout", fora);
  raiz.addEventListener("focusout", fora);
  return () => {
    raiz.removeEventListener("pointerover", sobre); raiz.removeEventListener("focusin", sobre);
    raiz.removeEventListener("pointerout", fora); raiz.removeEventListener("focusout", fora);
  };
}
