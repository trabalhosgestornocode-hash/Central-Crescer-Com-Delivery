// Cenários controlados locais; nenhum dado é persistido em banco.
export const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export function criarCenario() {
 const orgs = [1,2].map(n=>({id:id(n),nome:n===1?'QA Grupo Marketplace':'QA Grupo Full Service',status:'ativa',eh_modelo:false,created_at:'2024-01-01T00:00:00Z'}));
 const specs = [
  [11,1,'MP Dentro da Meta','marketplace',10], [12,1,'MP Dentro do Limite','marketplace',14],
  [13,1,'MP Acima do Limite','marketplace',16], [14,1,'MP Sem dados','marketplace',null],
  [15,1,'MP Meta personalizada','marketplace',9], [16,1,'MP Lançamento mensal','marketplace',10],
  [21,2,'FS Dentro da Meta','full_service',18], [22,2,'FS Dentro do Limite','full_service',23],
  [23,2,'FS Acima do Limite','full_service',27], [24,2,'FS Meta dinâmica','full_service',23],
  [25,2,'Unidade Mudança de modalidade','full_service',20],
 ];
 const unidades=specs.map(([n,o,nome,modelo])=>({id:id(n),organizacao_id:id(o),nome,ativo:true,eh_teste:false,created_at:'2024-01-01T00:00:00Z',modelo_logistico_ifood:modelo,tabela_balcao:n===24?'DINAMICA':'SEM_PRECO',tabela_ifood:n===24?'DINAMICA':'SEM_PRECO'}));
 const metas=[];
 for (const [modelo,ideal,limite] of [['marketplace',12,15],['full_service',20,25]]) for(const ind of ['taxas_comissoes','servicos_promocoes','taxas_entregadores','total_deducoes']) metas.push({id:id(100+metas.length),organizacao_id:null,unidade_id:null,modelo_logistico:modelo,indicador:ind,meta_ideal:(ind==='total_deducoes'?ideal:ind==='taxas_comissoes'?modelo==='marketplace'?6:10:ind==='servicos_promocoes'?modelo==='marketplace'?4:10:2)/100,limite:(ind==='total_deducoes'?limite:ind==='taxas_comissoes'?modelo==='marketplace'?10:15:ind==='servicos_promocoes'?10:5)/100});
 metas.push({id:id(120),organizacao_id:id(1),unidade_id:id(15),modelo_logistico:'marketplace',indicador:'total_deducoes',meta_ideal:0.08,limite:0.10});
 const linhas=[];
 for(const ym of ['2025-10','2026-09','2026-10']) {
  const [ano,mes]=ym.split('-').map(Number), dias=new Date(Date.UTC(ano,mes,0)).getUTCDate();
  for(const [n,o,nome,modelo,pctOriginal] of specs) {
   if(pctOriginal==null)continue;
   const pct=ym==='2026-09' && n===11?17:ym==='2025-10' && n===11?14:pctOriginal;
   for(let d=1;d<=dias;d++) {
    // FS Acima do Limite tem preenchimento completo; MP Dentro da Meta tem pendências operacionais.
    if(n===11 && d<dias && d%3===0)continue;
    const misto=n===25 && ym==='2026-10';
    const taxas=misto?(Math.min(d,15)*100+Math.max(d-15,0)*200):d*1000*pct/100;
    linhas.push({id:id(10000+linhas.length),organizacao_id:id(o),unidade_id:id(n),data_lancamento:`${ym}-${String(d).padStart(2,'0')}`,valor_vendas_ifood:n===16?1000:d*1000,valor_vendas_bruto:1000,qtd_vendas:20,novos_clientes:2,taxas_comissoes:n===16?100:taxas,servicos_promocoes:0,taxas_entregadores:misto?Math.min(d,15)*100:0,ajustes_contra_loja:0,ajustes_favor_loja:0,status:'finalizado',situacao:'normal',origem_lancamento:n===16?'distribuicao_mensal':'diario'});
   }
  }
 }
 return {organizacoes:orgs,unidades,organizacao_modulos:orgs.map(o=>({organizacao_id:o.id,modulo_id:'ifood_dashboard'})),unidade_modulos:unidades.map(u=>({unidade_id:u.id,modulo_id:'ifood_dashboard'})),metas_indicadores:metas,lancamentos_financeiros_diarios:linhas,unidade_modelo_logistico_historico:[{id:id(150),organizacao_id:id(2),unidade_id:id(25),vigencia_inicio:'2026-10-16',modelo_anterior:'marketplace',modelo_novo:'full_service'}],produtos:[{id:id(200),organizacao_id:id(2),nome:'Churrasco 15cm',tamanho:'15cm',ativo:true,custo_manual:6}],produto_precos:[{produto_id:id(200),canal:'balcao',tabela:'DINAMICA',preco:15.2},{produto_id:id(200),canal:'ifood',tabela:'DINAMICA',preco:20}]};
}
