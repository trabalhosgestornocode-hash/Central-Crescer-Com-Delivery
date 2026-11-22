# MOVA — Execução 11: relé de homologação (Supabase) — 21/11/2026

> Implementado e homologado **só no projeto Supabase de homologação** (o mesmo do backend local: URL, banco do Financeiro e banco do MOVA
> conferidos; marca `MOVA_HOMOLOGACAO:<marca>` presente). Produção intocada: Gateway e backend nos mesmos deploys, sem schema `mova`/`mova_rele`.
> Nada ligado no WhatsApp real; variáveis da Fase B **não** cadastradas.

## 1. Arquitetura
```
Gateway Baileys ──HTTPS (contrato atual, HMAC)──► Edge Function mova-rele ──► mova_rele.receber()  ──► mova_rele.evento (fila durável)
                                                     (só forma)                 (HMAC, janela, nonce,         │
                                                                                 limite — ANTES de gravar)    │ reservar (lease)
                                       backend local de homologação ◄─────────────────────────────────────────┘
                                       consumidor (papel mova_rele_consumidor) → reconfere hash + assinatura → receptor MOVA existente
                                       → fila do MOVA → motor/propostas (banco de teste) → confirmar no relé
```
O Gateway não muda: `WHATSAPP_MOVA_BACKEND_URL=https://<ref-homologação>.supabase.co/functions/v1/mova-rele`; ele acrescenta
`/internal/mova/eventos/mova-grupo` e assina esse caminho, exatamente como hoje.

## 2. Contrato da Edge Function (`supabase/functions/mova-rele`)
| Item | Regra |
|---|---|
| Rota | só `POST …/mova-rele/internal/mova/eventos/mova-grupo`, sem query string (outra rota 404, outro método 405) |
| Autenticação | `X-Gateway-Timestamp`, `X-Gateway-Nonce`, `X-Gateway-Signature` (HMAC-SHA256 de `ts\nnonce\nPOST\ncaminho\nsha256(corpo)`); `verify_jwt=false` |
| Tamanho | até 21 MB (mesmo limite do backend), conferido no cabeçalho **e** na leitura; UTF-8 estrito |
| Respostas | 202 `ENFILEIRADO` (gravado) · 200 `DUPLICADO` · 401 genérico (assinatura, segredo, janela, replay) · 429 limite · 400 inválido · 503 banco fora (o Gateway re-tenta) |
| Gravação | resposta **só depois** do commit no banco |
| Logs | só códigos (`rele.resultado`, `rele.banco_indisponivel` + código técnico); nunca corpo, telefone, assinatura ou segredo |
| Banco | `SUPABASE_DB_URL` interna + `SET LOCAL ROLE mova_rele_gravador` em cada transação (o papel só executa `receber`); nenhum segredo cadastrado na função |

## 3. Banco (`database/mova-financeiro/rele/0001_mova_rele.sql`)
- `mova_rele.evento`: `evento_id` (PK = id original do Gateway), `origem`, `corpo` (bytes exatos assinados), `sha256`, `tamanho`, assinatura original
  (`assinatura_ts`, `assinatura_nonce`, `assinatura`, `caminho`), `recebido_em`, `estado` (RECEBIDO/RESERVADO/PROCESSADO/NOVA_TENTATIVA/FALHA_DEFINITIVA),
  `tentativas`, `consumidor`, `lease_ate`, `proxima_em`, `concluido_em`, `falha_codigo`, `entregas`. Índices: disponíveis, reservados, recebido_em.
- `mova_rele.nonce` (replay, expira em 2 min), `mova_rele.segredo` (1 linha, só o dono lê), `mova_rele.auditoria` (ação, evento, ator, código — sem conteúdo).
- Funções `SECURITY DEFINER` com `search_path` fixo: `receber`, `reservar` (`for update skip locked` + lease), `confirmar` (só o dono do lease),
  `devolver` (espera exponencial até 300 s; 8 tentativas ⇒ definitiva), `resumo`, `expurgar` (só o dono).
- Pré-requisito no Supabase: `grant usage on schema extensions to <dono>` (pgcrypto). No PostgreSQL local o pgcrypto vai para `mova_rele_cripto`.

## 4. Autenticação e permissões (verificado no projeto)
RLS ligada em todas as tabelas e **nenhuma política**; nenhum privilégio de tabela para ninguém; `anon`/`authenticated`/`service_role` não usam o
schema nem executam funções; schema fora da Data API. `mova_rele_gravador` só `receber`; `mova_rele_consumidor` só `reservar/confirmar/devolver/resumo`;
login `mova_rele_consumidor_login` (senha gerada localmente, só o verificador SCRAM foi ao banco; limite de 3 conexões). O segredo do canal foi do
arquivo local direto para `mova_rele.segredo` (o log do banco registra só DDL — conferido).

## 5. Duplicidade, ordem e recuperação
- O mesmo `eventoId` entregue de novo ⇒ `DUPLICADO` (contador `entregas`), nunca uma segunda linha. No MOVA, o receptor deduplica de novo (fila por evento).
- Confirmação perdida ⇒ o lease vence, outro ciclo reserva, o receptor responde `DUPLICADO`, confirma. Consumidor antigo não confirma (lease de outro).
- Dois consumidores ⇒ conjuntos disjuntos (`skip locked`). Ordem de chegada não é regra financeira: cada evento é decidido sozinho.
- Computador desligado ⇒ eventos ficam `RECEBIDO`; ao religar, são entregues (teste integrado).

## 6. Suspensão
O consumidor não reserva nada se o recebimento estiver desligado ou o MOVA suspenso (controle em tempo real): os eventos esperam no relé, intactos.
Parar o relé por completo: desligar o backend local (os eventos esperam) ou remover a função; o Gateway trata 5xx/erro de rede com nova tentativa limitada e nunca afeta o fluxo principal.

## 7. Retenção e limpeza segura
`select mova_rele.expurgar(7)` (dono) apaga só PROCESSADO com mais de 7 dias (o conteúdo autenticado já está no MOVA) e nonces vencidos.
Desmontar: `drop schema mova_rele cascade; drop role mova_rele_consumidor_login, mova_rele_consumidor, mova_rele_gravador;` e excluir a função.

## 8. Limites do Supabase
Edge Functions: 256 MB de memória, 2 s de CPU por requisição, 150 s de espera, 20 MB de pacote; invocações incluídas na cota do plano do projeto
existente (sem serviço novo). Volume esperado do piloto: poucas mensagens por dia (limite de 60/min no banco, 30/min no Gateway).

## 9. Testes
- Unitários/integração local (`backend/test/mova-financeiro/rele.test.js`, PostgreSQL isolado, papéis reais): **13/13** — assinatura correta, sem assinatura,
  assinatura/segredo incorretos, timestamp expirado, nonce repetido, payload alterado, duplicado, acima do limite, rota/método, limite de taxa, corpo
  inválido, banco indisponível, consumidor desligado/religado, concorrência, lease expirado/confirmação perdida, falha e definitiva, fora de ordem,
  suspensão, adulteração no banco, leitura por não autorizado e acesso a MOVA/Financeiro pelos papéis do relé.
- Integrado no projeto de homologação (`C:\dev\mova-homologacao\rele-integrado.mjs`): **12 passos aprovados** — gerar, assinar, enviar, persistir,
  consumir, gravar no receptor, reenviar (DUPLICADO), sem duplicação, desligar consumidor, eventos esperando, religar, pendentes processados uma vez.
- Regressão: MOVA 109/109, Financeiro v2 732/732, Gateway 1092/1092.

## 10. Riscos remanescentes
- O backend local continua sendo um computador pessoal: o relé guarda os eventos, mas o processamento só acontece com ele ligado.
- `postgres` é membro de `mova_rele_gravador` (para a função descer de papel): quem tiver a URL interna do projeto de teste tem o mesmo alcance de antes.
- A comparação de assinatura no banco é por hash (não revela prefixos), mas não é uma comparação nativa em tempo constante.
- O conteúdo das mensagens fica no relé até o expurgo (projeto de teste, sem política pública).

## 11. Dependências para a Fase B
1. Autorização para cadastrar no Gateway `WHATSAPP_MOVA_BACKEND_URL` (URL da função), `WHATSAPP_MOVA_BACKEND_SECRET` (= `MOVA_GATEWAY_SECRET`),
   `WHATSAPP_MOVA_HOMOLOGACAO_CONTATO` e `…_CONFIRMACAO` ⇒ **reinício do Gateway** (reconexão).
2. `fase-b-conversa.mjs` para trocar a conversa autorizada (fictícia → contato real) no banco de teste.
3. Backend local ligado com o perfil `fase-b-backend.env` (só recebimento).
4. Observação prévia dos envios automáticos pós-deploy (Execução 10).

## 12. Desenho da Fase D (respostas) — NÃO implementado
O backend local não alcança o Gateway (serviço privado). Proposta simétrica ao relé:
- Tabela `mova_rele.resposta` (id da resposta = idempotência, conversa, texto, estado, lease) gravada pelo backend local (papel consumidor estendido);
- O **Gateway** busca respostas pendentes por uma segunda função (`mova-rele/internal/mova/respostas/pendentes`, assinada com o mesmo segredo),
  envia pelo `enviarGrupoMova` existente (que só aceita o contato verificado) e confirma com o `providerMessageId`;
- Exige mudança no Gateway (um consultor periódico desligado por padrão) — logo, deploy do Gateway e autorização própria.
