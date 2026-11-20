// Cenário SINTÉTICO (só em memória, só para testes locais): a 2ª unidade da demonstração passa a usar SWF, como a Subway Saci.
// Uso: preparar do servidor de demonstração (`--preparar=`) ou da plataforma simulada. Não toca banco nem .env.
export default async ({ nucleo, contexto, unidades }) => {
  const c = contexto(unidades[1].id);
  await nucleo.configurarUnidade(c, { nomeExibicao: "Subway Saci (sintética)", justificativa: "cenário de teste" });
  await nucleo.configurarFontesDeFaturamento(c, { fontes: ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"], justificativa: "cenário de teste" });
};
