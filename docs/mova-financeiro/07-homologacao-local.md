# MOVA — Execução 07: ambiente de homologação LOCAL (20/11/2026)

Decisão do proprietário: homologar com o backend **rodando localmente**, apontando para um projeto Supabase **de teste já
existente** (dados fictícios confirmados pelo proprietário). Sem Render, sem push, sem custo novo, sem tocar no projeto de produção.

## Criado no projeto de teste (aditivo; nada antigo alterado)
- schema `financeiro_v2` (pacote `instalar.sql`, 27 migrações) e schema `mova` (0001–0004);
- papéis de login próprios (aplicação, autoridade, MOVA) e um papel instalador; senhas geradas localmente — só o hash SCRAM foi ao banco;
- marcador do banco `MOVA_HOMOLOGACAO:<marcador>` (o comentário anterior era o padrão do Supabase);
- organização e 3 unidades fictícias `[MOVA-HML]` (uma com configuração incompleta, como a regra do piloto).

## Isolamento verificado (12/12)
O login do MOVA só lê/escreve `mova` (não lê `public`, `auth`, `financeiro_v2`; não altera orçamento nem apaga auditoria);
os logins do Financeiro não leem `mova`, `public` nem `auth`; o marcador certo é aceito e outro é recusado.

## Ajuste de código
`MOVA_PG_CA` (ou `FV2_PG_CA`): o pool do MOVA aceita a CA do provedor, com verificação de TLS **sempre** ligada
(o pooler do Supabase usa CA própria; sem ela a conexão é recusada — comportamento mantido).

## Backend local
Sobe com as variáveis do arquivo de homologação (fora do repositório), porta própria; efeitos externos bloqueados pela guarda
existente (fora do Render); MOVA desligado; `/internal/mova` inexistente enquanto o recebimento estiver desligado.

## Pendências (dependem do proprietário)
1. Chave service_role do projeto de **teste** e a CA do Supabase no arquivo local (o MCP não fornece; nunca passam pelo chat).
2. Conta de teste no projeto de teste com **TOTP verificado**, vínculo à unidade fictícia ⇒ bootstrap oficial do 1º administrador.
3. Concessão `financeiro_v2.ver` para a identidade de serviço do MOVA nas unidades fictícias e a configuração do contato autorizado.
4. WhatsApp real: o Gateway de produção (Render) **não alcança** um backend local sem um túnel público, e ligar o canal exige
   **reiniciar o Gateway** — ambos precisam de autorização específica. Até lá, o canal é testado com eventos assinados locais.

## Identidade e homologação funcional com eventos simulados (20/11/2026)
- Conta fictícia criada no Auth do projeto de teste, TOTP cadastrado e **verificado** pelo próprio Auth; vínculo à empresa e às 3 unidades fictícias.
- **Bootstrap oficial** (SQL gerado por `sqlBootstrapAdministrador`, executado como `postgres`) ⇒ administração da unidade Centro.
- Pelo fluxo normal, com login real e TOTP: administração corporativa inicial; liberação (Centro e Açaí com escrita, Shopping só consulta);
  identidade de serviço do MOVA com nível CONSULTA nas 3 unidades; plano BASE e contas fictícias na Centro.
- As travas recusaram corretamente: conceder acesso a si mesmo; unidade fora dos escopos do banco financeiro; login do MOVA alterando a configuração.
- Ajuste de ambiente: logins do Financeiro no padrão oficial (`search_path = financeiro_v2, pg_catalog`); sem ele toda sessão cai em "falha fechada".
- Homologação funcional (eventos assinados localmente, IA e envio desligados): **19/20**. Canal (sem assinatura, segredo errado, repetição,
  expiração ⇒ 401), duplicado, conversa/grupo não autorizados, mensagem própria, estado em modo HOMOLOGACAO, orçamento sem chamadas,
  reprocessar, suspensão imediata e retomada, isolamento (sem concessão ⇒ 403 nas outras unidades).

### Achado H-1 (não corrigido; decisão pendente)
Falha de leitura antes de identificar a unidade (ex.: IA desligada) é registrada **sem unidade** e, pelo isolamento, não aparece para nenhum
administrador de unidade (nem em Erros nem no Histórico). Sem vazamento, mas sem visibilidade. Opções: mostrar só a CONTAGEM no estado da
conversa para quem tem `configurar`, ou atribuir a decisão à unidade única quando a conversa tem uma só.

### Pendente
- IA: o ambiente local não tem chave própria da Anthropic (a única existente é a de produção, nunca carregada). Propostas, aprovação e
  aplicação ponta a ponta dependem de uma chave de homologação (ou autorização explícita) — limite já reduzido para 20 chamadas / US$ 1.
- Açaí e Shopping sem administrador financeiro (o bootstrap é de uso único e ninguém concede a si mesmo): exige uma segunda conta fictícia
  administradora para conceder.
- WhatsApp real: túnel + reinício do Gateway (autorização específica).
