// Política de Privacidade das notificações por WhatsApp. O texto fixo descreve apenas FATOS do sistema; os dados que dependem de verificação do responsável
// (controlador, contato, retenção, data) vêm do servidor. Sem eles a página diz que a política está em publicação — nada é inventado nem preenchido por padrão.
const raiz = document.querySelector("#tt-conteudo");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const secao = (titulo, corpo) => `<section class="tt-cartao"><h2>${esc(titulo)}</h2>${corpo}</section>`;
const lista = (itens) => `<ul>${itens.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;

function render(p) {
  if (!p?.publicada) {
    raiz.innerHTML = secao("Política em publicação", "<p>A Política de Privacidade completa ainda está sendo publicada. Ela só fica disponível depois da verificação das informações do responsável.</p>");
    return;
  }
  raiz.innerHTML = [
    secao("Quem é o responsável", `<p>${esc(p.controlador)}</p><p><small>Versão de ${esc(p.atualizadaEm)}.</small></p>`),
    secao("Para que usamos seus dados", `<p>Para enviar, pelo WhatsApp, as notificações que você autorizou sobre as unidades às quais você tem acesso: o Relatório Operacional Diário e o Resumo Operacional Semanal. Usamos seus dados apenas para gerenciar essas comunicações.</p>`),
    secao("Quais dados tratamos", lista([
      "Seu nome e o número de WhatsApp.",
      "O registro do seu consentimento: data, versão e identificação (hash) do termo aceito, categorias e unidades autorizadas.",
      "A confirmação do número por código de segurança (o código não fica guardado em texto).",
      "Registros técnicos de envio e de cancelamento (data, resultado e identificador da mensagem).",
    ]) + "<p>Os relatórios usam números operacionais agregados das unidades; eles não incluem dados pessoais dos clientes finais.</p>"),
    secao("Base legal", "<p>Seu consentimento (LGPD, art. 7º, I), dado por você ao aceitar o termo e escolher as categorias. Nenhuma categoria vem marcada por padrão.</p>"),
    secao("Seus direitos", lista([
      "Confirmar que tratamos seus dados e acessá-los.",
      "Corrigir dados incompletos, inexatos ou desatualizados.",
      "Pedir a anonimização, o bloqueio ou a eliminação de dados desnecessários, excessivos ou tratados em desconformidade.",
      "Revogar o consentimento a qualquer momento e obter informação sobre as consequências de não consentir.",
      "Pedir informações sobre com quem os dados são compartilhados.",
    ]) + "<p>Para exercer seus direitos, use o contato abaixo.</p>"),
    secao("Como cancelar", `<p>A qualquer momento, em <a href="/notificacoes/gerenciar.html">Gerenciar meus avisos</a> (você confirma o número por código de segurança e desliga as categorias que quiser) ou pelo canal de cancelamento disponibilizado. O efeito é imediato: o que já estava na fila deixa de ser enviado.</p>`),
    secao("Onde os dados ficam", "<p>Usamos infraestrutura de nuvem para o banco de dados e a hospedagem do sistema, parte dela fora do Brasil, e a plataforma WhatsApp para entregar as mensagens.</p>"),
    secao("Por quanto tempo guardamos", `<p>${esc(p.retencao)}</p>`),
    secao("Contato de privacidade", `<p>${esc(p.contato)}</p>`),
  ].join("");
}

async function carregar() {
  try {
    const r = await fetch("/api/publico/notificacoes/politica-privacidade", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", credentials: "omit" });
    const j = await r.json().catch(() => ({}));
    render(r.ok ? j.data : { publicada: false });
  } catch { render({ publicada: false }); }
}
carregar();
