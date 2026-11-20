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
