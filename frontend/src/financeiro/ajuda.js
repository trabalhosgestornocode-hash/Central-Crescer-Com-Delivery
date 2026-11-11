// Ajuda de uso das telas do Financeiro: "Como usar esta tela" (para que serve + passos + dicas) e um glossário em português simples.
// Conteúdo puro (sem rede). O bloco abre sozinho na primeira visita de cada tela; depois lembra se a pessoa o recolheu (só neste navegador).
import { escapeHtml as esc } from "../utils.js";
import { icon } from "../icons.js";

export const AJUDA = Object.freeze({
  "visao-geral": {
    paraQue: "Mostra, em uma tela, como o dinheiro da empresa se comportou no mês: quanto entrou, quanto saiu e quanto sobrou.",
    passos: [
      "Escolha o mês no alto da tela.",
      "Olhe primeiro o “Resultado gerencial”: é o que sobrou depois de pagar custos e despesas.",
      "Confira se há avisos em amarelo ou vermelho: eles dizem o que está faltando para os números ficarem completos.",
      "Clique no valor de um número para ver de onde ele vem; o ícone “Fórmula” explica como é calculado.",
    ],
    dicas: ["Aqui conta o dinheiro que realmente entrou e saiu (regime de caixa), não o que foi vendido ou prometido.", "Lançamentos sem categoria ficam fora dos números. Resolva no Fluxo de Caixa, no filtro “Pendentes”."],
    termos: ["regime-caixa", "resultado-gerencial", "pendente-classificacao"],
  },
  receitas: {
    paraQue: "Compara o que foi vendido com o que realmente entrou na conta, e mostra por que as duas coisas diferem.",
    passos: [
      "Escolha o mês.",
      "Veja o faturamento (vendido) e o recebimento (entrou no banco ou no caixa).",
      "A diferença entre os dois costuma ser taxa do aplicativo, prazo de repasse ou venda em dinheiro: confira a tabela de taxas por canal.",
      "Para lançar ou corrigir as vendas de um dia, use o botão “Vendas Diárias”.",
    ],
    dicas: ["Não é erro o recebimento ser menor que o faturamento: parte fica em taxas e em valores que ainda vão cair."],
    termos: ["faturamento", "recebimento", "repasse"],
  },
  "vendas-diarias": {
    paraQue: "É onde você registra e confere as vendas de cada dia. Serve para saber quanto vendeu e se o dinheiro do caixa físico bate.",
    passos: [
      "Todo dia (ou no fechamento do caixa), clique em “+ Registrar venda” e informe o dia e os valores por forma de pagamento.",
      "Se você usa o SAIPOS, prefira “Importar SAIPOS”: o sistema lê o arquivo e preenche os dias para você.",
      "Dias sem registro aparecem sinalizados. Abra o dia para completar ou corrigir.",
      "Confira o dinheiro e as sangrias com o que está no caixa. Se não bater, abra o dia e veja a diferença.",
    ],
    dicas: ["Registrar o mesmo dia de novo corrige o dia; não duplica."],
    termos: ["faturamento", "sangria", "venda-bruta"],
  },
  "contas-a-pagar": {
    paraQue: "Lista tudo o que a empresa deve pagar (boletos, fornecedores, serviços) e acompanha o que já foi pago.",
    passos: [
      "Para uma conta nova, clique em “Registrar conta / pagamento” e informe para quem, quanto, o vencimento e a categoria.",
      "Quando pagar, abra a conta e registre o pagamento. Pode ser em mais de uma parcela.",
      "Use os filtros (situação, fornecedor, categoria, conta) para achar o que precisa. A busca aceita o nome do fornecedor.",
      "Se pagou mais ou menos que o valor original (juros, desconto), o sistema mostra a diferença quando a conta é quitada.",
    ],
    dicas: ["A conta só entra como “paga” quando você registra o pagamento. Registrar a conta não tira dinheiro do caixa.", "Tem uma planilha com as contas do mês? Use “Importar planilha”: você vê a prévia e confirma antes de gravar; reenviar não duplica.", "Quer lançar algo rápido? O botão “+ Novo lançamento” no topo da página abre o caminho mais curto."],
    termos: ["conta-a-pagar", "competencia", "quitar", "categoria"],
  },
  conciliacao: {
    paraQue: "Confere se o dinheiro que entrou bate com o que foi vendido no mês. Se não bate, mostra onde está a diferença para você explicar.",
    passos: [
      "Informe os valores de referência do mês: vendas, taxas, sangrias e dinheiro em espécie. Use “Informar referências” ou “Importar arquivo”.",
      "Olhe o quadro “Vendas × dinheiro recebido”: ele mostra a diferença e quanto dela as taxas já explicam.",
      "A parte que sobra sem explicação precisa da sua decisão: clique em “Classificar”, escolha o motivo e escreva uma justificativa.",
      "Confira o caixa em espécie e as sangrias dia a dia. Dias com diferença têm o botão “Classificar”.",
    ],
    dicas: ["O sistema nunca assume que uma diferença é prazo de repasse: só você explica.", "Sem os valores de referência, nada é calculado. Isso é proposital, para não inventar número.", "Contas, exceções de sangria e histórico ficam em “Consulta e ajustes”, no fim da página."],
    termos: ["referencia", "sobra-sem-explicacao", "sangria", "conciliar"],
  },
  "conciliacao-saidas": {
    paraQue: "Confere se cada pagamento que você registrou aparece como saída no extrato do banco.",
    passos: [
      "Clique em “Gerar sugestões”: o sistema compara pagamentos e saídas do extrato e propõe os pares.",
      "Em “Aguardando decisão”, veja cada par. Se estiver certo, clique em “Confirmar”. Se não, em “Rejeitar”.",
      "Pagamento sem saída no extrato fica “Pendente”. Saída sem pagamento fica “A identificar”: registre o pagamento ou vincule manualmente.",
      "Se valor ou data não batem por pouco, o sistema pede uma justificativa antes de confirmar.",
    ],
    dicas: ["Nada é confirmado sozinho: mesmo com valor e data iguais, a confirmação é sua."],
    termos: ["conciliar", "extrato"],
  },
  contas: {
    paraQue: "Lista as contas onde o dinheiro fica (bancos, maquininha, caixa físico) e quanto há em cada uma.",
    passos: [
      "Veja o saldo de cada conta no mês escolhido.",
      "Para criar uma conta nova, use “Nova conta” e informe o saldo de abertura.",
      "Para passar dinheiro de uma conta sua para outra, use “Transferir”. Não conta como receita nem despesa.",
      "Abra uma conta para ver o extrato dela.",
    ],
    dicas: ["Conta é ONDE o dinheiro está. O canal de venda (iFood, balcão) é outra coisa.", "Se uma conta está sem saldo de abertura, o saldo dela aparece como “Parcial”."],
    termos: ["transferencia", "extrato"],
  },
  configuracoes: {
    paraQue: "É o lugar de arrumar a casa: contas, categorias e regras. Quase tudo aqui se faz uma vez, no começo, e raramente muda.",
    passos: [
      "Confira se todas as suas contas (bancos, maquininha, caixa) estão em “Contas financeiras”.",
      "Em cada conta, informe o saldo de abertura. Sem ele, o saldo da conta aparece como “Parcial”.",
      "Revise as categorias em “Plano de contas”. Crie uma nova só quando faltar um tipo de gasto ou de receita.",
      "Regras avançadas (conciliação, fechamento) ficam recolhidas no fim da página; você quase não vai precisar delas.",
    ],
    dicas: ["Mudanças ficam registradas, e meses já fechados são protegidos.", "Na dúvida, não mexa: o dia a dia (lançar, pagar, conferir) não depende de abrir esta tela."],
    termos: ["categoria", "saldo-abertura"],
  },
  "plano-de-contas": {
    paraQue: "A lista de categorias que você usa para classificar cada lançamento.",
    passos: [
      "Procure a categoria na lista. Cada uma tem um “papel”, que decide onde ela entra nos resultados (receita, custo, despesa…).",
      "Para uma categoria nova, clique em “Nova categoria”, dê o nome e escolha o papel.",
      "Para deixar de usar uma, desative: ela some das opções, mas os lançamentos antigos continuam.",
    ],
    dicas: ["O papel não muda enquanto a categoria já tem lançamentos. Para mudar, reclassifique os lançamentos em outra categoria."],
    termos: ["categoria"],
  },
  periodos: {
    paraQue: "Controla o fechamento dos meses. Fechar um mês guarda uma “foto” dos resultados e impede mudanças nele.",
    passos: [
      "No fim do mês, use “Pré-fechamento” para ver o que ainda está pendente.",
      "Resolva as pendências (lançamentos sem categoria, conferências abertas).",
      "Com tudo resolvido, feche o mês. O resultado fica guardado como estava no fechamento.",
      "Precisa corrigir um mês fechado? Reabra com um motivo: tudo fica registrado.",
    ],
    dicas: ["Fechar com pendências não é permitido pela tela."],
    termos: ["fechar-mes"],
  },
  importacao: {
    paraQue: "Traz para o sistema lançamentos de uma planilha de livro-caixa (.xlsx), sem digitar um por um.",
    passos: [
      "Envie a planilha (até 5 MB). A prévia não grava nada.",
      "Revise o que o sistema entendeu: contas, categorias e possíveis duplicados.",
      "Decida os pares duvidosos e confirme. Só então os lançamentos são gravados.",
    ],
    dicas: ["Enviar a mesma planilha de novo não duplica lançamentos.", "Para o dia a dia, lançar direto (“+ Novo lançamento”) costuma ser mais rápido."],
    termos: [],
  },
  relatorios: {
    paraQue: "Gera tabelas e arquivos (CSV ou Excel) dos seus lançamentos, para conferir ou mandar ao contador.",
    passos: [
      "Escolha o relatório na lista.",
      "Ajuste o período e os filtros (conta, categoria, tipo).",
      "Veja a tabela na tela e, se quiser, baixe em CSV ou Excel.",
    ],
    dicas: ["Cada arquivo traz período, filtros e data de geração, para ninguém confundir versões."],
    termos: [],
  },
  painel: {
    paraQue: "É a página principal do mês: mostra vendas, custos, resultado e o que ainda precisa da sua atenção, em um só lugar.",
    passos: [
      "Escolha o mês no alto da tela.",
      "Veja primeiro os números grandes: o que foi vendido, quanto custou e o que sobrou.",
      "Clique em um número (ou no ícone “i”) para ver de onde ele vem e como é calculado.",
      "Se aparecer um aviso, ele diz o que falta para o número ficar completo. Siga o aviso.",
    ],
    dicas: ["Números marcados como estimados ainda esperam confirmação. Eles mudam quando você confirma os dados."],
    termos: ["faturamento", "pendente-classificacao"],
  },
  dre: {
    paraQue: "Mostra, mês a mês, quanto a empresa ganhou ou perdeu: da venda até o resultado final, passando por custos e despesas.",
    passos: [
      "Escolha o mês.",
      "Leia de cima para baixo: venda, custos, despesas e, por fim, o resultado.",
      "Clique em uma linha para abrir os detalhes e ver quais lançamentos formam aquele valor.",
      "Se aparecer “Dados parciais” ou “Pendente da contadora”, clique para ver o que falta.",
    ],
    dicas: ["Aqui os custos são do mês a que pertencem (competência), mesmo que o pagamento caia em outro mês."],
    termos: ["competencia", "resultado-gerencial"],
  },
  "dre-caixa": {
    paraQue: "Uma versão mais técnica do resultado, feita só com o dinheiro que entrou e saiu no mês (regime de caixa).",
    passos: ["Escolha o mês.", "Marque se quer comparar com o mês anterior.", "Abra uma linha para ver os lançamentos por trás."],
    dicas: ["Para o dia a dia, use a “DRE Gerencial”. Esta serve para conferência avançada."],
    termos: ["regime-caixa"],
  },
  indicadores: {
    paraQue: "Mostra números-chave do negócio (margem, ponto de equilíbrio, variação do caixa) e como cada um é calculado.",
    passos: ["Escolha o mês.", "Veja cada indicador e o que ele significa.", "Abra a fórmula e a origem para conferir de onde vem o número."],
    dicas: ["Todo número é recalculado dos lançamentos. Se um indicador está “Parcial”, falta informação."],
    termos: ["resultado-gerencial"],
  },
  categorias: {
    paraQue: "Mostra o que mais pesa nas saídas do mês, categoria por categoria.",
    passos: ["Escolha o mês.", "Veja a lista das maiores categorias, da que mais pesa para a que menos pesa.", "Use para decidir onde cortar ou renegociar."],
    dicas: ["Transferências entre contas e o saldo anterior não entram nesta análise."],
    termos: ["categoria"],
  },
  juros: {
    paraQue: "Mostra quanto foi pago a mais por atraso, multa ou tarifa nas contas já quitadas.",
    passos: ["Escolha o período (de / até).", "Veja o total pago de acréscimos e a lista das contas.", "Classifique a diferença de cada conta quando o sistema pedir."],
    dicas: ["Só aparece aqui conta já quitada. Juros de empréstimo são tratados em Dívidas e Empréstimos."],
    termos: ["quitar", "conta-a-pagar"],
  },
  rateios: {
    paraQue: "Espalha o custo de uma conta por vários meses, quando o gasto serve a mais de um mês (por exemplo, uma compra grande de insumos).",
    passos: ["Escolha a conta e o período de consumo.", "Defina como dividir entre os meses.", "Confirme. O pagamento e o extrato não mudam; só o resultado de cada mês."],
    dicas: ["Rateio muda só o resultado (DRE). O dinheiro que saiu continua sendo o mesmo."],
    termos: ["competencia"],
  },
  "contas-a-receber": {
    paraQue: "Lista valores que a empresa ainda tem a receber: repasses, reembolsos e vendas a prazo.",
    passos: ["Registre o valor a receber, de quem e a data prevista.", "Quando o dinheiro entrar, vincule a entrada que já está no extrato.", "Acompanhe o que está em aberto e o que já foi recebido."],
    dicas: ["Registrar um valor a receber não coloca dinheiro no caixa. O caixa só muda quando o dinheiro entra de verdade."],
    termos: ["repasse", "recebimento"],
  },
  dividas: {
    paraQue: "Controla dívidas e empréstimos: quanto se deve, a quem e como está sendo pago.",
    passos: ["Cadastre a dívida (quem, valor, parcelas).", "Registre cada parcela paga.", "Acompanhe o saldo devedor. Se não souber o saldo, o sistema mostra “desconhecido”, nunca zero."],
    dicas: ["Dívida de sócio, da empresa e de terceiros ficam separadas para não se misturarem."],
    termos: ["categoria"],
  },
  "fluxo-de-caixa": {
    paraQue: "É o livro-caixa: todo dinheiro que entrou e saiu das contas, na ordem em que aconteceu.",
    passos: [
      "Use “Novo lançamento” para registrar uma entrada ou uma saída.",
      "Para mover dinheiro entre contas suas, use “Nova transferência” (não conta como despesa nem receita).",
      "Filtre por mês, conta ou situação para achar um lançamento. Abra a linha para ver o histórico.",
      "Lançou errado? Cancele com o motivo: nada é apagado, e tudo fica registrado no histórico.",
    ],
    dicas: ["Lançamentos sem categoria ficam como “pendentes”: classifique para eles entrarem nos resultados."],
    termos: ["transferencia", "categoria", "pendente-classificacao"],
  },
});

export const GLOSSARIO = Object.freeze({
  "regime-caixa": ["Regime de caixa", "Conta o dinheiro quando ele entra ou sai de verdade, e não quando a venda ou a compra foi combinada."],
  "resultado-gerencial": ["Resultado gerencial", "O que sobrou no mês depois de tirar custos e despesas da receita. É a “sobra” do negócio."],
  "pendente-classificacao": ["Pendente de classificação", "Lançamento ainda sem categoria (ou com categoria a confirmar). Sem categoria, ele não entra nos resultados."],
  faturamento: ["Faturamento", "Tudo o que foi vendido no período, antes de taxas e de o dinheiro cair na conta."],
  recebimento: ["Recebimento", "O dinheiro que realmente entrou no banco ou no caixa."],
  repasse: ["Repasse", "O pagamento que o aplicativo ou a maquininha faz para você, depois de descontar taxas."],
  sangria: ["Sangria", "Dinheiro retirado do caixa durante o dia (por exemplo, para guardar ou pagar algo)."],
  "venda-bruta": ["Venda bruta", "O total vendido no dia, sem descontar taxas nem devoluções."],
  "conta-a-pagar": ["Conta a pagar", "Um compromisso de pagamento: boleto, fatura, parcela. Ainda não saiu dinheiro até você registrar o pagamento."],
  competencia: ["Competência", "O mês a que a despesa pertence no resultado, mesmo que o pagamento aconteça em outro mês."],
  quitar: ["Quitar", "Terminar de pagar a conta. Só depois de quitada o sistema calcula juros ou desconto."],
  categoria: ["Categoria", "O “tipo” do lançamento (aluguel, frutas, salário…). É ela que decide onde o valor aparece nos resultados."],
  referencia: ["Valores de referência", "Números que vêm de fora do livro-caixa (relatório de vendas, taxas, sangrias) e servem de régua para conferir o que entrou."],
  "sobra-sem-explicacao": ["Sobra sem explicação", "A parte da diferença que as taxas não explicam. Só você decide o motivo; o sistema não assume."],
  conciliar: ["Conciliar", "Conferir se dois registros contam a mesma história (por exemplo, o pagamento e a saída no extrato) e confirmar que batem."],
  extrato: ["Extrato", "A lista de movimentos de uma conta, como o banco mostra."],
  "saldo-abertura": ["Saldo de abertura", "Quanto havia na conta no início do controle. Sem ele, o saldo atual não pode ser calculado por completo."],
  "fechar-mes": ["Fechar o mês", "Encerrar o mês: os resultados ficam guardados e o mês deixa de aceitar lançamentos e mudanças."],
  transferencia: ["Transferência", "Dinheiro que muda de uma conta sua para outra. Não é receita nem despesa."],
});

/** Texto de apoio (sem HTML) — usado nos testes e por quem precisar do conteúdo puro. */
export const ajudaDe = (chave) => AJUDA[chave] ?? null;

const chaveArmazem = (chave) => `fin:ajuda:${chave}`;
function lembrouFechar(chave) { try { return localStorage.getItem(chaveArmazem(chave)) === "fechada"; } catch { return false; } }

/** Bloco "Como usar esta tela" (HTML). Aberto na primeira visita; a escolha de recolher fica guardada neste navegador. */
export function blocoAjuda(chave) {
  const a = AJUDA[chave];
  if (!a) return "";
  ouvirAjuda();
  const termos = (a.termos ?? []).map((t) => GLOSSARIO[t]).filter(Boolean);
  return `<details class="fin-ajuda" data-ajuda="${esc(chave)}"${lembrouFechar(chave) ? "" : " open"}>
    <summary><span class="fin-ajuda-ic" aria-hidden="true">${icon("info", { size: 16 })}</span>Como usar esta tela</summary>
    <div class="fin-ajuda-corpo">
      <p class="fin-ajuda-quer">${esc(a.paraQue)}</p>
      <ol class="fin-ajuda-passos">${a.passos.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>
      ${(a.dicas ?? []).length ? `<ul class="fin-ajuda-dicas">${a.dicas.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
      ${termos.length ? `<dl class="fin-ajuda-termos">${termos.map(([t, d]) => `<div><dt>${esc(t)}</dt><dd>${esc(d)}</dd></div>`).join("")}</dl>` : ""}
    </div></details>`;
}

let ouvindo = false;
/** Um só ouvinte no documento: guarda se a pessoa recolheu/abriu o bloco (o evento "toggle" não borbulha, por isso captura). */
export function ouvirAjuda() {
  if (ouvindo || typeof document === "undefined") return;
  ouvindo = true;
  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (!d?.matches?.("details.fin-ajuda")) return;
    try { localStorage.setItem(chaveArmazem(d.dataset.ajuda), d.open ? "aberta" : "fechada"); } catch { /* sem storage: ok */ }
  }, true);
}
