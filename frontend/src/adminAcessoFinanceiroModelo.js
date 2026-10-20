// Modelo PURO (sem DOM/rede) da tela "Acesso Financeiro" do Painel SuperAdmin — gestão simples por unidade.
// Só descreve e monta o que será ENVIADO ao backend (PUT /plataforma/gestao-financeira/concessoes/unidades/:id/acessos),
// que repete todas as regras. Nada aqui simula sucesso.

/** Opções do seletor de cada usuário. `null` = Sem acesso. Rótulos para quem administra, valores = níveis do banco. */
export const OPCOES_ACESSO = Object.freeze([
  { valor: null, rotulo: "Sem acesso", descricao: "Não vê o setor Financeiro." },
  { valor: "leitura", rotulo: "Visualização", descricao: "Consulta os relatórios e telas do Financeiro." },
  { valor: "operador", rotulo: "Operador", descricao: "Consulta, cria e edita lançamentos." },
  { valor: "gestor", rotulo: "Gestor", descricao: "Tudo do operador, mais conciliar, cancelar lançamentos, configurar o plano de contas e fechar períodos." },
]);
export const ROTULO_ACESSO = Object.freeze(Object.fromEntries(OPCOES_ACESSO.map((o) => [o.valor ?? "", o.rotulo])));

/** Valor do <select> (string) -> nível (null = Sem acesso). Qualquer valor desconhecido vira Sem acesso. */
export function nivelDoSeletor(valor) {
  return OPCOES_ACESSO.some((o) => o.valor === valor && valor !== null) ? valor : null;
}

/**
 * Estado das escritas informado pelo servidor. Qualquer coisa que não seja `escritaLiberada === true` conta como
 * BLOQUEADA (falha fechada).
 * @param {{escritaLiberada?:unknown, mensagem?:string|null}|null|undefined} estado
 */
export function estadoDaEscrita(estado) {
  const liberada = estado?.escritaLiberada === true;
  return {
    liberada,
    mensagem: liberada ? "" : (estado?.mensagem ?? "A administração de acessos financeiros está desligada neste ambiente."),
  };
}

/**
 * Houve mudança em relação ao que veio do servidor?
 * @param {{habilitado:boolean, usuarios:Array<{id:string, nivel:string|null}>}} inicial
 * @param {{habilitado:boolean, niveis:Record<string, string|null>}} atual
 */
export function mudancas(inicial, atual) {
  const usuarios = inicial.usuarios
    .filter((u) => (atual.niveis[u.id] ?? null) !== (u.nivel ?? null))
    .map((u) => ({ perfilId: u.id, de: u.nivel ?? null, para: atual.niveis[u.id] ?? null }));
  const moduloMudou = inicial.habilitado !== atual.habilitado;
  return { moduloMudou, usuarios, total: usuarios.length + (moduloMudou ? 1 : 0) };
}

/** Corpo do PUT: só os usuários alterados (perfil ausente = não mexe). Nunca leva concedente, empresa ou unidade. */
export function montarPedido(inicial, atual) {
  const m = mudancas(inicial, atual);
  return { habilitado: atual.habilitado === true, acessos: m.usuarios.map((u) => ({ perfilId: u.perfilId, nivel: u.para })) };
}

/** Frase curta do resultado da gravação (o que o servidor confirmou). */
export function resumoDoResultado(r) {
  const partes = [];
  if (r?.modulo?.unidadeLigada) partes.push("Financeiro ligado na unidade");
  if (r?.modulo?.unidadeDesligada) partes.push("Financeiro desligado na unidade");
  if (r?.concedidos) partes.push(`${r.concedidos} acesso(s) liberado(s)`);
  if (r?.alterados) partes.push(`${r.alterados} nível(is) alterado(s)`);
  if (r?.revogados) partes.push(`${r.revogados} acesso(s) removido(s)`);
  const texto = partes.length ? partes.join(" · ") + "." : "Nada precisou mudar.";
  const falhas = r?.falhas?.length ? ` ${r.falhas.length} usuário(s) não puderam ser gravados.` : "";
  return texto + falhas;
}
