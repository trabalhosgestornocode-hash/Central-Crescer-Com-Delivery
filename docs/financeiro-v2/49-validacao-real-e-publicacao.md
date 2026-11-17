# 49 — Validação com o relatório real e preparação da publicação (17/11/2026)

> Documento público: **nenhum valor, pedido ou cliente real**. Os números conferidos com o arquivo real ficam fora do Git
> (relatório entregue ao proprietário). Nada foi publicado: sem push, deploy, migração em produção ou alteração de dados reais.

## 1. Relatório real "Vendas por período" (SAIPOS)

### Onde rodou
- **Banco:** a demonstração local isolada (em memória, unidade de demonstração sem dados de novembro) e o PostgreSQL local isolado (ensaio de tempo).
- **Relógio da demonstração:** 17/11, com o novo argumento `--agora`, para o período 01–16/11 não ser "futuro".
- **Envio:** pela **mesma ação de envio da tela** (`/acoes/importacao/receber`), a partir do arquivo no disco.
- **O restante do fluxo foi feito no navegador:** confirmar, gerar propostas, aprovar e aplicar, calendário, cards, painel do dia.

### Limite desta validação
- A extensão Claude in Chrome não estava conectada. O navegador embutido não abre o seletor de arquivos.
- Copiar o arquivo real para a pasta servida foi bloqueado de propósito, porque o arquivo tem dados de clientes.
- Por isso o clique em "Escolher arquivo" com o arquivo real **não** foi feito. O envio passou pela mesma ação, fora do navegador.

### Resultado
- **Prévia:** todas as linhas lidas, nenhum erro e nenhuma divergência de leitura.
- **Totais:** Presencial (fichas), Anota Aí (bruto, descontos e número de pedidos), total de propostas e cancelados **iguais aos valores de referência** do proprietário.
- iFood e 99Food ficaram **só como conferência** (nenhuma venda).
- Um pagamento "Online iFood" numa ficha presencial ficou **sem pagamento identificado** (conferência), como previsto.
- **Reimportação** do mesmo arquivo devolve a mesma importação.
- **Período declarado errado:** o arquivo de 01–16/11 enviado como "só 17/11" é recusado **antes** da confirmação (`PERIODO_INCORRETO`).
- **Calendário:** os 16 dias aparecem como "Relatório importado" + "Conferência pendente", porque os cartões ainda não foram recebidos. Isso mostra a diferença entre **dia preenchido** e **dia conciliado**.
  - Dia selecionado → "Abrir importações do dia" abre o envio **já com início e fim = o dia**.
  - Dia com relatório da SAIPOS não oferece faturamento provisório.

## 2. Problemas encontrados e corrigidos (`b5d491d`)

| # | Problema | Efeito em produção | Correção |
|---|---|---|---|
| 1 | O parser JSON global de 1 MB do `app.js` roda **antes** do módulo; o limite de 8 MB da rota do Financeiro nunca valia | Relatório acima de ~760 KB (≈1 MB em base64) → **413**. O arquivo real passava por ~35 KB de folga; um mês inteiro falharia | Limite próprio de 8 MB **só** para `/api/v1/financeiro-v2/acoes/importacao/receber`, como os outros importadores. Teste `financeiro-v2-upload-limite.test.js` |
| 2 | Aplicação em lote com custo quadrático: o conflito de granularidade listava todas as vendas aplicadas, com uma busca por venda, a cada proposta | No PostgreSQL, com 825 pedidos reais: 112 s nos primeiros 400 e **288 s** nos 400 seguintes (risco de tempo esgotado no Render) | Sem período próprio, só agregados do período são candidatos (mesma regra) e o provisório é filtrado pela data no banco → **~26 s por 400, estável**. Totais idênticos |
| 3 | A demonstração local aceitava só 8 KB no envio de relatório | Não dava para validar arquivo real na demonstração | 8 MB nessa rota (mesmo teto da plataforma); teste de segurança atualizado com a regra exata |

## 3. Operadoras e taxas
Cobertas pelos testes `operadoras-taxas`, `saipos-vendas-por-periodo` e pelo roteiro de navegador:
- Stone, PagBank (fictícia) e maquininha do iFood: cadastro, ativação, desativação, encerramento e histórico.
- Taxas por modalidade e bandeira; crédito só à vista; Pix por operadora; voucher; tarifa fixa.
- Líquido esperado e percentual efetivo calculados dos totais.
- Taxa ausente aparece como "Taxa não configurada", nunca como zero.
- A estimativa fica fora da DRE; na DRE entra só a taxa cobrada.

**Ponto de decisão (não implementado):** a estimativa é gravada **no momento da venda**.
- Vendas aplicadas antes de a taxa existir ficam "sem taxa" mesmo depois do cadastro. Esta é a regra "não alterar retroativamente".
- Quando o proprietário confirmar a vigência da maquininha do iFood, cadastrar a taxa **antes** de aplicar as importações do período.
- Se for preciso recalcular vendas já aplicadas, isso exige um procedimento explícito, que ainda não existe.

## 4. Importação de 16/11 (sem correção — aguardando autorização)

**Leitura em produção (só leitura, 17/11):**
- As mesmas 145 vendas, o mesmo total e os mesmos canais da importação por forma de pagamento.
- Todos os recebíveis em aberto (nada recebido).
- As entradas em dinheiro, válidas e **não conciliadas**.

As condições do plano do doc 46 §3 continuam valendo. O ensaio completo (`correcao-importacao-forma-dia.test.js`) passa em memória e no PostgreSQL.

**Efeitos esperados** (direção; os valores estão no relatório privado):
- Presencial muda para o total das fichas.
- Anota Aí sobe (a entrega entra no bruto).
- iFood sai da receita até o demonstrativo oficial.
- "Outro" (99Food via SAIPOS) zera.
- Passam a existir deduções a classificar.
- O dia 16/11 entra inteiro.

## 5. Migrações e pacote
- Produção tem **23 migrações (até 0023)**, conferido só por leitura.
- O pacote (`atualizar.sql`) parte da base 0023 e está **em dia**.
- O ensaio `atualizacao-producao.test.js` passou dentro da suíte PostgreSQL. Ele aplica 0024 e 0025 sobre um banco no estado 0023 e confere:
  - nenhum dado alterado;
  - restrição de origem preservada;
  - RLS forçada na tabela nova;
  - repetição recusada.
- **Ordem:** backup → 0024 → 0025 (uma transação, pelo pacote) → código.
- A correção do `app.js` (item 1) **é código da plataforma inteira**, fora do módulo. Ela vai junto no deploy do backend.

## 6. Testes desta validação (todos terminaram)

| Suíte | Total | Passou | Falhou | Pulou |
|---|---:|---:|---:|---:|
| Financeiro v2 backend em memória (+ limite de corpo) | 516 | 516 | 0 | 0 |
| Financeiro v2 backend no PostgreSQL local | 513 | 513 | 0 | 0 |
| Frontend (todos os módulos) | 2018 | 1992 | 0 | 26 (navegador de outros módulos, sem ambiente) |
| Navegador Chrome real (Playwright, `navegadorCanais.mjs`) | 76 | 76 | 0 | 0 |
| Backend geral (todos os módulos) | 6341 | 6286 | 27 | 28 |

**As 27 falhas do backend geral não são do Financeiro nem desta branch:**
- 9 arquivos falham inteiros sem `--experimental-vm-modules`. Rodados com a flag, 8 passam.
- `dashboard-executivo-metas-dinamicas` é intermitente: falha sob carga e passa 2 de 2 sozinho.
- O restante são falhas conhecidas da `main`, registradas antes desta branch:
  - visão e lista de conversas;
  - migrações 088 e 103;
  - "distribuições recompõem mês…";
  - "selecionarPerfil (Fase C…)";
  - `whatsapp-retry-*`, que falham por ambiente (dependências do gateway ausentes no worktree).
- Esta branch não altera esses módulos. **Não foi feita** a comparação lado a lado com a `main` nesta rodada.

## 7. Checklist de publicação (atualiza o doc 46 §4; nada executado)
1. Revisar e mesclar a branch, com autorização. Conferir `node scripts/fv2/pacoteProducao.mjs --conferir`.
2. **Backup:** exportação do schema `financeiro_v2` (estrutura e dados) e anotação dos 23 hashes de `fv2_migracao`. Rodar `inventario.sql` antes.
3. **Migrações:** aplicar `atualizar.sql` (0024 + 0025) numa transação, com o papel do pacote. As pós-condições abortam se algo não conferir. Rodar `inventario.sql` depois e comparar.
4. **Código:** deploy do backend no Render (mesclar na `main` dispara o deploy). `FV2_ESCRITA_HABILITADA` continua desligada.
5. **Testes de leitura pós-publicação**, com o login real:
   - Visão Geral com 4 canais;
   - SAIPOS com resumo, calendário e cards;
   - iFood "Preliminar", com a pendência "receita fora da fonte oficial" mostrando a importação de 16/11;
   - 99Food "Sem relatório oficial";
   - Operadoras e Taxas sem taxas reais;
   - nenhum erro no console.
6. **Login real:** sessão da plataforma → unidade Açaí → menu "Canais de faturamento" visível; ações escondidas com a escrita desligada; outra unidade sem acesso.
7. **Depois, cada passo com autorização própria:**
   - correção de 16/11 (doc 46 §3);
   - taxa da maquininha do iFood com a vigência confirmada;
   - taxas da Stone;
   - religar a escrita.

## 8. Reversão
- **Código:** voltar o deploy anterior no Render. O código antigo ignora as colunas e tabelas novas.
- **Banco:** 0024 e 0025 são aditivas.
  - Se for preciso, `desativar.sql` tira o acesso do módulo sem apagar nada.
  - A tabela `fv2_fechamento_caixa` pode ficar (vazia).
  - As CHECK ampliadas aceitam todos os valores antigos.
- **Dados:** nenhuma escrita acontece nesta publicação. A correção de 16/11 tem roteiro próprio, com estorno e cancelamento auditados, e nada é apagado.

## 9. Classificação
- **Pronto para publicar:** **GO CONDICIONAL**. Depende da autorização de merge e deploy, do backup e da aplicação de `atualizar.sql` com o checklist acima.
- **Pronto para operar integralmente:** **NÃO**. Faltam:
  - a correção de 16/11 (autorização);
  - as taxas reais (Stone; vigência da maquininha do iFood);
  - os relatórios oficiais do iFood (pedidos) e da 99Food;
  - religar a escrita financeira.
