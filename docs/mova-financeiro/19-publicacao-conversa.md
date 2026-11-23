# 19 — Publicação da conversa inteligente do MOVA (PR #199): procedimento e achados

Estado em 24/11/2026: PR integrável (main atual mesclada, sem conflitos), testes aprovados. **Nada foi aplicado em produção.**

## 1. Achados que mudam a operação

1. **Texto já passa pelo orçamento.** Em produção o extrator é sempre `clienteComOrcamento(...)` (`fv2-integracao/mova.js`); a flag `MOVA_IA_SOMENTE_DOCUMENTOS` só decide se texto chega ao extrator. O consumo "fora do controle" foi **só o script de validação** (`validacaoConversaReal.mjs`), que fala direto com a Anthropic por desenho (não há banco de produção nele): 3 chamadas, 14.768 tokens de entrada e 1.098 de saída. Se quiser refletir isso no contador interno, é um `insert` em `mova.consumo_ia` (decisão do proprietário; não feito).
2. **O limite que vai morder primeiro é o de CHAMADAS, não o de dólares.** `mova.orcamento_ia.limite_chamadas` tem padrão **200 acumuladas** (todas as chamadas, documentos + texto). Pela tabela de preços do código (Haiku 5.5: US$ 0,10 / 0,50 por milhão), uma pergunta livre custa ≈ **US$ 0,0007** (≈ 4,9 mil tokens de entrada: o esquema estruturado pesa) — o teto de US$ 10 comportaria ~14 mil perguntas, mas as 200 chamadas acabam antes. **Antes de ativar, conferir o consumo atual e decidir se o limite de chamadas sobe** (alteração de custo em produção: precisa de autorização específica). *(Na etapa anterior citei ≈ US$ 0,027/pergunta: era a tabela conservadora do script de validação, US$ 4/20; vale a da conta real da Anthropic.)*
3. **`MOVA_IA_TETO_ENTRADA`** (se configurado) precisa ser ≥ ~5.500 tokens, senão toda pergunta livre é recusada antes de chamar (`IA_TETO_ENTRADA_EXCEDIDA`); a documentação de comprovantes recomenda ≥ 6.000 — conferir no Render.
4. **Ordem de implantação deixou de ser um risco**: além da regra "migração primeiro", o código novo detecta a ausência da coluna `contexto` e grava/lê no formato antigo (sem o período), reavaliando a cada 60 s (teste IM-03). E o **código antigo** continua funcionando depois da migração (a coluna é nula e opcional; teste IM-01).

## 2. O que foi garantido por teste (PostgreSQL isolado)

| Tema | Teste |
|---|---|
| 12 perguntas de **texto** simultâneas com limite de 4 ⇒ a API recebe exatamente 4 | OR-01 |
| Reservas **em voo** nunca passam do limite de custo (2 de US$ 0,10 em US$ 0,25), sem depender de tempo | OR-02 |
| Falha ao contabilizar após a resposta ⇒ a reserva continua como custo (não subestima) | OR-03 |
| Sem resposta da API (timeout) ⇒ reserva inteira vira custo; erro 4xx ⇒ custo 0 | OR-04 |
| Teto **total de US$ 10 é do código** (banco com limite maior não o amplia) | OR-05 |
| Chave da API nunca em log/erro/histórico/resposta; métrica só com código | OR-06 |
| Documento e texto somam no **mesmo** consumo | OR-07 |
| 0017 isolada: código antigo antes e depois; novo falha antes (ordem); registra só a 0017 (não arrasta a 0016); reaplicar aborta; reverter funciona | IM-01 |
| Hash divergente / banco de homologação abortam sem mudar nada | IM-02 |
| Código novo × banco sem 0017 | IM-03 |

## 3. Procedimento de produção (executar só com autorização única; nada disto foi feito)

Pasta de trabalho: `database/mova-financeiro/producao/`. Destino: o banco de produção do MOVA (schema `mova`), como `postgres`.

0. **Pré-checagem (somente leitura):** `inventario.sql` (schema, tabelas, migrações registradas) e
   `select count(*), coalesce(sum(custo_microusd),0) from mova.consumo_ia;` + `select limite_chamadas, limite_custo_microusd, reserva_microusd from mova.orcamento_ia;`. Esperado: migrações 0001–0015 com o sha do Git (o `aplicar-0017.sql` confere sozinho e aborta se divergir), sem 0017.
1. **Backup do schema MOVA:** `pg_dump --schema=mova --format=custom --no-owner -f mova-AAAA-MM-DD-pre0017.dump` + `pg_restore --list` para conferir; guardar em `Documents\backups-producao\` (padrão das publicações anteriores). Anotar o tamanho e a data.
2. **Hashes:** o próprio `aplicar-0017.sql` valida nome + sha256 das 0001–0015 antes de qualquer mudança (uma transação; qualquer falha desfaz tudo).
3. **Aplicar só a 0017:** `psql -v ON_ERROR_STOP=1 -1 -f aplicar-0017.sql` (não é o `atualizar.sql`: este traria também a 0016 de avisos de entregadores). Efeito: `alter table mova.conversa_ativa add column contexto jsonb` (nula) + registro da migração.
4. **Validar o banco:** `select nome, sha256 from mova.mova_migracao where nome like '0017%';` (sha256 = `b4950c5592e7e19a53fa2916e5b368272ea7712d4137799479349ec096eb9b69`) e `select column_name from information_schema.columns where table_schema='mova' and table_name='conversa_ativa';` (contém `contexto`); `inventario.sql` de novo (tabelas inalteradas). Com a versão antiga ainda no ar, conferir que o MOVA segue respondendo (a coluna é opcional).
5. **Merge do PR #199** e deploy do backend (Render, deploy automático do serviço de backend; frontend não muda). Conferir `GET /health` e o log `MOVA` sem erro.
6. **Ativação controlada da IA para texto:** no Render, `MOVA_IA_SOMENTE_DOCUMENTOS=0` (pré-requisitos já ligados: `MOVA_IA_HABILITADA=1`, `ANTHROPIC_API_KEY`). Antes: decidir o item 2 dos achados (limite de chamadas). Manter `mova.controle.ia` ligado; para pausar na hora: desligar `ia` em `mova.controle` (sem reiniciar).
7. **Homologação real no grupo** (uma pessoa da gerência, com o acompanhamento do consumo por `mova.consumo_ia`):
   1. "MOVA, quanto temos para pagar esta semana?" → `CONTAS_VENCENDO` (sem IA) — valores iguais aos do Centro Financeiro.
   2. "E na Subway?" → continua a consulta na unidade da Subway **se** a pessoa tiver a Subway; senão, recusa sem dados.
   3. "Só as vencidas." → `CONTAS_VENCIDAS` (sem IA).
   4. "Quanto pagamos à <fornecedor> no mês passado?" → `PAGAMENTOS_A_FORNECEDOR` (1 chamada de IA); comparar com o Financeiro.
   5. "Por que essa despesa aumentou?" → `COMPARATIVO_DE_DESPESAS` (1 chamada); só fatos.
   6. "Quais entregadores ainda não enviaram nota fiscal?" → `ENTREGADORES_SEM_NOTA`: contagem no grupo; nomes só no privado de quem vê detalhe.
   Verificar em cada uma: valor = Financeiro 2.0; separação Açaí × Subway; ninguém fora da lista recebe resposta; nenhuma escrita (`mova.operacao_executada` inalterada).
8. **Reversão:** (a) imediata: `MOVA_IA_SOMENTE_DOCUMENTOS=1` ou `mova.controle.ia` desligado; (b) código: redeploy do commit anterior (o banco com a coluna `contexto` é compatível); (c) schema: `recuperacao/reverter-0017.sql` (remove só a coluna e o registro; o contexto é efêmero).

## 4. Não alterado nesta etapa
Gateway, envio/recebimento de notas dos entregadores, políticas financeiras, permissões, teto de US$ 10 e o comportamento de "como estão as despesas?" (continua pelo resumo de resultado; só perguntas de **análise** vão à IA).
