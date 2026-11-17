# 46 — Pré-publicação (Fase 10): navegador, migrações, correção de 16/11 e roteiro operacional

> Documento público: **nenhum valor, taxa, nome ou pedido real**. Nada foi publicado, migrado em produção nem gravado em dados
> reais. As leituras em produção foram **só de leitura** (nomes e hashes de migração, restrições, contagens). Todo ensaio rodou
> no PostgreSQL local isolado ou em memória.

## 1. Telas no navegador

**Como foi feito:** Chrome real, comandado pelo Playwright, contra o ambiente demonstrativo local (`scripts/fv2-demo-interface.mjs`,
dados sintéticos). O roteiro ficou versionado em `backend/scripts/fv2/navegadorCanais.mjs` (sai com erro se algo falhar).
Cobre desktop (1366 × 900), seis larguras (768 a 1920) e celular (390 × 844).

**Resultado final: 50 de 50 verificações aprovadas** (nenhuma ignorada, nenhuma contada como aprovada sem rodar):
- SAIPOS: as seis abas (aria-current), cards por modalidade, "Taxa não configurada", expansão por bandeira, painel "Ver lançamentos" (fecha com Esc),
  filtro de período.
- Importações: lista, abertura do formulário no painel e bloqueio sem arquivo.
- Fechamento manual: grade fixa, validação de valor ("12,345" recusado), confirmação obrigatória, registro e exibição do caixa.
- Faturamento manual provisório: justificativa obrigatória, registro, selo PROVISÓRIO, substituição exige confirmação.
- Operadoras e Taxas: versões de taxa expansíveis, formulário exige justificativa e confirmação; perfil sem permissão não vê formulário.
- iFood e 99Food: só fonte oficial; a 99Food diz que depende do relatório oficial (nenhum número presumido).
- Visão Geral (quatro canais) e DRE (linhas expansíveis, taxa estimada fora da despesa).
- Acesso: sem concessão, sessão expirada e sem sessão mostram aviso e nenhum valor.
- Acessibilidade: foco visível por teclado e nenhum botão sem nome.
- Console sem erro de JavaScript; sem rolagem horizontal em nenhuma tela de canais, em nenhuma largura.

**Defeitos reais encontrados e corrigidos:**
1. **Período invertido virava beco sem saída.** Ao escolher uma data inicial depois da final, a tela inteira (inclusive o filtro) era
   trocada por "Não foi possível carregar. Período invertido." e não havia onde corrigir. Agora o aviso aparece no próprio filtro,
   a tela não recarrega e o formulário continua (`app.js`, `aplicarFiltroLocal`).
2. **Rolagem horizontal em iFood e 99Food a 1366 px.** O texto "Depende do relatório oficial" herdava o tamanho grande de número e não quebrava
   linha (`fv2.css`).
3. **Códigos crus na Visão Geral.** "Não atribuído a canal" mostrava `DESPESAS_OPERACIONAIS` e `RESULTADO_FINANCEIRO`. Agora usa os nomes em português.

**Não coberto (honestidade):** a sessão real da plataforma (login e troca de unidade) não existe no ambiente demonstrativo; os 26 testes
Playwright dos outros módulos (checklist, iFood, Central de Conferências etc.) continuam ignorados e não têm relação com estas telas.

## 2. Auditoria das migrações 0024 e 0025

**Estado verificado em produção (só leitura, 17/11/2026):** 23 migrações registradas (0001 a 0023), com nome e hash **idênticos** aos
do Git. 0024 e 0025 não estão lá.

**Dois defeitos impeditivos, encontrados e corrigidos:**
1. **O pacote de atualização estava apontando para a base errada.** `atualizar.sql` partia de 0022 e exigia 22 migrações registradas. Produção
   já tem 23 (a 0023 foi aplicada em 15/11). Resultado: o pacote **abortaria com segurança** ("23 migrações registradas (esperado 22)"),
   mas ficaria inutilizável. Corrigido: base 0023, pacote regenerado.
2. **A 0024 apagava, sem querer, uma restrição que não devia mudar.** Ela remove toda CHECK que cita `ANOTA_AI` nas tabelas de venda. Isso levava junto
   `fv2_venda_fonte_sistema_check` (origem da venda: SAIPOS, IFOOD, ANOTA_AI, MANUAL), que não era reposta. Em produção, a origem da venda ficaria
   sem validação. Corrigido: a 0024 recria essa restrição, idêntica à da fundação. Como a 0024 não está em nenhum banco real, editar o
   arquivo é seguro (se estivesse aplicada, o sistema recusaria a edição pelo hash).

**Ensaio do pacote real** (`test/financeiro-v2/atualizacao-producao.test.js`, PostgreSQL local): parte de um banco no estado 0001–0023 com
vendas, lançamentos, pagamentos e recebíveis sintéticos e aplica `atualizar.sql` como ele seria aplicado (papel sem superusuário, uma transação).
Confere:
- nenhuma venda, valor, lançamento ou pagamento mudou;
- a restrição de origem da venda continua;
- o canal 99Food passa a ser aceito, e canal ou origem inexistentes continuam recusados;
- `fv2_fechamento_caixa` nasce com RLS forçada e sem privilégio para PUBLIC;
- repetir o pacote é recusado antes de mudar qualquer coisa.
O teste **falha** com a base antiga (prova de que pega o defeito 1).

| Critério | Resultado |
|---|---|
| Compatibilidade com o banco de produção | 0024 e 0025 só acrescentam (tabela nova, CHECK ampliadas); 0025 tem pré-condições conferidas pelo pacote |
| Dados financeiros existentes | nenhuma linha alterada; a CHECK ampliada aceita todo valor antigo |
| Isolamento entre empresas e unidades | tabela nova com RLS forçada, política por escopo, sem exclusão, versão e histórico obrigatórios |
| Permissões | inserir exige `registrar`; sem privilégio para PUBLIC ou papéis comuns (pós-condição do pacote) |
| Idempotência | o registro `fv2_migracao` e as pré-condições do pacote impedem repetir; o SQL cru da 0025 (`create table`) não é reexecutável, de propósito |
| Dependências | 0024 não depende de 0025; 0025 só usa objetos que já existem em produção (molde das tabelas, `fv2_escopo`, funções de sessão, de ação e de histórico) |
| Ordem | 0024 e depois 0025 (o pacote já aplica nesta ordem); migração antes do código |

## 3. Importação de 16/11

Simulação antes e depois feita a partir da leitura **só de leitura** de produção e do relatório real (planilha entregue fora do Git).
Os números exatos ficam fora deste documento público.

**Achados novos, além do doc 45:**
- **O plano não funcionava como estava escrito.** Mesmo cancelando as vendas por forma de pagamento, a importação por pedido continuava
  recusada ("já existe receita do mesmo dia pela outra granularidade"), porque a **proposta** aplicada continuava ativa e bloqueava o dia.
  Não existe operação de reverter proposta de forma-dia (só a de agregado). Corrigido: uma proposta de venda cuja venda foi **cancelada** deixa de bloquear
  (`conflitoDeGranularidade`). Uma venda ativa continua bloqueando como antes.
- **Dinheiro no caixa trava o cancelamento.** As vendas em dinheiro têm entrada no caixa; cancelar a venda é recusado até estornar a entrada
  (correção de pagamento, permitida enquanto a entrada não estiver conciliada). O plano passou a ter esse passo.
- **Em produção, os recebíveis dessas vendas estão todos em aberto, sem repasse recebido**, e as entradas em dinheiro não estão conciliadas.
  Por isso nada impede o cancelamento depois do estorno. Novembro não está fechado.

**Ensaio do procedimento inteiro** (`test/financeiro-v2/correcao-importacao-forma-dia.test.js`, memória e PostgreSQL): estado "antes" com iFood vindo da
SAIPOS → o por pedido é recusado → cancelar venda com dinheiro é recusado → estornar o dinheiro e cancelar → importar por pedido → totais iguais ao
esperado (só Presencial e Anota Aí, iFood e 99Food zerados na SAIPOS) → nada apagado, nenhum recebível por forma aberto, dinheiro no caixa só o
do por pedido → reaplicar não duplica.

**Efeito esperado em novembro:**
- Presencial: cai (os pedidos pagos em dinheiro ou cartão na entrega do iFood saem do Balcão);
- Anota Aí: sobe (a entrega passa a entrar no bruto);
- iFood: sai da receita até existir o demonstrativo oficial (aparece como "sem demonstrativo", nunca como zero confirmado);
- "Outro" (99Food via SAIPOS): zera;
- deduções a classificar: passam a existir (descontos do Anota Aí);
- o dia 16/11 entra inteiro pela importação por pedido.

## 4. Roteiro operacional de publicação (**nada disto foi executado**)

Cada passo só começa depois do anterior conferido, e **cada bloco exige autorização específica do proprietário**.

### 4.1 Pré-requisitos
- [ ] Autorização explícita para publicar (código) e outra para aplicar as migrações.
- [ ] Branch revisada e mesclada; `node scripts/fv2/pacoteProducao.mjs --conferir` devolve "Pacote de produção em dia".
- [ ] Suítes verdes no commit a publicar (memória, PostgreSQL local, frontend) e `navegadorCanais.mjs` com 50/50.
- [ ] Leitura em produção: `fv2_migracao` com 23 linhas e hashes iguais aos do Git (mesma consulta desta fase).
- [ ] Janela combinada e ninguém operando o Financeiro v2 (a escrita das unidades segue como está; nada é habilitado).

### 4.2 Backup e recuperação
- [ ] Foto do sistema: rodar `inventario.sql` (só leitura) e guardar o hash.
- [ ] Backup lógico do schema: `pg_dump -n financeiro_v2 -Fc` e, se disponível, ponto de restauração do projeto.
- [ ] Verificar que o backup restaura (restaurar num PostgreSQL local isolado e conferir contagens de vendas, lançamentos e `fv2_migracao`).
- [ ] Anotar a contagem por tabela e a soma de bruto das vendas antes.

### 4.3 Migrações (futuro)
- [ ] Aplicar `database/financeiro-v2/producao/atualizar.sql` como `postgres` (sem superusuário), numa única transação
      (`psql -v ON_ERROR_STOP=1 -1 -f atualizar.sql`). As pré-condições abortam se a base não for exatamente 0001–0023.
- [ ] Conferir: 25 migrações; `fv2_fechamento_caixa` com RLS forçada; restrição de origem da venda presente; canal 99Food aceito.
- [ ] Rodar `inventario.sql`: o hash do sistema atual deve ser **igual** ao de antes.
- [ ] Contagens e somas das tabelas iguais às anotadas.

### 4.4 Código (futuro)
- [ ] Mesclar na `main` e deixar o Render publicar o backend (o mesmo serviço entrega `/financeiro-v2/*`).
- [ ] Acompanhar o deploy até "live" e ler os logs de inicialização sem erro.

### 4.5 Testes de leitura
- [ ] `GET /api/v1/financeiro-v2/status` responde e informa o módulo ligado.
- [ ] Com um login de administrador: SAIPOS, iFood, 99Food, Operadoras e Taxas, Visão Geral e DRE abrem sem erro (só leitura).
- [ ] Valores de novembro iguais aos de antes da publicação (nada foi corrigido ainda).

### 4.6 Segurança
- [ ] Usuário sem concessão vê "sem acesso" e nenhum valor.
- [ ] Unidade de outra empresa não aparece no seletor.
- [ ] Nenhum erro 401/403 inesperado nos logs; nenhuma rota nova responde sem sessão.

### 4.7 Quatro canais
- [ ] Presencial e Anota Aí mostram o que a SAIPOS trouxe; iFood e 99Food mostram "sem dados" quando não há fonte oficial.
- [ ] "Taxa não configurada" nos cartões enquanto as taxas não forem cadastradas (D3).

### 4.8 Permissões existentes
- [ ] Listar as concessões por unidade antes e depois: iguais. Nenhuma concessão, liberação ou escrita foi alterada pela publicação.

### 4.9 Reversão
- **Falha na migração:** nada a fazer. A transação desfaz tudo e o pacote aborta antes de mudar qualquer coisa. Conferir o hash do inventário.
- **Falha no código (migração já aplicada):** publicar de novo o commit anterior. As tabelas e restrições novas não são lidas pelo código antigo
  e as restrições ampliadas continuam aceitando todo valor antigo. Não é preciso desfazer migração.
- **Problema nos dados depois:** restaurar o backup lógico do schema `financeiro_v2` num banco paralelo e comparar; só então decidir
  (nunca sobrescrever o que está no ar sem decisão do proprietário).
- **Desativar o módulo:** `desativar.sql` (não destrutivo) e desligar a liberação das unidades pela própria aplicação.

### 4.10 Depois (cada um com decisão própria)
- D1: corrigir novembro (doc 45 §7, com o passo de estorno do dinheiro, já ensaiado).
- D3: cadastrar operadoras e taxas reais, com a vigência confirmada.
- D4: leitores oficiais do iFood e da 99Food com amostra real.

## 5. Riscos remanescentes
- Os testes de navegador cobrem a demonstração sintética, não a sessão real da plataforma: conferir uma vez no ar, em leitura.
- A correção de 16/11 mexe em vendas reais de novembro: só com a decisão D1 e em lotes pequenos, com conferência a cada lote.
- Sem D3, a estimativa de taxa fica pendente em todos os cartões.
- Sem D4, iFood e 99Food ficam sem receita na Visão Geral (por regra: nunca presumir).
